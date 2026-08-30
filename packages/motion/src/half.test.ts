import { describe, expect, it } from 'vitest'

import { fromHalf, toHalf } from './half.js'

/** Verified against Python's `struct.pack('<e', v)` and against Float16Array. */
const VECTORS: readonly (readonly [number, number])[] = [
  [1, 0x3c00],
  [-2, 0xc000],
  [0, 0x0000],
  [-0, 0x8000],
  [0.5, 0x3800],
  [0.25, 0x3400],
  [0.1, 0x2e66],
  [-0.1, 0xae66],
  [1 / 3, 0x3555],
  [65504, 0x7bff], // the largest finite half
  [65520, 0x7c00], // rounds up, out of range, to infinity
  [2 ** -24, 0x0001], // the smallest subnormal
  [2 ** -25, 0x0000], // exactly halfway: ties-to-even goes to zero
  [1.5 * 2 ** -25, 0x0001], // past halfway: rounds up
  [1e-8, 0x0000],
  [Infinity, 0x7c00],
  [-Infinity, 0xfc00],
  [NaN, 0x7e00],
]

describe('toHalf', () => {
  it.each(VECTORS)('encodes %p as 0x%s', (value, bits) => {
    expect(toHalf(value)).toBe(bits)
  })

  it('rounds to nearest even, which is what makes it agree with Python', () => {
    // 0.7332500219345093 is the z component of the fixture's tilt normal.
    expect(toHalf(0.7332500219345093)).toBe(0x39de)
  })
})

describe('fromHalf', () => {
  it('inverts the exactly representable values', () => {
    expect(fromHalf(0x3c00)).toBe(1)
    expect(fromHalf(0x3800)).toBe(0.5)
    expect(fromHalf(0x7bff)).toBe(65504)
    expect(fromHalf(0x0001)).toBe(2 ** -24)
    expect(Object.is(fromHalf(0x8000), -0)).toBe(true)
    expect(fromHalf(0x7c00)).toBe(Infinity)
    expect(fromHalf(0xfc00)).toBe(-Infinity)
    expect(Number.isNaN(fromHalf(0x7e00))).toBe(true)
  })

  it('round-trips every finite half back to its own bits', () => {
    for (let bits = 0; bits <= 0xffff; bits++) {
      const value = fromHalf(bits)
      if (!Number.isFinite(value)) continue
      expect(toHalf(value)).toBe(bits)
    }
  })

  it('keeps a normalised sheet coordinate inside the precision decodeFrame relies on', () => {
    for (const v of [-1, -0.75, -0.5, -0.25, 0.25, 0.5, 0.75, 1]) {
      expect(Math.abs(fromHalf(toHalf(v)) - v)).toBeLessThanOrEqual(1e-3)
    }
  })
})

/**
 * An independent oracle where the runtime has one. Float16Array is ES2025 and absent from the
 * Node 22.18.0 lane, so this block skips there rather than pinning the suite to a floor the
 * package does not have.
 */
const f16 = (globalThis as { Float16Array?: new (n: number) => ArrayBufferView }).Float16Array
describe.skipIf(f16 === undefined)('agreement with the platform Float16Array', () => {
  it('encodes a spread of values to the same bits', () => {
    const array = new f16!(1)
    const bits = new Uint16Array(array.buffer)
    const write = (v: number): number => {
      ;(array as unknown as { [i: number]: number })[0] = v
      return bits[0]!
    }
    let seed = 11
    const rand = (): number => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 4 - 2
    for (let i = 0; i < 2000; i++) {
      const v = rand()
      expect(toHalf(v)).toBe(write(v))
    }
  })
})
