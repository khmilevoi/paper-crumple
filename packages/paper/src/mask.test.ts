import { describe, expect, it } from 'vitest'
import {
  ALPHA_BBOX_THRESHOLD,
  alphaBbox,
  components,
  holes,
  SHEET_MARGIN_FRAC,
  sheetRect,
} from './mask.js'

/** RGBA where only the alpha channel matters. */
function rgbaFromAlpha(alpha: readonly number[]): Uint8Array {
  const out = new Uint8Array(alpha.length * 4)
  for (let i = 0; i < alpha.length; i++) out[i * 4 + 3] = alpha[i]
  return out
}

describe('alphaBbox', () => {
  it('uses threshold 8, and 8 itself is below it', () => {
    expect(ALPHA_BBOX_THRESHOLD).toBe(8)
    // Row 0: alpha 0, 8, 9, 255. Row 1: nothing.
    const rgba = rgbaFromAlpha([0, 8, 9, 255, 0, 0, 0, 0])
    expect(alphaBbox(rgba, 4, 2)).toEqual({ x0: 2, y0: 0, x1: 3, y1: 0 })
  })

  it('is inclusive on all four sides', () => {
    const rgba = rgbaFromAlpha([255, 0, 0, 0, 0, 0, 0, 0, 255])
    expect(alphaBbox(rgba, 3, 3)).toEqual({ x0: 0, y0: 0, x1: 2, y1: 2 })
  })

  it('honours an explicit threshold', () => {
    const rgba = rgbaFromAlpha([0, 100, 200, 0])
    expect(alphaBbox(rgba, 4, 1, 150)).toEqual({ x0: 2, y0: 0, x1: 2, y1: 0 })
  })

  it('is undefined when no pixel clears the threshold, rather than an Error or a throw', () => {
    expect(alphaBbox(rgbaFromAlpha([0, 0, 0, 0]), 4, 1)).toBeUndefined()
    expect(alphaBbox(rgbaFromAlpha([1, 2, 8, 8]), 4, 1)).toBeUndefined()
  })
})

describe('sheetRect', () => {
  it('adds 4 % of the LONG side of the bbox, on every side', () => {
    expect(SHEET_MARGIN_FRAC).toBe(0.04)
    // bbox 50 x 20 -> margin round(0.04 * 50) = 2.
    expect(sheetRect({ x0: 10, y0: 10, x1: 59, y1: 29 }, 100, 100)).toEqual({
      x: 8,
      y: 8,
      w: 54,
      h: 24,
    })
  })

  it('clamps to the frame rather than running off it', () => {
    expect(sheetRect({ x0: 0, y0: 0, x1: 49, y1: 49 }, 50, 50)).toEqual({
      x: 0,
      y: 0,
      w: 50,
      h: 50,
    })
  })

  it('honours an explicit marginFrac, because a different rect is a different bucket', () => {
    // bbox 50 x 20 -> margin round(0.2 * 50) = 10.
    expect(sheetRect({ x0: 20, y0: 20, x1: 69, y1: 39 }, 200, 200, 0.2)).toEqual({
      x: 10,
      y: 10,
      w: 70,
      h: 40,
    })
  })
})

describe('components', () => {
  it('is 8-connected, so a knife-edge diagonal corner is not a stray extra blob', () => {
    expect(components([1, 0, 0, 1], 2, 2)).toEqual([2])
  })

  it('separates genuinely disjoint blobs', () => {
    expect(components([1, 0, 1], 3, 1)).toEqual([1, 1])
  })

  it('reports sizes largest first', () => {
    expect(components([1, 1, 1, 0, 1], 5, 1)).toEqual([3, 1])
  })

  it('is empty for an empty mask', () => {
    expect(components([0, 0, 0, 0], 2, 2)).toEqual([])
  })
})

describe('holes', () => {
  /** A 5x5 ring of foreground around a 3x3 empty centre. */
  const ring = Array.from({ length: 25 }, (_, i) => {
    const x = i % 5
    const y = (i / 5) | 0
    return x === 0 || y === 0 || x === 4 || y === 4 ? 1 : 0
  })

  /**
   * A diamond of eight foreground pixels touching only at their corners. The foreground is one
   * 8-connected blob; the five background pixels it surrounds are sealed only under 4-connected
   * background labelling, which is exactly the pairing this module uses.
   */
  const diamond = Array.from({ length: 25 }, (_, i) => {
    const x = i % 5
    const y = (i / 5) | 0
    return Math.abs(x - 2) + Math.abs(y - 2) === 2 ? 1 : 0
  })

  it('counts an enclosed background region as a hole', () => {
    expect(holes(ring, 5, 5)).toEqual({
      components: 1,
      sizes: [16],
      holes: 1,
      holeSizes: [9],
    })
  })

  it('pairs an 8-connected foreground with a 4-connected background', () => {
    // Under 8-connected background the diamond's centre would leak diagonally to the border and
    // the hole would vanish; under 4-connected foreground the diamond would be eight components.
    expect(holes(diamond, 5, 5)).toEqual({
      components: 1,
      sizes: [8],
      holes: 1,
      holeSizes: [5],
    })
  })

  it('finds no hole in a solid blob', () => {
    expect(holes(new Uint8Array(9).fill(1), 3, 3)).toEqual({
      components: 1,
      sizes: [9],
      holes: 0,
      holeSizes: [],
    })
  })

  it('never reports background that reaches the border as a hole', () => {
    // A C shape: the gap opens onto the border.
    const c = [1, 1, 1, 1, 0, 0, 1, 1, 1]
    expect(holes(c, 3, 3).holes).toBe(0)
  })

  it('reports at most six sizes of each, so a pathological mask cannot flood a log line', () => {
    const speckles = Array.from({ length: 100 }, (_, i) => (i % 2 === 0 ? 1 : 0))
    const report = holes(speckles, 10, 10)
    expect(report.sizes.length).toBeLessThanOrEqual(6)
    expect(report.holeSizes.length).toBeLessThanOrEqual(6)
  })

  it('caps sizes arrays to exactly 6 entries when there are more components and holes', () => {
    // Create a 20x20 grid of rings: 3x3 grid with ring centers evenly spaced
    // This produces 9 components and 9 holes, testing the .slice(0, 6) cap
    const gridRings = Array.from({ length: 400 }, (_, i) => {
      const x = i % 20
      const y = (i / 20) | 0
      let isRing = false
      // Ring centers at (3, 3), (3, 10), (3, 17), (10, 3), (10, 10), (10, 17), (17, 3), (17, 10), (17, 17)
      for (let cy = 3; cy <= 17; cy += 7) {
        for (let cx = 3; cx <= 17; cx += 7) {
          const dx = x - cx
          const dy = y - cy
          const d = Math.sqrt(dx * dx + dy * dy)
          if (d > 1 && d < 3) {
            isRing = true
            break
          }
        }
        if (isRing) break
      }
      return isRing ? 1 : 0
    })
    const report = holes(gridRings, 20, 20)
    expect(report.sizes.length).toBe(6)
    expect(report.holeSizes.length).toBe(6)
  })
})
