import { describe, expect, it } from 'vitest'
import type { KnobDescriptor } from '@paper-crumple/core'
import {
  COMMON_KNOBS,
  descriptorsFor,
  defaultsFor,
  edgeParamsFrom,
  HULL_KNOBS,
  resolveSdfRes,
  SDF_RES_KNOB,
  TORN_KNOBS,
} from './paper-knobs.js'

const keysOf = (d: readonly KnobDescriptor[]): string[] => d.map((k) => k.key).sort()

describe('the descriptor split (spec 6.7)', () => {
  it('is 20 common, 3 hull-only and 13 torn-only, plus sdfRes', () => {
    expect(COMMON_KNOBS).toHaveLength(20)
    expect(HULL_KNOBS).toHaveLength(3)
    expect(TORN_KNOBS).toHaveLength(13)
    expect(SDF_RES_KNOB.key).toBe('sdfRes')
  })

  it('declares no key twice', () => {
    const all = keysOf([...COMMON_KNOBS, ...HULL_KNOBS, ...TORN_KNOBS, SDF_RES_KNOB])
    expect(new Set(all).size).toBe(all.length)
  })

  it('never re-declares a core-owned shared knob (spec 6.2, 6.7)', () => {
    const all = keysOf([...COMMON_KNOBS, ...HULL_KNOBS, ...TORN_KNOBS])
    expect(all).not.toContain('paperColor')
    expect(all).not.toContain('paperBack')
  })

  it('never declares edgeMode, preset, pose or crumpleFill', () => {
    const all = keysOf([...COMMON_KNOBS, ...HULL_KNOBS, ...TORN_KNOBS, SDF_RES_KNOB])
    for (const excluded of ['edgeMode', 'preset', 'pose', 'crumpleFill']) {
      expect(all).not.toContain(excluded)
    }
  })

  it('binds nothing, because grain is ambiguous and not shared (spec 6.2)', () => {
    const all = [...COMMON_KNOBS, ...HULL_KNOBS, ...TORN_KNOBS, SDF_RES_KNOB]
    expect(all.filter((k) => k.binds !== undefined)).toEqual([])
  })
})

describe('edgeMode as a factory option (spec 6.5)', () => {
  it('hides the 13 torn-only descriptors from a hull factory', () => {
    const hull = keysOf(descriptorsFor('hull'))
    expect(hull).toHaveLength(24)
    expect(hull).not.toContain('tearAmp')
    expect(hull).toContain('maxDist')
  })

  it('hides the 3 hull-only descriptors from a torn factory', () => {
    const torn = keysOf(descriptorsFor('torn'))
    expect(torn).toHaveLength(34)
    expect(torn).not.toContain('maxDist')
    expect(torn).toContain('tearAmp')
  })

  it("exposes both sets for 'both', which is edge.js's third front mode", () => {
    expect(descriptorsFor('both')).toHaveLength(37)
  })
})

describe('the shipped defaults reproduce DEFAULT_PARAMS', () => {
  it('carries the spike values a reader can check against paper.js:2027', () => {
    const d = defaultsFor('both')
    expect(d.maxDist).toBe(72)
    expect(d.minDist).toBe(22)
    expect(d.angularity).toBe(0.7)
    expect(d.tearAmp).toBe(44)
    expect(d.thickness).toBe(22)
    expect(d.looseness).toBe(0.5)
    expect(d.grain).toBe(0.09)
    expect(d.seed).toBe(3)
    expect(d.photoFibre).toBe(0.8)
    expect(d.debug).toBe(0)
  })
})

describe('reference: sprite-px marks every px-valued knob (spec 6.4)', () => {
  it('marks exactly the ten px knobs', () => {
    const marked = [...COMMON_KNOBS, ...HULL_KNOBS, ...TORN_KNOBS]
      .filter((k) => k.kind === 'number' && k.reference === 'sprite-px')
      .map((k) => k.key)
      .sort()
    expect(marked).toEqual(
      [
        'chew',
        'creaseWidth',
        'deckleWidth',
        'fiberLen',
        'maxDist',
        'midAmp',
        'minDist',
        'shadowBlur',
        'tearAmp',
        'thickness',
      ].sort(),
    )
  })
})

describe('the invalidation ladder (spec 6.3, 6.6)', () => {
  it("puts seed at 'hull', because ensureHull keys its cache on it", () => {
    expect(HULL_KNOBS.every((k) => k.invalidates === 'hull')).toBe(true)
    expect(COMMON_KNOBS.find((k) => k.key === 'seed')?.invalidates).toBe('hull')
  })

  it("puts looseness and sdfRes at 'field', and nothing else", () => {
    const field = [...COMMON_KNOBS, ...HULL_KNOBS, ...TORN_KNOBS, SDF_RES_KNOB]
      .filter((k) => k.invalidates === 'field')
      .map((k) => k.key)
      .sort()
    expect(field).toEqual(['looseness', 'sdfRes'])
  })

  it('declares no draw-class knob, because a sheet only ever builds a front', () => {
    const all = [...COMMON_KNOBS, ...HULL_KNOBS, ...TORN_KNOBS, SDF_RES_KNOB]
    expect(all.filter((k) => k.invalidates === 'draw')).toEqual([])
  })
})

describe('resolveSdfRes (spec 7.4.3)', () => {
  it('derives from the front long side when the knob is 0', () => {
    expect(resolveSdfRes(0, 384)).toBe(192)
    expect(resolveSdfRes(0, 998)).toBe(512)
    expect(resolveSdfRes(0, 64)).toBe(128)
  })

  it('quantises and clamps an explicit override', () => {
    expect(resolveSdfRes(300, 384)).toBe(320)
    expect(resolveSdfRes(64, 384)).toBe(128)
    expect(resolveSdfRes(9999, 384)).toBe(512)
  })
})

describe('edgeParamsFrom feeds core overscanFor (spec 8.6)', () => {
  it("reports mode 'hull' with only maxDist live", () => {
    const p = edgeParamsFrom('hull', defaultsFor('hull'))
    expect(p.mode).toBe('hull')
    expect(p.maxDist).toBe(72)
  })

  it('carries every torn margin consumer through', () => {
    const p = edgeParamsFrom('torn', defaultsFor('torn'))
    expect(p).toMatchObject({
      mode: 'torn',
      thickness: 22,
      looseness: 0.5,
      tearAmp: 44,
      midAmp: 26,
      fiberLen: 4,
    })
  })
})
