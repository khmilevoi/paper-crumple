import { describe, expect, it } from 'vitest'
import { cpuSdfFromAlpha, fieldGradient, moveToDistance, sampleField } from './field.js'
import { signedDistanceField } from './sdf.js'

/** The 4x4 field of task 1: [1.5, 0.5, -0.5, -1.5] on every row, so d/dx is exactly -1. */
function ramp(): Float32Array {
  const alpha = new Float32Array(16)
  for (let y = 0; y < 4; y++) {
    alpha[y * 4 + 0] = 1
    alpha[y * 4 + 1] = 1
  }
  return signedDistanceField(alpha, 4, 4)
}

describe('cpuSdfFromAlpha', () => {
  it('is the exact CPU transform of the alpha, and is the DEGRADED path', () => {
    const alpha = new Float32Array(16)
    for (let y = 0; y < 4; y++) {
      alpha[y * 4 + 0] = 1
      alpha[y * 4 + 1] = 1
    }
    expect(Array.from(cpuSdfFromAlpha(alpha, 4, 4))).toEqual(Array.from(ramp()))
  })
})

describe('sampleField', () => {
  it('returns the texel value at a texel centre', () => {
    const f = ramp()
    expect(sampleField(f, 4, 4, 0, 0)).toBeCloseTo(1.5, 6)
    expect(sampleField(f, 4, 4, 1, 2)).toBeCloseTo(0.5, 6)
    expect(sampleField(f, 4, 4, 3, 3)).toBeCloseTo(-1.5, 6)
  })

  it('interpolates bilinearly between them', () => {
    const f = ramp()
    expect(sampleField(f, 4, 4, 1.5, 0)).toBeCloseTo(0, 6)
    expect(sampleField(f, 4, 4, 0.25, 0)).toBeCloseTo(1.25, 6)
  })

  it('clamps to the grid rather than reading off the end', () => {
    const f = ramp()
    expect(sampleField(f, 4, 4, -50, -50)).toBeCloseTo(1.5, 6)
    expect(sampleField(f, 4, 4, 50, 50)).toBeCloseTo(-1.5, 6)
  })
})

describe('fieldGradient', () => {
  it('points INWARD, because the field grows inside', () => {
    const f = ramp()
    const [gx, gy] = fieldGradient(f, 4, 4, 1.5, 1.5)
    expect(gx).toBeCloseTo(-1, 6)
    expect(gy).toBeCloseTo(0, 6)
  })
})

describe('moveToDistance', () => {
  it('slides a point along the gradient until the field reads -target', () => {
    const f = ramp()
    // The field reads -0.5 at x = 2, so a target of 0.5 texels outside lands there.
    const [x, y] = moveToDistance(f, 4, 4, [1, 1], 0.5)
    expect(x).toBeCloseTo(2, 1)
    expect(y).toBeCloseTo(1, 6)
    expect(sampleField(f, 4, 4, x, y)).toBeCloseTo(-0.5, 1)
  })

  it('stops at the best it can reach rather than running away', () => {
    const f = ramp()
    // 100 texels outside does not exist on a 4-wide grid: the result is clamped, not NaN.
    const [x, y] = moveToDistance(f, 4, 4, [1, 1], 100)
    expect(Number.isFinite(x)).toBe(true)
    expect(Number.isFinite(y)).toBe(true)
    expect(x).toBeGreaterThanOrEqual(0)
    expect(x).toBeLessThanOrEqual(3)
  })

  it('does not move a point that is already at its target', () => {
    const f = ramp()
    const [x] = moveToDistance(f, 4, 4, [2, 1], 0.5)
    expect(x).toBeCloseTo(2, 6)
  })
})
