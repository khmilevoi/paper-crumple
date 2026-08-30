import { PackError } from '@paper-crumple/core'
import { describe, expect, it } from 'vitest'

import { decodeOct, encodeOct, snorm8 } from './oct.js'

describe('snorm8', () => {
  it('is floor(v * 127 + 0.5), not half-to-even', () => {
    expect(snorm8(0.5 / 127)).toBe(1)
    expect(snorm8(1.5 / 127)).toBe(2)
    expect(snorm8(-0.5 / 127)).toBe(0)
    expect(snorm8(0)).toBe(0)
    expect(snorm8(1)).toBe(127)
    expect(snorm8(-1)).toBe(-127)
  })

  it('clamps rather than wrapping', () => {
    expect(snorm8(5)).toBe(127)
    expect(snorm8(-5)).toBe(-127)
  })
})

describe('encodeOct', () => {
  it('maps the axes to the same bytes as pack.py', () => {
    expect(encodeOct([0, 0, 1])).toEqual([0, 0])
    expect(encodeOct([1, 0, 0])).toEqual([127, 0])
    expect(encodeOct([0, -1, 0])).toEqual([0, -127])
    expect(encodeOct([0, 0, -1])).toEqual([127, 127]) // the lower hemisphere folds to the corners
    expect(encodeOct([0, 0, 0])).toEqual([0, 0])
  })

  it('returns a PackError for a non-finite component rather than encoding garbage', () => {
    const bad = encodeOct([NaN, 0, 1])
    expect(PackError.is(bad)).toBe(true)
    expect(bad).toBeInstanceOf(Error)
    expect(PackError.is(encodeOct([0, Infinity, 1]))).toBe(true)
  })
})

describe('the round trip', () => {
  it('keeps every direction within one degree', () => {
    let seed = 7
    const rand = (): number => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1
    for (let k = 0; k < 500; k++) {
      const v: [number, number, number] = [rand(), rand(), rand()]
      const l = Math.hypot(...v)
      if (l < 1e-3) continue
      const n: [number, number, number] = [v[0] / l, v[1] / l, v[2] / l]
      const encoded = encodeOct(n)
      expect(PackError.is(encoded)).toBe(false)
      if (PackError.is(encoded)) return
      const [a, b] = encoded
      expect(Number.isInteger(a) && Math.abs(a) <= 127).toBe(true)
      expect(Number.isInteger(b) && Math.abs(b) <= 127).toBe(true)
      const d = decodeOct(a, b)
      const dot = n[0] * d[0] + n[1] * d[1] + n[2] * d[2]
      expect(dot).toBeGreaterThan(Math.cos(Math.PI / 180))
    }
  })

  it('decodes to a unit vector', () => {
    for (const [a, b] of [
      [0, 0],
      [127, 0],
      [0, -127],
      [127, 127],
      [-64, 33],
    ] as const) {
      expect(Math.abs(Math.hypot(...decodeOct(a, b)) - 1)).toBeLessThan(1e-12)
    }
  })
})
