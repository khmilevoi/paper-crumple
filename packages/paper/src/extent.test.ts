import { describe, expect, it } from 'vitest'
import { growBox, scaleBox, sheetRectFromExtent, signedFieldExtent } from './extent.js'

/** A signed field: +1 inside the box, -1 outside. Row-major, y-down, like every field here. */
function boxField(w: number, h: number, x0: number, y0: number, x1: number, y1: number) {
  const f = new Float32Array(w * h).fill(-1)
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) f[y * w + x] = 1
  return f
}

describe('signedFieldExtent', () => {
  it('finds the non-negative box', () => {
    expect(signedFieldExtent(boxField(16, 16, 3, 4, 10, 12), 16, 16)).toEqual({
      x0: 3,
      y0: 4,
      x1: 10,
      y1: 12,
    })
  })

  it('returns undefined for an entirely negative field', () => {
    expect(signedFieldExtent(new Float32Array(64).fill(-1), 8, 8)).toBeUndefined()
  })

  it('treats exactly zero as inside, because zero is the boundary', () => {
    const f = new Float32Array(16).fill(-1)
    f[5] = 0
    expect(signedFieldExtent(f, 4, 4)).toEqual({ x0: 1, y0: 1, x1: 1, y1: 1 })
  })
})

describe('scaleBox and growBox', () => {
  it('scales field texels into source pixels', () => {
    expect(scaleBox({ x0: 2, y0: 4, x1: 6, y1: 8 }, 2)).toEqual({ x0: 4, y0: 8, x1: 13, y1: 17 })
  })

  it('grows by a radius and clamps to the plane', () => {
    expect(growBox({ x0: 1, y0: 1, x1: 5, y1: 5 }, 3, 8, 8)).toEqual({
      x0: 0,
      y0: 0,
      x1: 7,
      y1: 7,
    })
  })
})

describe('sheetRectFromExtent', () => {
  it("applies the spike's 4 % margin through P8's sheetRect", () => {
    // 0.04 * max(bw, bh) = 0.04 * 41 = 1.64 -> 2 px on every side, clamped at the plane.
    expect(sheetRectFromExtent({ x0: 10, y0: 10, x1: 50, y1: 30 }, 100, 100)).toEqual({
      x: 8,
      y: 8,
      w: 45,
      h: 25,
    })
  })
})
