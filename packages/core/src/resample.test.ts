import { describe, expect, it } from 'vitest'
import {
  axisPlan,
  idiv,
  identityResample,
  RESAMPLE_MAX_ACCUMULATOR,
  RESAMPLE_Q,
  RESAMPLE_T,
  resampleAreaExact,
  roundDiv,
} from './resample.js'
import { SheetError } from './errors.js'
import type { ResampleSource } from './resample.js'

/**
 * The ten size pairs spec 7.4.1 verifies the filter against. The four it names explicitly —
 * 998 -> 384, 951 -> 384, 4096 -> 64 and 3 -> 2 — lead the list; the rest cover ratio 1, an
 * exact power of two, magnification, a degenerate 1 -> 1 and a coprime pair.
 */
const SIZE_PAIRS: readonly (readonly [number, number])[] = [
  [998, 384],
  [951, 384],
  [4096, 64],
  [3, 2],
  [8, 4],
  [998, 998],
  [64, 64],
  [1, 1],
  [2000, 512],
  [7, 5],
]

const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0)

describe('idiv and roundDiv', () => {
  it('idiv is the exact floor for non-negative numerators', () => {
    expect(idiv(0, 1)).toBe(0)
    expect(idiv(7, 2)).toBe(3)
    expect(idiv(8, 2)).toBe(4)
    expect(idiv(1, 1000)).toBe(0)
  })

  it('roundDiv is round-half-up', () => {
    expect(roundDiv(0, 2)).toBe(0)
    expect(roundDiv(1, 2)).toBe(1)
    expect(roundDiv(3, 2)).toBe(2)
    expect(roundDiv(4, 3)).toBe(1)
    expect(roundDiv(5, 3)).toBe(2)
  })

  it('is exact at the largest magnitudes the filter reaches', () => {
    // The RGB divide at its maximum: Sr = 255 * Sa with Sa at its own maximum, 255 * T.
    const maxSa = 255 * RESAMPLE_T
    expect(roundDiv(255 * maxSa, maxSa)).toBe(255)
    expect(roundDiv(maxSa, RESAMPLE_T)).toBe(255)
  })
})

describe('axisPlan', () => {
  it('quantises every window to exactly Q, with no correction pass', () => {
    for (const [srcLen, dstLen] of SIZE_PAIRS) {
      const plan = axisPlan(srcLen, dstLen)
      expect(plan).toHaveLength(dstLen)
      for (const window of plan) {
        expect(sum(window.weights)).toBe(RESAMPLE_Q)
      }
    }
  })

  it('never produces a negative weight, because cum is non-decreasing', () => {
    for (const [srcLen, dstLen] of SIZE_PAIRS) {
      for (const window of axisPlan(srcLen, dstLen)) {
        for (const q of window.weights) expect(q).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it('never reads past the source, on any pair', () => {
    for (const [srcLen, dstLen] of SIZE_PAIRS) {
      for (const window of axisPlan(srcLen, dstLen)) {
        expect(window.j0).toBeGreaterThanOrEqual(0)
        expect(window.j0 + window.weights.length).toBeLessThanOrEqual(srcLen)
      }
    }
  })

  it("reproduces spec 7.4.1's verified first windows", () => {
    expect(axisPlan(998, 384)[0]).toEqual({ j0: 0, weights: [49, 49, 30] })
    expect(axisPlan(951, 384)[0]).toEqual({ j0: 0, weights: [51, 52, 25] })
  })

  it('makes the exact 2x average fall out as a special case, not a separate path', () => {
    expect(axisPlan(8, 4).map((w) => w.weights)).toEqual([
      [64, 64],
      [64, 64],
      [64, 64],
      [64, 64],
    ])
    expect(axisPlan(8, 4).map((w) => w.j0)).toEqual([0, 2, 4, 6])
  })

  it('is one window of weight 128 per output at ratio 1, which is what makes identity structural', () => {
    for (const len of [64, 384, 998]) {
      const plan = axisPlan(len, len)
      expect(plan).toHaveLength(len)
      plan.forEach((window, i) => {
        expect(window).toEqual({ j0: i, weights: [RESAMPLE_Q] })
      })
    }
  })

  it('handles the odd non-power-of-two reduction the chain-of-halvings definition could not', () => {
    expect(axisPlan(3, 2)).toEqual([
      { j0: 0, weights: [85, 43] },
      { j0: 1, weights: [42, 86] },
    ])
  })

  it('magnifies without a separate path: each output falls inside one source texel', () => {
    expect(axisPlan(2, 4)).toEqual([
      { j0: 0, weights: [128] },
      { j0: 0, weights: [128] },
      { j0: 1, weights: [128] },
      { j0: 1, weights: [128] },
    ])
  })

  it('returns an empty plan for a degenerate axis rather than throwing', () => {
    expect(axisPlan(0, 4)).toEqual([])
    expect(axisPlan(4, 0)).toEqual([])
    expect(axisPlan(-1, 4)).toEqual([])
  })
})

/** A tiny deterministic PRNG, so a corpus test is reproducible without a fixture file. */
function makeRandom(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff
    return state % 256
  }
}

function makeSource(width: number, height: number, seed: number): ResampleSource {
  const random = makeRandom(seed)
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = random()
    data[i * 4 + 1] = random()
    data[i * 4 + 2] = random()
    // Every seventh texel is fully transparent but keeps a non-zero RGB, so the ratio-1 case has
    // to reproduce colour under zero alpha rather than being allowed to invent black.
    data[i * 4 + 3] = i % 7 === 0 ? 0 : random()
  }
  return { data, width, height }
}

function solid(width: number, height: number, rgba: readonly number[]): ResampleSource {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = rgba[0]
    data[i * 4 + 1] = rgba[1]
    data[i * 4 + 2] = rgba[2]
    data[i * 4 + 3] = rgba[3]
  }
  return { data, width, height }
}

function bytes(result: InstanceType<typeof SheetError> | Uint8ClampedArray): Uint8ClampedArray {
  expect(result).not.toBeInstanceOf(SheetError)
  return result as Uint8ClampedArray
}

describe('identityResample', () => {
  it('is a bitwise copy at ratio 1, on every channel including RGB under zero alpha', () => {
    const source = makeSource(64, 48, 1)
    const out = bytes(identityResample(source, { x: 0, y: 0, w: 64, h: 48 }, 64, 48))
    expect(out).toEqual(source.data)
  })

  it('is a bitwise copy at ratio 1 through the general path too, so the short-circuit cannot drift', () => {
    const source = makeSource(64, 48, 2)
    const out = bytes(resampleAreaExact(source, { x: 0, y: 0, w: 64, h: 48 }, 64, 48))
    expect(out).toEqual(source.data)
  })

  it('agrees with the general path on every size pair, which is what CI compares', () => {
    const source = makeSource(96, 72, 3)
    for (const [w, h] of [
      [96, 72],
      [48, 36],
      [32, 24],
      [7, 5],
      [1, 1],
      [192, 144],
    ] as const) {
      const fast = bytes(identityResample(source, { x: 0, y: 0, w: 96, h: 72 }, w, h))
      const general = bytes(resampleAreaExact(source, { x: 0, y: 0, w: 96, h: 72 }, w, h))
      expect(fast).toEqual(general)
    }
  })

  it('copies a sub-rect at ratio 1 without moving a byte off its offset', () => {
    const source = makeSource(64, 48, 4)
    const out = bytes(identityResample(source, { x: 5, y: 7, w: 16, h: 16 }, 16, 16))
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        for (let c = 0; c < 4; c++) {
          expect(out[(y * 16 + x) * 4 + c]).toBe(source.data[((7 + y) * 64 + (5 + x)) * 4 + c])
        }
      }
    }
  })

  it('premultiplies, so a silhouette does not grow a dark fringe', () => {
    // One opaque white texel beside one fully transparent black one. Straight-alpha averaging
    // gives RGB 127 — a 50% dark fringe along the whole silhouette. Alpha-weighted gives white.
    const source: ResampleSource = {
      data: new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 0]),
      width: 2,
      height: 1,
    }
    const out = bytes(resampleAreaExact(source, { x: 0, y: 0, w: 2, h: 1 }, 1, 1))
    expect(Array.from(out)).toEqual([255, 255, 255, 128])
  })

  it('preserves the matte colour of a fully transparent region rather than inventing one', () => {
    const source = solid(4, 1, [12, 34, 56, 0])
    const out = bytes(resampleAreaExact(source, { x: 0, y: 0, w: 4, h: 1 }, 1, 1))
    expect(Array.from(out)).toEqual([12, 34, 56, 0])
  })

  it('reduces to the exact average on an opaque 2x2', () => {
    const source: ResampleSource = {
      data: new Uint8ClampedArray([
        10, 20, 30, 255, 20, 30, 40, 255, 30, 40, 50, 255, 40, 50, 60, 255,
      ]),
      width: 2,
      height: 2,
    }
    const out = bytes(resampleAreaExact(source, { x: 0, y: 0, w: 2, h: 2 }, 1, 1))
    expect(Array.from(out)).toEqual([25, 35, 45, 255])
  })

  it('needs no clamp: the divide can never exceed 255', () => {
    // Spec 7.4.1 step 5, asserted at both maxima rather than guarded at runtime.
    // Sa <= 255*T => A <= 255, and Sr <= 255*Sa => R <= 255.
    expect(roundDiv(255 * RESAMPLE_T, RESAMPLE_T)).toBe(255)
    for (const sa of [1, 2, 128, 16384, 1000003, 255 * RESAMPLE_T]) {
      expect(roundDiv(255 * sa, sa)).toBe(255)
    }
    const source = solid(3, 3, [255, 255, 255, 255])
    const out = bytes(resampleAreaExact(source, { x: 0, y: 0, w: 3, h: 3 }, 1, 1))
    expect(Array.from(out)).toEqual([255, 255, 255, 255])
  })

  it('keeps the worst-case accumulator inside 32 bits with 4x headroom', () => {
    expect(RESAMPLE_MAX_ACCUMULATOR).toBe(1_067_458_560)
    expect(RESAMPLE_MAX_ACCUMULATOR).toBe(255 * 255 * RESAMPLE_T + ((255 * RESAMPLE_T) >> 1))
    expect(RESAMPLE_MAX_ACCUMULATOR * 4).toBeLessThan(2 ** 32)
    expect(RESAMPLE_MAX_ACCUMULATOR).toBeLessThan(Number.MAX_SAFE_INTEGER)
  })

  it('returns a SheetError rather than throwing on a malformed request', () => {
    const source = makeSource(8, 8, 5)
    expect(identityResample(source, { x: 0, y: 0, w: 8, h: 8 }, 0, 4)).toBeInstanceOf(SheetError)
    expect(identityResample(source, { x: 0, y: 0, w: 8, h: 8 }, 4, 1.5)).toBeInstanceOf(SheetError)
    expect(identityResample(source, { x: 4, y: 0, w: 8, h: 8 }, 4, 4)).toBeInstanceOf(SheetError)
    expect(identityResample(source, { x: -1, y: 0, w: 4, h: 4 }, 4, 4)).toBeInstanceOf(SheetError)
    const truncated: ResampleSource = { data: new Uint8ClampedArray(4), width: 8, height: 8 }
    expect(identityResample(truncated, { x: 0, y: 0, w: 8, h: 8 }, 4, 4)).toBeInstanceOf(SheetError)
  })

  it('writes exactly dstW * dstH * 4 bytes', () => {
    const source = makeSource(20, 30, 6)
    const out = bytes(resampleAreaExact(source, { x: 0, y: 0, w: 20, h: 30 }, 7, 11))
    expect(out).toHaveLength(7 * 11 * 4)
  })
})
