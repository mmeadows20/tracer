import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as ts from 'typescript'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { TypeLoadResult } from '../src/typeLoadEngine'
import { flattenMeasurements, formatMeasurement, measureTypeLoad, slowestMeasurements } from '../src/typeLoadEngine'

const coldTypes = `export interface Leaf { value: number }
export interface Branch { left: Leaf, right: Leaf }
export type Tree = Leaf | Branch
export function walk(tree: Tree): number {
  return 'value' in tree ? tree.value : walk(tree.left) + walk(tree.right)
}
`

const hotTypes = `export type Json = string | number | boolean | null | Json[] | { [key: string]: Json }
export interface Recursive<T> { value: T, children: Recursive<T>[] }
export type Deep<T> = { [K in keyof T]: Deep<T[K]> }
export const values: Json[] = []
`

let projectDir: string
let coldFile: string
let hotFile: string
let result: TypeLoadResult

function writeProject() {
  projectDir = mkdtempSync(join(tmpdir(), 'typeLoad-'))
  mkdirSync(join(projectDir, 'src'))

  writeFileSync(join(projectDir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'esnext',
      module: 'esnext',
      moduleResolution: 'node',
      strict: true,
      types: [],
    },
    include: ['src'],
  }))

  coldFile = join(projectDir, 'src', 'cold.ts')
  hotFile = join(projectDir, 'src', 'hot.ts')
  writeFileSync(coldFile, coldTypes)
  writeFileSync(hotFile, hotTypes)
}

beforeAll(() => {
  writeProject()
  result = measureTypeLoad(ts, { tsconfigPath: join(projectDir, 'tsconfig.json') })
})

afterAll(() => {
  rmSync(projectDir, { recursive: true, force: true })
})

describe('measureTypeLoad', () => {
  it('reports the version of the TypeScript it measured with', () => {
    expect(result.typescriptVersion).toEqual(ts.version)
  })

  it('measures every top-level declaration in the project', () => {
    expect(result.files.map(file => file.fileName).sort()).toEqual([coldFile, hotFile].sort())
    expect(result.declarationCount).toEqual(8)

    const names = flattenMeasurements(result).map(measurement => measurement.name).sort()
    expect(names).toEqual(['Branch', 'Deep', 'Json', 'Leaf', 'Recursive', 'Tree', 'values', 'walk'])
  })

  it('records a first-touch measurement with positions inside the source', () => {
    for (const measurement of flattenMeasurements(result)) {
      expect(measurement.firstTouchMs).toBeGreaterThanOrEqual(0)
      expect(Number.isFinite(measurement.firstTouchMs)).toBe(true)
      expect(measurement.instantiations).toBeGreaterThanOrEqual(0)
      expect(measurement.typesCreated).toBeGreaterThanOrEqual(0)
      expect(measurement.end).toBeGreaterThan(measurement.pos)
      expect(measurement.kind).not.toEqual('')
    }
  })

  it('points each measurement at the declaration text', () => {
    const source = readSource()
    const measurements = flattenMeasurements(result)
    for (const measurement of measurements)
      expect(source.get(measurement.fileName)!.slice(measurement.pos, measurement.end)).toEqual(measurement.name)
  })

  it('labels variables and declarations with a friendly kind', () => {
    const byName = new Map(flattenMeasurements(result).map(measurement => [measurement.name, measurement.kind]))
    expect(byName.get('Leaf')).toEqual('Interface')
    expect(byName.get('Tree')).toEqual('TypeAlias')
    expect(byName.get('walk')).toEqual('Function')
    expect(byName.get('values')).toEqual('Variable')
  })

  it('attributes instantiations and created types to the recursive alias', () => {
    const recursive = flattenMeasurements(result).find(measurement => measurement.name === 'Recursive')
    expect(recursive).toBeDefined()
    expect(recursive!.instantiations + recursive!.typesCreated).toBeGreaterThan(0)
  })
})

describe('measureTypeLoad includeFiles', () => {
  it('restricts measurements to the requested files', () => {
    const filtered = measureTypeLoad(ts, {
      tsconfigPath: join(projectDir, 'tsconfig.json'),
      includeFiles: [hotFile],
    })

    expect(filtered.files.map(file => file.fileName)).toEqual([hotFile])
    expect(filtered.declarationCount).toEqual(4)
  })
})

describe('leaderboard helpers', () => {
  it('orders measurements by first-touch time, slowest first', () => {
    const slowest = slowestMeasurements(result, 3)
    expect(slowest).toHaveLength(3)
    expect(slowest[0].firstTouchMs).toBeGreaterThanOrEqual(slowest[1].firstTouchMs)
    expect(slowest[1].firstTouchMs).toBeGreaterThanOrEqual(slowest[2].firstTouchMs)
  })

  it('formats a measurement like the CodeLens title', () => {
    const measurement = { firstTouchMs: 6.84, instantiations: 161, typesCreated: 130 }
    expect(formatMeasurement(measurement as never)).toEqual('⚡ 6.8 ms · 161 inst · 130 types')
  })
})

function readSource() {
  return new Map([
    [coldFile, coldTypes],
    [hotFile, hotTypes],
  ])
}
