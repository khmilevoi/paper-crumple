import { describe, expect, it } from 'vitest'
import {
  HULL_USE_ALPHA,
  hullBuffers,
  hullBytes,
  hullComponent,
  hullComponentCount,
  hullExtent,
  hullVertexCount,
  packPolygons,
} from './hull-shape.js'
import type { Loop } from './point.js'

const triangle: Loop = [
  [0, 0],
  [4, 0],
  [0, 3],
]
const quad: Loop = [
  [10, 10],
  [14, 10],
  [14, 14],
  [10, 14],
]

describe('packPolygons', () => {
  it('interleaves x and y into one Float32Array and records component starts in vertices', () => {
    const hull = packPolygons([triangle, quad], -9.024, 0.8667)
    expect(hull.kind).toBe('polygons')
    expect(Array.from(hull.points)).toEqual([0, 0, 4, 0, 0, 3, 10, 10, 14, 10, 14, 14, 10, 14])
    expect(Array.from(hull.offsets)).toEqual([0, 3, 7])
    expect(hull.iso).toBeCloseTo(-9.024, 10)
    expect(hull.tolerance).toBeCloseTo(0.8667, 10)
  })

  it('always starts the offset table at 0 and ends it at the vertex count', () => {
    const hull = packPolygons([triangle, quad], 0, 1)
    expect(hull.offsets[0]).toBe(0)
    expect(hull.offsets[hull.offsets.length - 1]).toBe(hullVertexCount(hull))
    expect(hull.offsets.length).toBe(hullComponentCount(hull) + 1)
  })

  it('packs an empty polygon list into an empty hull rather than a use-alpha one', () => {
    const hull = packPolygons([], 0, 1)
    expect(hull.kind).toBe('polygons')
    expect(hullComponentCount(hull)).toBe(0)
    expect(hullVertexCount(hull)).toBe(0)
    expect(Array.from(hull.offsets)).toEqual([0])
  })
})

describe('reading a packed hull back', () => {
  it('materialises one component at a time, in the order it was packed', () => {
    const hull = packPolygons([triangle, quad], 0, 1)
    expect(hullComponent(hull, 0)).toEqual(triangle)
    expect(hullComponent(hull, 1)).toEqual(quad)
  })

  it('returns an empty loop for a component index that does not exist', () => {
    const hull = packPolygons([triangle], 0, 1)
    expect(hullComponent(hull, 1)).toEqual([])
    expect(hullComponent(hull, -1)).toEqual([])
  })

  it('counts two components, because a pair of sneakers is two pieces of paper', () => {
    expect(hullComponentCount(packPolygons([triangle, quad], 0, 1))).toBe(2)
    expect(hullVertexCount(packPolygons([triangle, quad], 0, 1))).toBe(7)
  })
})

describe('the byte figure §8.5 budgets', () => {
  it('is 8 bytes per vertex plus 4 per component boundary', () => {
    const hull = packPolygons(
      [Array.from({ length: 40 }, (_, i): [number, number] => [i, i])],
      0,
      1,
    )
    // 40 vertices x 2 floats x 4 B = 320, plus a two-entry Uint32Array offset table = 8.
    expect(hullBytes(hull)).toBe(328)
    // P5's handleBytes model adds 400 B of fixed terms, giving the 728 B it asserts for the
    // reference handle. That figure is re-derived there, not imported here.
    expect(hullBytes(hull) + 400).toBe(728)
  })

  it('is independent of the field the hull was traced on', () => {
    const a = packPolygons([triangle], -1, 1)
    const b = packPolygons([triangle], -900, 90)
    expect(hullBytes(a)).toBe(hullBytes(b))
  })

  it('hands the two buffers out in the order handleBytes counts them', () => {
    const hull = packPolygons([triangle], 0, 1)
    expect(hullBuffers(hull)).toEqual([hull.points, hull.offsets])
    expect(hullBuffers(hull).reduce((n, b) => n + b.byteLength, 0)).toBe(hullBytes(hull))
  })
})

describe('HULL_USE_ALPHA', () => {
  it('is a frozen sentinel that costs nothing and carries no buffers', () => {
    expect(HULL_USE_ALPHA.kind).toBe('use-alpha')
    expect(Object.isFrozen(HULL_USE_ALPHA)).toBe(true)
    expect(hullBuffers(HULL_USE_ALPHA)).toEqual([])
    expect(hullBytes(HULL_USE_ALPHA)).toBe(0)
    expect(hullComponentCount(HULL_USE_ALPHA)).toBe(0)
    expect(hullVertexCount(HULL_USE_ALPHA)).toBe(0)
    expect(hullExtent(HULL_USE_ALPHA, 16, 16)).toBeUndefined()
  })
})

describe('hullExtent', () => {
  it('rounds outward, because a paper extent must not clip the paper', () => {
    const hull = packPolygons(
      [
        [
          [2.4, 3.6],
          [9.7, 3.6],
          [9.7, 12.2],
        ],
      ],
      0,
      1,
    )
    expect(hullExtent(hull, 16, 16)).toEqual({ x0: 2, y0: 3, x1: 10, y1: 13 })
  })

  it('clamps to the grid, so a hull that runs off the field still yields a usable box', () => {
    const hull = packPolygons(
      [
        [
          [-5, -5],
          [100, -5],
          [100, 100],
        ],
      ],
      0,
      1,
    )
    expect(hullExtent(hull, 16, 16)).toEqual({ x0: 0, y0: 0, x1: 15, y1: 15 })
  })

  it('is undefined when there are no vertices to take a min over', () => {
    expect(hullExtent(packPolygons([], 0, 1), 16, 16)).toBeUndefined()
  })
})
