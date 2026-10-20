import { resolve } from 'node:path'
import * as vscode from 'vscode'
import type { TS, TypeLoadFileResult, TypeLoadMeasurement, TypeLoadResult } from './typeLoadEngine'
import { formatMeasurement, formatMs, measureTypeLoad, slowestMeasurements } from './typeLoadEngine'
import { getCurrentConfig } from './configuration'
import { getTsPath } from './tsUtil'
import { getTsconfigFile } from './shared'
import { log } from './logger'
import { state } from './appState'

export const measureTypeLoadCommand = 'tsperf.tracer.measureTypeLoad'
export const measureTypeLoadAtCursorCommand = 'tsperf.tracer.measureTypeLoadAtCursor'
export const showTypeLoadLeaderboardCommand = 'tsperf.tracer.showTypeLoadLeaderboard'

const lensEmitter = new vscode.EventEmitter<void>()

/** Measurements per absolute file name, replaced wholesale by each workspace run. */
const fileResults = new Map<string, TypeLoadFileResult>()

let lastResult: TypeLoadResult | undefined

export function initTypeLoad(context: vscode.ExtensionContext): void {
  context.subscriptions.push(lensEmitter)

  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      [{ language: 'typescript', scheme: 'file' }, { language: 'typescriptreact', scheme: 'file' }],
      { onDidChangeCodeLenses: lensEmitter.event, provideCodeLenses },
    ),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand(measureTypeLoadCommand, () => measureTypeLoadWorkspace()),
    vscode.commands.registerCommand(measureTypeLoadAtCursorCommand, (...args: unknown[]) => measureTypeLoadAtCursor(args)),
    vscode.commands.registerCommand(showTypeLoadLeaderboardCommand, () => showTypeLoadLeaderboard(context)),
  )

  // Results describe a snapshot of the program, so drop them as soon as the
  // source they were measured from changes.
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (fileResults.delete(resolve(event.document.fileName)))
        lensEmitter.fire()
    }),
  )
}

/**
 * Measures the whole project described by the closest `tsconfig.json` and
 * republishes the CodeLens values. Runs synchronously inside the extension host
 * because the TypeScript compiler is re-entrant only within a single process.
 */
export async function measureTypeLoadWorkspace(): Promise<void> {
  const config = getCurrentConfig()
  if (!config.enableTypeLoad) {
    void vscode.window.showInformationMessage('TypeLoad is disabled. Enable "tsperf.tracer.enableTypeLoad" to measure type load.')
    return
  }

  const anchor = vscode.window.activeTextEditor?.document.uri.fsPath ?? state.workspacePath.value
  if (!anchor) {
    void vscode.window.showWarningMessage('No workspace or folder open')
    return
  }

  const tsconfigFile = await getTsconfigFile(anchor)
  if (!tsconfigFile) {
    void vscode.window.showWarningMessage('TypeLoad: no tsconfig.json found in this workspace')
    return
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'TypeLoad: measuring type load' },
    async () => {
      try {
        const result = measureTypeLoad(loadTs(), {
          tsconfigPath: tsconfigFile.fsPath,
          warmupPasses: config.typeLoadWarmupPasses,
        })
        applyResult(result)
        void vscode.window.showInformationMessage(
          `TypeLoad: ${result.declarationCount} declarations across ${result.files.length} files, ${formatMs(result.totalMs)} of first-touch time (TypeScript ${result.typescriptVersion})`,
        )
      }
      catch (error) {
        reportFailure(error)
      }
    },
  )
}

/**
 * Re-measures a single declaration in a fresh program. Passing the document and
 * offset from a CodeLens command re-measures that lens, while running it from
 * the palette re-measures the declaration under the cursor.
 */
export async function measureTypeLoadAtCursor(args: readonly unknown[] = []): Promise<void> {
  const uri = args[0] instanceof vscode.Uri ? args[0] : vscode.window.activeTextEditor?.document.uri
  if (!uri || uri.scheme !== 'file') {
    void vscode.window.showWarningMessage('TypeLoad: open a TypeScript file first')
    return
  }

  const document = vscode.workspace.textDocuments.find(doc => doc.uri.fsPath === uri.fsPath)
    ?? await vscode.workspace.openTextDocument(uri)
  const editor = vscode.window.activeTextEditor
  const pos = typeof args[1] === 'number'
    ? args[1]
    : editor && editor.document.uri.fsPath === uri.fsPath
      ? document.offsetAt(editor.selection.active)
      : -1

  const tsconfigFile = await getTsconfigFile(uri.fsPath)
  if (!tsconfigFile) {
    void vscode.window.showWarningMessage('TypeLoad: no tsconfig.json found in this workspace')
    return
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'TypeLoad: re-measuring declaration' },
    async () => {
      try {
        const result = measureTypeLoad(loadTs(), {
          tsconfigPath: tsconfigFile.fsPath,
          includeFiles: [uri.fsPath],
          warmupPasses: getCurrentConfig().typeLoadWarmupPasses,
        })

        const measurements = result.files.find(file => resolve(file.fileName) === resolve(uri.fsPath))?.measurements ?? []
        const target = findMeasurement(measurements, pos)
        if (!target) {
          void vscode.window.showInformationMessage('TypeLoad: no declaration found at this position')
          return
        }

        mergeMeasurements(uri.fsPath, [target])
        lensEmitter.fire()
        void vscode.window.showInformationMessage(`TypeLoad: ${target.name} ${formatMeasurement(target)}`)
      }
      catch (error) {
        reportFailure(error)
      }
    },
  )
}

export function showTypeLoadLeaderboard(context: vscode.ExtensionContext): void {
  if (!lastResult || !lastResult.declarationCount) {
    void vscode.window.showInformationMessage('TypeLoad: run "Tracer: Measure type load" first.')
    return
  }

  const panel = vscode.window.createWebviewPanel(
    'tsperfTypeLoadLeaderboard',
    'TypeLoad - slowest types',
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true },
  )
  context.subscriptions.push(panel)

  panel.webview.html = renderLeaderboard(lastResult, getCurrentConfig().typeLoadLeaderboardSize)
  panel.webview.onDidReceiveMessage((message: unknown) => {
    if (isGotoMessage(message))
      void revealLocation(message.fileName, message.pos)
  })
}

function provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
  if (!getCurrentConfig().enableTypeLoad)
    return []

  const result = fileResults.get(resolve(document.uri.fsPath))
  if (!result)
    return []

  return result.measurements.map((measurement) => {
    const position = new vscode.Position(measurement.line, measurement.character)
    return new vscode.CodeLens(new vscode.Range(position, position), {
      title: formatMeasurement(measurement),
      tooltip: `${measurement.kind} ${measurement.name} - first getTypeAtLocation in a fresh program`,
      command: measureTypeLoadAtCursorCommand,
      arguments: [document.uri, measurement.pos],
    })
  })
}

function applyResult(result: TypeLoadResult): void {
  lastResult = result
  fileResults.clear()
  for (const file of result.files)
    fileResults.set(resolve(file.fileName), file)

  lensEmitter.fire()
}

function mergeMeasurements(fileName: string, measurements: TypeLoadMeasurement[]): void {
  const key = resolve(fileName)
  const existing = fileResults.get(key)
  const byPos = new Map((existing?.measurements ?? []).map(measurement => [measurement.pos, measurement]))
  for (const measurement of measurements)
    byPos.set(measurement.pos, measurement)

  const merged = [...byPos.values()].sort((a, b) => a.pos - b.pos)
  fileResults.set(key, {
    fileName: key,
    measurements: merged,
    totalMs: merged.reduce((sum, measurement) => sum + measurement.firstTouchMs, 0),
    totalInstantiations: merged.reduce((sum, measurement) => sum + measurement.instantiations, 0),
    totalTypes: merged.reduce((sum, measurement) => sum + measurement.typesCreated, 0),
  })
}

function findMeasurement(measurements: TypeLoadMeasurement[], pos: number): TypeLoadMeasurement | undefined {
  if (!measurements.length)
    return undefined

  const containing = measurements.find(measurement => pos >= measurement.pos && pos <= measurement.end)
  if (containing || pos < 0)
    return containing

  return measurements.reduce((closest, measurement) =>
    Math.abs(measurement.pos - pos) < Math.abs(closest.pos - pos) ? measurement : closest,
  )
}

function loadTs(): TS {
  // eslint-disable-next-line ts/no-require-imports
  return require(getTsPath()) as TS
}

function reportFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : `${error}`
  log(`TypeLoad failed: ${message}`)
  void vscode.window.showErrorMessage(`TypeLoad failed: ${message}`)
}

interface GotoMessage {
  type: 'goto'
  fileName: string
  pos: number
}

function isGotoMessage(message: unknown): message is GotoMessage {
  return !!message && typeof message === 'object'
    && (message as GotoMessage).type === 'goto'
    && typeof (message as GotoMessage).fileName === 'string'
    && typeof (message as GotoMessage).pos === 'number'
}

async function revealLocation(fileName: string, pos: number): Promise<void> {
  const uri = vscode.Uri.file(fileName)
  const document = vscode.workspace.textDocuments.find(doc => resolve(doc.uri.fsPath) === resolve(fileName))
    ?? await vscode.workspace.openTextDocument(uri)
  const position = document.positionAt(pos)

  const editor = await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, preserveFocus: false })
  editor.selection = new vscode.Selection(position, position)
  editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter)
}

function renderLeaderboard(result: TypeLoadResult, limit: number): string {
  const rows = slowestMeasurements(result, limit).map((measurement, index) => `<tr>
        <td class="num rank">${index + 1}</td>
        <td><button data-file="${escapeHtml(measurement.fileName)}" data-pos="${measurement.pos}">${escapeHtml(measurement.name)}</button></td>
        <td class="kind">${escapeHtml(measurement.kind)}</td>
        <td class="path">${escapeHtml(vscode.workspace.asRelativePath(measurement.fileName, false))}</td>
        <td class="num">${escapeHtml(formatMs(measurement.firstTouchMs))}</td>
        <td class="num">${measurement.instantiations}</td>
        <td class="num">${measurement.typesCreated}</td>
      </tr>`).join('\n')

  const fileRows = [...result.files].sort((a, b) => b.totalMs - a.totalMs).map(file => `<tr>
        <td class="path">${escapeHtml(vscode.workspace.asRelativePath(file.fileName, false))}</td>
        <td class="num">${file.measurements.length}</td>
        <td class="num">${escapeHtml(formatMs(file.totalMs))}</td>
        <td class="num">${file.totalInstantiations}</td>
        <td class="num">${file.totalTypes}</td>
      </tr>`).join('\n')

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
  <title>TypeLoad</title>
  <style>
    body { font-family: var(--vscode-font-family); padding: 0 1rem 2rem; }
    h2 { margin-top: 2rem; }
    p.meta { opacity: 0.8; }
    table { border-collapse: collapse; width: 100%; }
    th, td { text-align: left; padding: 0.25rem 0.5rem; border-bottom: 1px solid var(--vscode-panel-border); }
    td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
    td.kind { opacity: 0.8; }
    td.path { opacity: 0.7; font-size: 0.9em; }
    button { background: none; border: none; color: var(--vscode-textLink-foreground); cursor: pointer; font: inherit; padding: 0; }
    button:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <h1>TypeLoad - slowest types</h1>
  <p class="meta">${result.declarationCount} declarations across ${result.files.length} files &middot; ${escapeHtml(formatMs(result.totalMs))} first-touch total &middot; TypeScript ${escapeHtml(result.typescriptVersion)}</p>
  <table>
    <thead>
      <tr>
        <th class="num">#</th><th>Declaration</th><th>Kind</th><th>File</th>
        <th class="num">First touch</th><th class="num">Instantiations</th><th class="num">Types</th>
      </tr>
    </thead>
    <tbody>
${rows}
    </tbody>
  </table>
  <h2>Per file</h2>
  <table>
    <thead>
      <tr>
        <th>File</th><th class="num">Declarations</th><th class="num">First touch</th>
        <th class="num">Instantiations</th><th class="num">Types</th>
      </tr>
    </thead>
    <tbody>
${fileRows}
    </tbody>
  </table>
  <script>
    const vscode = acquireVsCodeApi()
    document.querySelectorAll('button[data-file]').forEach((button) => {
      button.addEventListener('click', () => vscode.postMessage({
        type: 'goto',
        fileName: button.dataset.file,
        pos: Number(button.dataset.pos),
      }))
    })
  </script>
</body>
</html>`
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`)
}
