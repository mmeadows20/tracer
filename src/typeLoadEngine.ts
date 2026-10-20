import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import type {
  Node,
  ParseConfigFileHost,
  ParsedCommandLine,
  Program,
  SourceFile,
  TypeChecker,
} from 'typescript'

/**
 * The TypeScript module used to take measurements. It is injected instead of
 * imported so that the engine can run against the project's own TypeScript
 * (`src/tsUtil.ts`) or a standalone copy in tests.
 */
export type TS = typeof import('typescript')

export interface TypeLoadOptions {
  /** Absolute path to the `tsconfig.json` describing the project to measure. */
  tsconfigPath: string
  /** Restrict measurements to these files (absolute paths). Defaults to every project source file. */
  includeFiles?: readonly string[]
  /**
   * Number of throw-away measurement passes run before the reported one.
   * A single cold pass is the default because the first-touch cost is the
   * number we want to report.
   */
  warmupPasses?: number
}

export interface TypeLoadMeasurement {
  /** Absolute file name the declaration lives in. */
  fileName: string
  /** Declaration name as written in the source, e.g. `Foo`. */
  name: string
  /** Friendly declaration kind, e.g. `Interface`. */
  kind: string
  /** Zero-based line of the declaration name. */
  line: number
  /** Zero-based character offset of the declaration name within `line`. */
  character: number
  /** Absolute character offset of the declaration name. */
  pos: number
  /** End offset of the declaration name. */
  end: number
  /** Wall-clock time of the first `getTypeAtLocation` for this declaration, in milliseconds. */
  firstTouchMs: number
  /** Checker instantiations attributed to the first touch (`getInstantiationCount` delta). */
  instantiations: number
  /** Types created during the first touch (`getTypeCount` delta). */
  typesCreated: number
}

export interface TypeLoadFileResult {
  fileName: string
  measurements: TypeLoadMeasurement[]
  totalMs: number
  totalInstantiations: number
  totalTypes: number
}

export interface TypeLoadResult {
  files: TypeLoadFileResult[]
  totalMs: number
  declarationCount: number
  /** The version of TypeScript the measurements were taken with. */
  typescriptVersion: string
}

interface DeclarationRef {
  name: string
  kind: string
  node: Node
}

/**
 * Measures the cost of the first type resolution of every top-level declaration
 * in a project, using a fresh `ts.Program` so the numbers match a cold
 * file-open / build.
 *
 * For each declaration the engine takes the wall-clock time of the first
 * `checker.getTypeAtLocation` call plus the `getInstantiationCount` /
 * `getTypeCount` deltas that call produced - the same instrumentation technique
 * used by `@definitelytyped/perf`.
 */
export function measureTypeLoad(ts: TS, options: TypeLoadOptions): TypeLoadResult {
  const commandLine = parseCommandLine(ts, options.tsconfigPath)
  const includeSet = options.includeFiles
    ? new Set(options.includeFiles.map(file => resolve(file)))
    : undefined
  const warmupPasses = Math.max(0, Math.floor(options.warmupPasses ?? 0))

  let result: Omit<TypeLoadResult, 'typescriptVersion'> | undefined
  for (let pass = 0; pass <= warmupPasses; pass++) {
    const program = ts.createProgram({
      rootNames: commandLine.fileNames,
      options: commandLine.options,
      projectReferences: commandLine.projectReferences,
    })
    const measured = measureProgram(ts, program, program.getSourceFiles(), includeSet)
    if (pass === warmupPasses)
      result = measured
  }

  return { ...result!, typescriptVersion: ts.version }
}

function measureProgram(
  ts: TS,
  program: Program,
  sourceFiles: readonly SourceFile[],
  includeSet: Set<string> | undefined,
): Omit<TypeLoadResult, 'typescriptVersion'> {
  const checker = program.getTypeChecker()
  const files: TypeLoadFileResult[] = []
  let totalMs = 0
  let declarationCount = 0

  for (const sourceFile of sourceFiles) {
    if (sourceFile.isDeclarationFile)
      continue

    const fileName = resolve(sourceFile.fileName)
    const isIncluded = includeSet?.has(fileName) ?? !fileName.includes('/node_modules/')
    if (!isIncluded)
      continue

    const measurements: TypeLoadMeasurement[] = []
    for (const declaration of collectDeclarations(ts, sourceFile)) {
      const measurement = measureDeclaration(checker, program, sourceFile, declaration, fileName)
      if (measurement)
        measurements.push(measurement)
    }

    if (!measurements.length)
      continue

    const fileTotalMs = measurements.reduce((sum, measurement) => sum + measurement.firstTouchMs, 0)
    files.push({
      fileName,
      measurements,
      totalMs: fileTotalMs,
      totalInstantiations: measurements.reduce((sum, measurement) => sum + measurement.instantiations, 0),
      totalTypes: measurements.reduce((sum, measurement) => sum + measurement.typesCreated, 0),
    })
    totalMs += fileTotalMs
    declarationCount += measurements.length
  }

  return { files, totalMs, declarationCount }
}

function measureDeclaration(
  checker: TypeChecker,
  program: Program,
  sourceFile: SourceFile,
  declaration: DeclarationRef,
  fileName: string,
): TypeLoadMeasurement | undefined {
  const pos = declaration.node.getStart(sourceFile)
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(pos)

  const instantiationsBefore = getInstantiationCount(program)
  const typesBefore = getTypeCount(program)

  const start = performance.now()
  try {
    checker.getTypeAtLocation(declaration.node)
  }
  catch {
    // A declaration the checker cannot resolve is not worth reporting.
    return undefined
  }
  const firstTouchMs = performance.now() - start

  return {
    fileName,
    name: declaration.name,
    kind: declaration.kind,
    line,
    character,
    pos,
    end: declaration.node.getEnd(),
    firstTouchMs,
    instantiations: getInstantiationCount(program) - instantiationsBefore,
    typesCreated: getTypeCount(program) - typesBefore,
  }
}

function collectDeclarations(ts: TS, sourceFile: SourceFile): DeclarationRef[] {
  const declarations: DeclarationRef[] = []
  ts.forEachChild(sourceFile, (node) => {
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations)
        declarations.push(toDeclarationRef(sourceFile, declaration.name, 'Variable'))

      return
    }

    const name = (node as { name?: Node }).name
    if (name)
      declarations.push(toDeclarationRef(sourceFile, name, kindLabel(ts, node.kind)))
  })
  return declarations
}

function toDeclarationRef(sourceFile: SourceFile, name: Node, kind: string): DeclarationRef {
  return { name: name.getText(sourceFile), kind, node: name }
}

function kindLabel(ts: TS, kind: Node['kind']): string {
  const label = ts.SyntaxKind[kind] ?? 'Declaration'
  return label.replace(/Declaration$/, '')
}

function getInstantiationCount(program: Program): number {
  return typeof program.getInstantiationCount === 'function' ? program.getInstantiationCount() : 0
}

function getTypeCount(program: Program): number {
  return typeof program.getTypeCount === 'function' ? program.getTypeCount() : 0
}

function parseCommandLine(ts: TS, tsconfigPath: string): ParsedCommandLine {
  const host: ParseConfigFileHost = {
    fileExists: ts.sys.fileExists,
    getCurrentDirectory: ts.sys.getCurrentDirectory,
    readDirectory: ts.sys.readDirectory,
    readFile: ts.sys.readFile,
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
    },
  }

  const commandLine = ts.getParsedCommandLineOfConfigFile(tsconfigPath, {}, host)
  if (!commandLine)
    throw new Error(`could not parse ${tsconfigPath}`)

  return commandLine
}

/** Every measurement in the result, flattened in program order. */
export function flattenMeasurements(result: TypeLoadResult): TypeLoadMeasurement[] {
  return result.files.flatMap(file => file.measurements)
}

/** Measurements ordered by first-touch cost, slowest first. */
export function slowestMeasurements(result: TypeLoadResult, limit = Number.POSITIVE_INFINITY): TypeLoadMeasurement[] {
  return flattenMeasurements(result)
    .sort((a, b) => b.firstTouchMs - a.firstTouchMs || b.instantiations - a.instantiations)
    .slice(0, limit)
}

/** `⚡ 6.8 ms · 161 inst · 130 types` - the CodeLens title. */
export function formatMeasurement(measurement: TypeLoadMeasurement): string {
  return `⚡ ${formatMs(measurement.firstTouchMs)} · ${measurement.instantiations} inst · ${measurement.typesCreated} types`
}

export function formatMs(ms: number): string {
  if (!Number.isFinite(ms))
    return 'n/a'

  return `${ms >= 10 ? Math.round(ms) : Math.round(ms * 10) / 10} ms`
}
