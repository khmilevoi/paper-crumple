import { MotionError } from '@paper-crumple/core'
import { describe, expect, it } from 'vitest'

import type { SheetFit } from './buckets.js'
import { BUCKETS, MAX_STRETCH, fitSheet, pickBucket } from './buckets.js'

/** A cast and not a `throw`: ESLint bans every `ThrowStatement` here, tests included. */
function fit(w: number, h: number, override?: string | null): SheetFit {
  const f = fitSheet(w, h, override)
  expect(f).not.toBeInstanceOf(Error)
  return f as SheetFit
}

describe('the bucket table', () => {
  it('is the three aspects spec 9.3 fixes, in order', () => {
    expect(BUCKETS.map((b) => b.id)).toEqual(['2x3', '1x1', '3x2'])
    expect(BUCKETS.map((b) => b.aspect)).toEqual([2 / 3, 1, 3 / 2])
    expect(Object.isFrozen(BUCKETS)).toBe(true)
  })

  it('clamps at 1.2, and the reciprocal is written as 1 / 1.2 and never as 0.8', () => {
    expect(MAX_STRETCH).toBe(1.2)
    expect(1 / MAX_STRETCH).toBeCloseTo(0.8333333333333334, 15)
    expect(1 / MAX_STRETCH).not.toBe(0.8)
  })
})

describe('pickBucket', () => {
  it('picks the nearest in log-aspect, so 0.8 is as far from 1 as 1.25 is', () => {
    expect(pickBucket(2 / 3)).toMatchObject({ id: '2x3' })
    expect(pickBucket(1)).toMatchObject({ id: '1x1' })
    expect(pickBucket(1.5)).toMatchObject({ id: '3x2' })
    // |ln(0.8 / 0.667)| = 0.18 < |ln 0.8| = 0.22
    expect(pickBucket(0.8)).toMatchObject({ id: '2x3' })
    expect(pickBucket(0.85)).toMatchObject({ id: '1x1' })
    expect(pickBucket(0.2)).toMatchObject({ id: '2x3' })
    expect(pickBucket(9)).toMatchObject({ id: '3x2' })
  })

  it('places the boundaries at the geometric means', () => {
    const lo = Math.sqrt(2 / 3) // 0.81650
    const hi = Math.sqrt(1.5) // 1.22474
    expect(pickBucket(lo - 1e-6)).toMatchObject({ id: '2x3' })
    expect(pickBucket(lo + 1e-6)).toMatchObject({ id: '1x1' })
    expect(pickBucket(hi - 1e-6)).toMatchObject({ id: '1x1' })
    expect(pickBucket(hi + 1e-6)).toMatchObject({ id: '3x2' })
  })

  it('is a MotionError for an aspect that is not a positive finite number', () => {
    expect(MotionError.is(pickBucket(0))).toBe(true)
    expect(MotionError.is(pickBucket(-1))).toBe(true)
    expect(MotionError.is(pickBucket(NaN))).toBe(true)
    expect(MotionError.is(pickBucket(Infinity))).toBe(true)
  })
})

describe('fitSheet', () => {
  it('fits an exact aspect with stretch 1 and no clamp', () => {
    const f = fit(400, 600)
    expect(f.bucket).toBe('2x3')
    expect(f.stretch).toBeCloseTo(1, 12)
    expect(f.clamped).toBe(false)
    expect(f.sheetW).toBeCloseTo(400, 9)
    expect(f.sheetH).toBeCloseTo(600, 9)
    expect(fit(500, 500).bucket).toBe('1x1')
    expect(fit(600, 400).bucket).toBe('3x2')
  })

  it('stretches to the bbox exactly at the edge of the clamp, and reports clamped false there', () => {
    // 480/600 = 0.8 against 2/3 gives raw = 1.2000000000000002, which is MAX_STRETCH to within
    // float error. A `!==` test would call this clamped; the 1e-9 tolerance does not.
    const f = fit(480, 600)
    expect(f.bucket).toBe('2x3')
    expect(f.stretch).toBeCloseTo(MAX_STRETCH, 12)
    expect(f.clamped).toBe(false)
    expect(f.sheetW).toBeCloseTo(480, 9)
    expect(f.sheetH).toBeCloseTo(600, 9)
  })

  it('clamps past the limit and still covers the bbox', () => {
    const tall = fit(300, 600) // 0.5: squeezed only to 1/1.2, so wider than the paper
    expect(tall.bucket).toBe('2x3')
    expect(tall.clamped).toBe(true)
    expect(tall.stretch).toBeCloseTo(1 / MAX_STRETCH, 12)
    expect(tall.sheetH).toBeCloseTo(600, 9)
    expect(tall.sheetW).toBeCloseTo((600 * (2 / 3)) / MAX_STRETCH, 9)
    expect(tall.sheetW).toBeGreaterThanOrEqual(300)

    const wide = fit(1200, 600) // 2.0: 3x2 at 1.2 gives 1080 < 1200, so the cover-scale grows it
    expect(wide.bucket).toBe('3x2')
    expect(wide.clamped).toBe(true)
    expect(wide.sheetW).toBeCloseTo(1200, 9)
    expect(wide.sheetH).toBeCloseTo(600 * (1200 / 1080), 9)
    expect(wide.sheetH).toBeGreaterThanOrEqual(600)
  })

  it('absorbs the residual the boundary demands, which exceeds the clamp', () => {
    // At the 2x3/1x1 boundary the stretch demanded is sqrt(2/3) / (2/3) = 1.22474 > 1.2.
    const f = fit(Math.sqrt(2 / 3) * 600 - 0.001, 600)
    expect(f.bucket).toBe('2x3')
    expect(f.clamped).toBe(true)
    expect(f.stretch).toBeCloseTo(MAX_STRETCH, 12)
    expect(f.sheetW).toBeGreaterThanOrEqual(Math.sqrt(2 / 3) * 600 - 0.001)
    expect(f.sheetH).toBeGreaterThanOrEqual(600)
    // A uniform scale: the ratio the clamp produced survives it.
    expect(f.sheetW / f.sheetH).toBeCloseTo((2 / 3) * MAX_STRETCH, 12)
  })

  it('always covers, for a wide sweep of aspects', () => {
    for (let w = 20; w <= 2000; w += 37) {
      const f = fit(w, 600)
      expect(f.sheetW).toBeGreaterThanOrEqual(w - 1e-9)
      expect(f.sheetH).toBeGreaterThanOrEqual(600 - 1e-9)
    }
  })

  it('honours an override and still covers', () => {
    const f = fit(400, 600, '1x1')
    expect(f.bucket).toBe('1x1')
    expect(f.clamped).toBe(true)
    expect(f.sheetW).toBeGreaterThanOrEqual(400)
    expect(f.sheetH).toBeGreaterThanOrEqual(600)
    expect(fit(400, 600, null).bucket).toBe('2x3')
  })

  it('is a MotionError for a degenerate bbox and for an unknown override', () => {
    expect(MotionError.is(fitSheet(0, 10))).toBe(true)
    expect(MotionError.is(fitSheet(10, NaN))).toBe(true)
    expect(MotionError.is(fitSheet(-5, 10))).toBe(true)
    expect(MotionError.is(fitSheet(400, 600, 'nope'))).toBe(true)
    // The spike's synthetic harness bucket is not a runtime bucket: spec 9.3 fixes three.
    expect(MotionError.is(fitSheet(400, 600, 'synthetic'))).toBe(true)
  })
})
