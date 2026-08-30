import { describe, expect, it } from 'vitest'
import { axisPlan, idiv, RESAMPLE_Q, RESAMPLE_T, roundDiv } from './resample.js'

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
