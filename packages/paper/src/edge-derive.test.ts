import { describe, expect, it } from 'vitest'
import { hullBandFor, midHigh, midLow, tearAmpsFor, CHEW_REACH } from './edge-derive.js'

describe('hullBandFor (design 2026-09-05 §5)', () => {
  it('reproduces the hull defaults to within a tenth of a reference px', () => {
    const band = hullBandFor(47, 0.53)
    expect(band.minDist).toBeCloseTo(22.09, 2)
    expect(band.maxDist).toBeCloseTo(71.91, 2)
  })

  it('is exactly 22 / 72 at the parity variance 25/47', () => {
    const band = hullBandFor(47, 25 / 47)
    expect(band.minDist).toBeCloseTo(22, 9)
    expect(band.maxDist).toBeCloseTo(72, 9)
  })

  it('collapses to a point at variance 0 and to [0, 2W] at variance 1', () => {
    expect(hullBandFor(47, 0)).toEqual({ minDist: 47, maxDist: 47 })
    expect(hullBandFor(47, 1)).toEqual({ minDist: 0, maxDist: 94 })
  })

  it('is 0/0 at width 0, which is what makes buildHull return HULL_USE_ALPHA', () => {
    expect(hullBandFor(0, 0.53)).toEqual({ minDist: 0, maxDist: 0 })
  })
})

describe('the mid octave bounds', () => {
  it('interpolates the shader s own two branches', () => {
    expect(midLow(0)).toBeCloseTo(0.225, 9)
    expect(midHigh(0)).toBeCloseTo(0.225, 9)
    expect(midLow(1)).toBeCloseTo(1, 9)
    expect(midHigh(1)).toBeCloseTo(0.55, 9)
    expect(midLow(0.8)).toBeCloseTo(0.845, 9)
    expect(midHigh(0.8)).toBeCloseTo(0.485, 9)
  })
})

describe('tearAmpsFor (design 2026-09-05 §5)', () => {
  const defaults = { widthRef: 47, variance: 0.53, tearMix: 0.6, tearAngular: 0.8, chew: 1.8 }

  it('reproduces the design s worked numbers', () => {
    const a = tearAmpsFor(defaults)
    expect(a.tearAmp).toBeCloseTo(13.22, 2)
    expect(a.midAmp).toBeCloseTo(10.43, 2)
  })

  it('pins the lower reach at exactly W (1 - v)', () => {
    for (const tearAngular of [0, 0.4, 0.8, 1]) {
      for (const tearMix of [0, 0.3, 0.6, 1]) {
        const o = { ...defaults, tearAngular, tearMix }
        const a = tearAmpsFor(o)
        const down = a.tearAmp + midLow(tearAngular) * a.midAmp + CHEW_REACH * o.chew
        expect(o.widthRef - down).toBeCloseTo(o.widthRef * (1 - o.variance), 9)
      }
    }
  })

  it('keeps the upper reach inside W (1 + v)', () => {
    for (const tearAngular of [0, 0.4, 0.8, 1]) {
      for (const tearMix of [0, 0.3, 0.6, 1]) {
        const o = { ...defaults, tearAngular, tearMix }
        const a = tearAmpsFor(o)
        const up = a.tearAmp + midHigh(tearAngular) * a.midAmp + CHEW_REACH * o.chew
        expect(o.widthRef + up).toBeLessThanOrEqual(o.widthRef * (1 + o.variance) + 1e-9)
      }
    }
  })

  it('clamps the budget at zero and lets chew alone set the wobble', () => {
    const a = tearAmpsFor({ ...defaults, widthRef: 2, variance: 0.5, chew: 8 })
    expect(a.tearAmp).toBe(0)
    expect(a.midAmp).toBe(0)
  })

  it('puts the whole budget in the low octave at tearMix 1, and none at 0', () => {
    expect(tearAmpsFor({ ...defaults, tearMix: 1 }).midAmp).toBe(0)
    expect(tearAmpsFor({ ...defaults, tearMix: 0 }).tearAmp).toBe(0)
  })

  it('never divides by zero: midLow is bounded below by 0.225', () => {
    const a = tearAmpsFor({ ...defaults, tearAngular: 0 })
    expect(Number.isFinite(a.midAmp)).toBe(true)
  })
})
