import { describe, expect, it } from 'vitest'
import {
  computeSdf,
  decodeDistance,
  decodeField,
  downsampleField,
  edt1d,
  encodeDistance,
  encodeField,
  SDF_INF,
  signedDistanceField,
  squaredEdt,
  targetDimensions,
} from './sdf.js'

/** Four columns per row: two solid, two empty. Every row is identical. */
function halfAndHalf(rows: number): Float32Array {
  const alpha = new Float32Array(4 * rows)
  for (let y = 0; y < rows; y++) {
    alpha[y * 4 + 0] = 1
    alpha[y * 4 + 1] = 1
  }
  return alpha
}

describe('edt1d', () => {
  it('is the lower envelope of parabolas: squared distance to the nearest zero cost', () => {
    const n = 5
    const f = Float64Array.from([0, SDF_INF, SDF_INF, SDF_INF, 0])
    const d = new Float64Array(n)
    edt1d(f, d, new Int32Array(n), new Float64Array(n + 1), n)
    expect(Array.from(d)).toEqual([0, 1, 4, 1, 0])
  })

  it('uses Float64 scratch, because the parabola abscissa is a difference of large numbers', () => {
    // A regression guard on the signature rather than on a value: an Int32Array `z` silently
    // truncates -1e20 to 0 and the envelope collapses.
    const n = 3
    const f = Float64Array.from([SDF_INF, 0, SDF_INF])
    const d = new Float64Array(n)
    edt1d(f, d, new Int32Array(n), new Float64Array(n + 1), n)
    expect(Array.from(d)).toEqual([1, 0, 1])
  })
})

describe('squaredEdt', () => {
  it('gives the exact squared distance to the nearest seed, in place', () => {
    const grid = new Float32Array(9).fill(SDF_INF)
    grid[4] = 0
    const out = squaredEdt(grid, 3, 3)
    expect(out).toBe(grid)
    expect(Array.from(grid)).toEqual([2, 1, 2, 1, 0, 1, 2, 1, 2])
  })
})

describe('signedDistanceField', () => {
  it('is positive inside, negative outside, and offset half a pixel from the centre', () => {
    const field = signedDistanceField(halfAndHalf(4), 4, 4)
    for (let y = 0; y < 4; y++) {
      expect(Array.from(field.slice(y * 4, y * 4 + 4))).toEqual([1.5, 0.5, -0.5, -1.5])
    }
  })

  it('refines the boundary layer from the anti-aliased alpha, and fades it out at 1.5 px', () => {
    const alpha = new Float32Array(16)
    for (let y = 0; y < 4; y++) {
      alpha[y * 4 + 0] = 1
      alpha[y * 4 + 1] = 0.75
      alpha[y * 4 + 2] = 0.25
      alpha[y * 4 + 3] = 0
    }
    const field = signedDistanceField(alpha, 4, 4)
    // alpha 0.75 -> subPixel +0.25 replaces the quantised +0.5; alpha 0.25 -> -0.25.
    // alpha 1 and alpha 0 are untouched, because the refinement only runs on 0 < a < 1.
    expect(Array.from(field.slice(0, 4))).toEqual([1.5, 0.25, -0.25, -1.5])
  })
})

describe('downsampleField', () => {
  it('copies rather than aliases when the dimensions already match', () => {
    const src = Float32Array.from([1, 2, 3, 4])
    const out = downsampleField(src, 2, 2, 2, 2)
    expect(Array.from(out)).toEqual([1, 2, 3, 4])
    expect(out).not.toBe(src)
  })

  it('averages, never rescales: distances are already in source pixels', () => {
    const src = Float32Array.from([1, 2, 3, 4])
    expect(Array.from(downsampleField(src, 2, 2, 1, 1))).toEqual([2.5])
  })

  it('weights partially covered pixels on a non-integer ratio', () => {
    // 3 -> 2 on one axis: the middle source pixel is split between both destinations.
    const src = Float32Array.from([0, 6, 12])
    const out = downsampleField(src, 3, 1, 2, 1)
    expect(out[0]).toBeCloseTo(2, 6)
    expect(out[1]).toBeCloseTo(10, 6)
  })
})

describe('the 8-bit encoding contract', () => {
  it('puts the silhouette edge at 128 and never emits 0', () => {
    expect(encodeDistance(0, 10)).toBe(128)
    expect(encodeDistance(10, 10)).toBe(255)
    expect(encodeDistance(-10, 10)).toBe(1)
    expect(encodeDistance(1e6, 10)).toBe(255)
    expect(encodeDistance(-1e6, 10)).toBe(1)
  })

  it('decodes back to source pixels', () => {
    expect(decodeDistance(128, 10)).toBe(0)
    expect(decodeDistance(255, 10)).toBeCloseTo(10, 10)
    expect(decodeDistance(1, 10)).toBeCloseTo(-10, 10)
  })

  it('round-trips a whole field to within one quantisation step', () => {
    const field = Float32Array.from([-9, -3, 0, 3, 9])
    const back = decodeField(encodeField(field, 10), 10)
    for (let i = 0; i < field.length; i++) {
      expect(Math.abs(back[i] - field[i])).toBeLessThanOrEqual(10 / 127)
    }
  })
})

describe('targetDimensions', () => {
  it('fits the long edge and keeps the aspect ratio', () => {
    expect(targetDimensions(998, 951, 512)).toEqual({ width: 512, height: 488 })
    expect(targetDimensions(100, 200, 64)).toEqual({ width: 32, height: 64 })
  })

  it('never goes below 1 px on the short edge', () => {
    expect(targetDimensions(1000, 3, 8)).toEqual({ width: 8, height: 1 })
  })
})

describe('computeSdf', () => {
  it('bakes alpha in and a quantised map plus its sidecar out', () => {
    const out = computeSdf({ alpha: halfAndHalf(4), width: 4, height: 4, size: 4, rangePx: 2 })
    expect(out.width).toBe(4)
    expect(out.height).toBe(4)
    expect(out.rangePx).toBe(2)
    expect(out.sourceWidth).toBe(4)
    expect(out.sourceHeight).toBe(4)
    expect(Array.from(out.field.slice(0, 4))).toEqual([1.5, 0.5, -0.5, -1.5])
    expect(Array.from(out.data.slice(0, 4))).toEqual([223, 160, 96, 33])
  })
})
