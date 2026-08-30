import { describe, expect, it } from 'vitest'
import { KnobError } from './errors.js'
import { hexToRgb, isHex } from './color.js'

describe('isHex', () => {
  it('accepts the three- and six-digit forms in either case', () => {
    expect(isHex('#fff')).toBe(true)
    expect(isHex('#F7F4ED')).toBe(true)
    expect(isHex('#f7f4ed')).toBe(true)
  })

  it('rejects everything else, which is the point (§6.1)', () => {
    for (const bad of ['not a colour', '#gggggg', '#f7f4e', 'f7f4ed', '#f7f4edff', '', 7, null]) {
      expect(isHex(bad), `accepted ${JSON.stringify(bad)}`).toBe(false)
    }
  })
})

describe('hexToRgb', () => {
  it('normalises to 0..1, which is what a vec3 uniform takes', () => {
    expect(hexToRgb('#000000')).toEqual([0, 0, 0])
    expect(hexToRgb('#ffffff')).toEqual([1, 1, 1])
    const [r, g, b] = hexToRgb('#f7f4ed') as readonly [number, number, number]
    expect(r).toBeCloseTo(247 / 255, 10)
    expect(g).toBeCloseTo(244 / 255, 10)
    expect(b).toBeCloseTo(237 / 255, 10)
  })

  it('expands the three-digit form', () => {
    expect(hexToRgb('#fff')).toEqual(hexToRgb('#ffffff'))
    expect(hexToRgb('#0f0')).toEqual(hexToRgb('#00ff00'))
  })

  it('returns a KnobError rather than [NaN, NaN, NaN] (§6.1)', () => {
    const err = hexToRgb('not a colour')
    expect(KnobError.is(err)).toBe(true)
    expect((err as Error).message).toContain('not a colour')
  })
})
