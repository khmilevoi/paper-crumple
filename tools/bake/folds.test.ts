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

  it('is the exact table the spike vendored: all 18 entries pinned in full', () => {
    expect(table).toEqual({
      '2x3': [
        {
          angle: 50.202259,
          depth: 0.492413,
          nx: 0.640079,
          ny: 0.768309,
          c: 0.391557,
        },
        {
          angle: 198.467876,
          depth: 0.619745,
          nx: -0.948501,
          ny: -0.316773,
          c: 0.268682,
        },
        {
          angle: 316.469623,
          depth: 0.6288,
          nx: 0.725009,
          ny: -0.688739,
          c: 0.328088,
        },
        {
          angle: 91.373672,
          depth: 0.687403,
          nx: -0.023973,
          ny: 0.999713,
          c: 0.26348,
        },
        {
          angle: 242.758289,
          depth: 0.73701,
          nx: -0.457745,
          ny: -0.889083,
          c: 0.289063,
        },
        {
          angle: 22.870425,
          depth: 0.761946,
          nx: 0.921386,
          ny: 0.388648,
          c: 0.233997,
        },
      ],
      '1x1': [
        {
          angle: 50.202259,
          depth: 0.492413,
          nx: 0.640079,
          ny: 0.768309,
          c: 0.461466,
        },
        {
          angle: 198.467876,
          depth: 0.619745,
          nx: -0.948501,
          ny: -0.316773,
          c: 0.358185,
        },
        {
          angle: 316.469623,
          depth: 0.6288,
          nx: 0.725009,
          ny: -0.688739,
          c: 0.395736,
        },
        {
          angle: 91.373672,
          depth: 0.687403,
          nx: -0.023973,
          ny: 0.999713,
          c: 0.265553,
        },
        {
          angle: 242.758289,
          depth: 0.73701,
          nx: -0.457745,
          ny: -0.889083,
          c: 0.325995,
        },
        {
          angle: 22.870425,
          depth: 0.761946,
          nx: 0.921386,
          ny: 0.388648,
          c: 0.305656,
        },
      ],
      '3x2': [
        {
          angle: 50.202259,
          depth: 0.492413,
          nx: 0.640079,
          ny: 0.768309,
          c: 0.566329,
        },
        {
          angle: 198.467876,
          depth: 0.619745,
          nx: -0.948501,
          ny: -0.316773,
          c: 0.492441,
        },
        {
          angle: 316.469623,
          depth: 0.6288,
          nx: 0.725009,
          ny: -0.688739,
          c: 0.497209,
        },
        {
          angle: 91.373672,
          depth: 0.687403,
          nx: -0.023973,
          ny: 0.999713,
          c: 0.268663,
        },
        {
          angle: 242.758289,
          depth: 0.73701,
          nx: -0.457745,
          ny: -0.889083,
          c: 0.381393,
        },
        {
          angle: 22.870425,
          depth: 0.761946,
          nx: 0.921386,
          ny: 0.388648,
          c: 0.413144,
        },
      ],
    })
  })
})
