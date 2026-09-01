/**
 * `folds.json` is a frozen vendored input (spec 13): `crumple.py` reads it, `foldTable.mjs`
 * produced it from the 2D spike, and nothing in this repository can regenerate it. Its numbers
 * are pinned here so a stray edit — or a Prettier re-indent that also changed a digit — fails
 * loudly instead of changing where the sheet folds.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

interface Fold {
  angle: number
  depth: number
  nx: number
  ny: number
  c: number
}

const table = JSON.parse(
  readFileSync(fileURLToPath(new URL('./folds.json', import.meta.url)), 'utf8'),
) as Record<string, Fold[]>

describe('the frozen fold table', () => {
  it('carries the three aspect buckets and nothing else', () => {
    expect(Object.keys(table)).toEqual(['2x3', '1x1', '3x2'])
  })

  it('carries six flaps per bucket, the count crumple.py folds', () => {
    for (const [bucket, folds] of Object.entries(table)) {
      expect(folds, bucket).toHaveLength(6)
    }
  })

  it('states every line as a unit normal, so nx*x + ny*y = c is a real distance', () => {
    for (const [bucket, folds] of Object.entries(table)) {
      for (const fold of folds) {
        const length = Math.sqrt(fold.nx * fold.nx + fold.ny * fold.ny)
        expect(Math.abs(length - 1), `${bucket} angle ${fold.angle}`).toBeLessThan(1e-5)
        expect(
          Number.isFinite(fold.angle) && Number.isFinite(fold.depth) && Number.isFinite(fold.c),
        ).toBe(true)
      }
    }
  })

  it('is the exact table the spike vendored: the first flap, and one deep one', () => {
    expect(table['2x3']![0]).toEqual({
      angle: 50.202259,
      depth: 0.492413,
      nx: 0.640079,
      ny: 0.768309,
      c: 0.391557,
    })
    expect(table['1x1']![0]!.c).toBe(0.461466)
    expect(table['3x2']![0]!.c).toBe(0.566329)
    expect(table['1x1']![5]).toEqual({
      angle: 22.870425,
      depth: 0.761946,
      nx: 0.921386,
      ny: 0.388648,
      c: 0.305656,
    })
  })
})
