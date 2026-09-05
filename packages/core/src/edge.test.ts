import { describe, expect, it } from 'vitest'
import { KnobError } from './errors.js'
import { percentWidthReserve } from './edge.js'
import { overscanFromRadius } from './overscan.js'

// R14: mirrors the local `number` unwrap helper at `overscan.test.ts:31` — a new file, same
// pattern rather than a fresh import surface for one assertion.
const number = (v: InstanceType<typeof KnobError> | number): number => {
  expect(v).not.toBeInstanceOf(KnobError)
  return v as number
}

describe('percentWidthReserve (design 2026-09-05 §4.3)', () => {
  it('reproduces the design check at v = 0, F = 0', () => {
    const r = percentWidthReserve({
      pct: 0.05,
      aspect: 1,
      variance: 0,
      finishTerms: 0,
      headroom: 0.25,
    })
    expect(r.radius).toBeCloseTo(66.889, 3)
    expect(r.widthRef).toBeCloseTo(41.511, 3)
    // R14: overscanFromRadius returns KnobError | number — wrap it before toBeCloseTo.
    expect(number(overscanFromRadius(r.radius))).toBeCloseTo(0.07722, 5)
  })

  it('is self-consistent: R === (1 + eta)((1 + v) W + F + e)', () => {
    for (const pct of [0, 0.01, 0.05, 0.09, 0.15]) {
      for (const c of [1, 0.75, 0.5, 0.25]) {
        for (const [v, F] of [
          [0, 0],
          [0.53, 0],
          [0.53, 23],
          [1, 40],
        ]) {
          for (const eta of [0, 0.25, 1]) {
            const r = percentWidthReserve({
              pct,
              aspect: c,
              variance: v,
              finishTerms: F,
              headroom: eta,
            })
            expect(r.radius).toBeCloseTo((1 + eta) * ((1 + v) * r.widthRef + F + 12), 9)
          }
        }
      }
    }
  })

  it('is monotone in the aspect, so R(c = 1) is a ceiling', () => {
    let previous = -Infinity
    for (const c of [0.1, 0.25, 0.5, 0.75, 1]) {
      const r = percentWidthReserve({
        pct: 0.059,
        aspect: c,
        variance: 0.53,
        finishTerms: 23,
        headroom: 0.25,
      })
      expect(r.radius).toBeGreaterThan(previous)
      previous = r.radius
    }
  })

  it('reproduces W = 47 on a square at the library default headroom', () => {
    const r = percentWidthReserve({
      pct: 0.059,
      aspect: 1,
      variance: 0.53,
      finishTerms: 0,
      headroom: 0,
    })
    // Deviation from the brief's literal (46.978, 3): the true value is 46.97850136…, which is
    // 0.0000014 short of the toBeCloseTo(46.978, 3) boundary of 0.0005 and fails it. The
    // pre-flight scan's own figure (46.9785) is exact here, so the pinned literal moves to it at
    // one more digit of precision rather than "improving" the closure to hit a slightly-off target.
    expect(r.widthRef).toBeCloseTo(46.9785, 4)
    expect(r.radius).toBeCloseTo(83.8771, 4)
  })

  it('is the identity at pct 0', () => {
    const r = percentWidthReserve({
      pct: 0,
      aspect: 1,
      variance: 0.53,
      finishTerms: 0,
      headroom: 0,
    })
    expect(r.widthRef).toBe(0)
    expect(r.radius).toBeCloseTo(12, 9)
  })
})
