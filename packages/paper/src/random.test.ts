import { describe, expect, it } from 'vitest'
import { makeRandom, noise1d } from './random.js'

describe('makeRandom', () => {
  it('is deterministic in the seed, so a given seed always builds the same outline', () => {
    const a = makeRandom(3)
    const b = makeRandom(3)
    const first = Array.from({ length: 16 }, () => a())
    const second = Array.from({ length: 16 }, () => b())
    expect(first).toEqual(second)
  })

  it('gives a different sequence for a different seed', () => {
    const a = makeRandom(3)
    const b = makeRandom(4)
    expect(Array.from({ length: 16 }, () => a())).not.toEqual(Array.from({ length: 16 }, () => b()))
  })

  it('floors the seed, so 3 and 3.9 are the same outline', () => {
    const a = makeRandom(3)
    const b = makeRandom(3.9)
    expect(Array.from({ length: 8 }, () => a())).toEqual(Array.from({ length: 8 }, () => b()))
  })

  it('stays in [0, 1) and does not degenerate', () => {
    const r = makeRandom(7)
    let sum = 0
    for (let i = 0; i < 2000; i++) {
      const v = r()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
      sum += v
    }
    expect(sum / 2000).toBeGreaterThan(0.45)
    expect(sum / 2000).toBeLessThan(0.55)
  })
})

describe('noise1d', () => {
  it('is deterministic and stays in [0, 1]', () => {
    for (const u of [0, 0.25, 1.75, 12.5, -3.25]) {
      const v = noise1d(u, 5)
      expect(v).toBe(noise1d(u, 5))
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
    }
  })

  it('is the mean of its two lattice values at the halfway point, because smoothstep(0.5) = 0.5', () => {
    expect(noise1d(2.5, 5)).toBeCloseTo((noise1d(2, 5) + noise1d(3, 5)) / 2, 10)
  })

  it('is continuous: a small step in u is a small step in the value', () => {
    let previous = noise1d(0, 11)
    for (let u = 0.01; u <= 4; u += 0.01) {
      const v = noise1d(u, 11)
      expect(Math.abs(v - previous)).toBeLessThan(0.05)
      previous = v
    }
  })

  it('varies with the seed', () => {
    expect(noise1d(1.5, 5)).not.toBe(noise1d(1.5, 6))
  })
})
