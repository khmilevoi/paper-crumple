import { describe, expect, it } from 'vitest'
import type { Loop } from './point.js'
import { simplifyLoop, simplifyPolyline } from './simplify.js'

describe('simplifyPolyline', () => {
  it('keeps the endpoints and nothing else on a straight run', () => {
    const line: Loop = [
      [0, 0],
      [1, 0],
      [2, 0],
      [3, 0],
    ]
    expect(simplifyPolyline(line, 0.5)).toEqual([
      [0, 0],
      [3, 0],
    ])
  })

  it('keeps a vertex further from the chord than the tolerance', () => {
    const spike: Loop = [
      [0, 0],
      [1, 0],
      [2, 5],
      [3, 0],
      [4, 0],
    ]
    expect(simplifyPolyline(spike, 1)).toEqual([
      [0, 0],
      [2, 5],
      [4, 0],
    ])
  })

  it('copies rather than aliases a polyline of two points or fewer', () => {
    const two: Loop = [
      [0, 0],
      [1, 1],
    ]
    const out = simplifyPolyline(two, 0.5)
    expect(out).toEqual(two)
    expect(out).not.toBe(two)
  })
})

describe('simplifyLoop', () => {
  it('splits at the vertex farthest from vertex 0 so both halves have real endpoints', () => {
    // A square with one redundant midpoint on its bottom edge.
    const loop: Loop = [
      [0, 0],
      [1, 0],
      [2, 0],
      [2, 2],
      [0, 2],
    ]
    expect(simplifyLoop(loop, 0.5)).toEqual([
      [0, 0],
      [2, 0],
      [2, 2],
      [0, 2],
    ])
  })

  it('never drops a corner of a square, whatever the tolerance', () => {
    const square: Loop = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ]
    expect(simplifyLoop(square, 0.5)).toEqual(square)
  })

  it('copies rather than aliases a loop of three points or fewer', () => {
    const tri: Loop = [
      [0, 0],
      [1, 0],
      [0, 1],
    ]
    const out = simplifyLoop(tri, 5)
    expect(out).toEqual(tri)
    expect(out).not.toBe(tri)
  })

  it('never repeats the first vertex at the end', () => {
    const loop: Loop = [
      [0, 0],
      [4, 0],
      [8, 0],
      [8, 8],
      [4, 8],
      [0, 8],
    ]
    const out = simplifyLoop(loop, 0.5)
    expect(out[0]).not.toEqual(out[out.length - 1])
    expect(out.length).toBeGreaterThanOrEqual(3)
  })
})
