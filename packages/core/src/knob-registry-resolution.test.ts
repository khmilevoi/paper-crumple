import { describe, expect, it } from 'vitest'
import { KnobError } from './errors.js'
import { FIXTURE_MOTION, FIXTURE_SHEET } from './knob-fixtures.js'
import { SPRITE_SCOPE } from './invalidation.js'
import { createKnobRegistry, resolveKnobValues } from './knob-registry.js'
import type { KnobValues } from './knob-registry.js'

const registry = createKnobRegistry({ sheet: FIXTURE_SHEET, motion: FIXTURE_MOTION })

/** `normalise` returns `KnobValues | KnobError`; every call below is a patch known to be valid. */
const delta = (patch: Readonly<Record<string, unknown>>): KnobValues => {
  const result = registry.normalise(patch, SPRITE_SCOPE)
  expect(KnobError.is(result), `normalise(${JSON.stringify(patch)}) failed`).toBe(false)
  return result as KnobValues
}

describe('defaults', () => {
  it('names every descriptor under its own namespaced path', () => {
    const d = registry.defaults()
    expect(d['core.paperColor']).toBe('#f7f4ed')
    expect(d['core.paperBack']).toBe('#e8e2d4')
    expect(d['sheet.grain']).toBe(0.09)
    expect(d['motion.grain']).toBe(0.18)
    expect(d['sheet.tearAmp']).toBe(30)
    expect(Object.keys(d)).toHaveLength(2 + FIXTURE_SHEET.length + FIXTURE_MOTION.length)
  })

  it('lets a bound descriptor keep its own default until the shared key is set', () => {
    // "core defaults -> slot defaults": the slot ships its own, and setting the shared key is
    // what makes both slots identical from then on.
    const d = registry.defaults()
    expect(d['sheet.paperColor']).toBe('#f7f4ed')
    expect(d['motion.paperColor']).toBe('#f7f4ed')
  })
})

describe('the resolution order (§6.6)', () => {
  it('layers core defaults, slot defaults, sprite, then view — later wins', () => {
    const resolved = resolveKnobValues([
      registry.defaults(),
      delta({ ambient: 0.5, tearAmp: 52 }),
      delta({ ambient: 0.7 }),
    ])
    expect(resolved['sheet.ambient']).toBe(0.7)
    expect(resolved['sheet.tearAmp']).toBe(52)
    expect(resolved['sheet.grain']).toBe(0.09)
  })
})

describe('the per-slot filtered bag (§5.5)', () => {
  const project = registry.projector('sheet')
  const values = registry.defaults()

  it('gives a slot its own keys plus the core-declared shared ones, bare', () => {
    const bag = project(values)
    expect(Object.keys(bag).sort()).toEqual(
      [
        'ambient',
        'angularity',
        'debug',
        'grain',
        'paperBack',
        'paperColor',
        'sdfRes',
        'tearAmp',
      ].sort(),
    )
    expect(bag.grain).toBe(0.09)
  })

  it('never lets one slot see the other slot keys', () => {
    const bag = project(values)
    expect(bag.fillLight).toBeUndefined()
    expect(bag.shadow).toBeUndefined()
    expect(registry.projector('motion')(values).tearAmp).toBeUndefined()
  })

  it('lets a slot default override a core default on the same key', () => {
    const bag = registry.projector('motion')(values)
    expect(bag.paperColor).toBe('#f7f4ed')
  })

  it('returns a fresh object per call, so a slot that retains one cannot be aliased', () => {
    const a = project(values)
    const b = project(values)
    expect(a).not.toBe(b)
    expect(a).toEqual(b)
  })

  it('reflects a later value without being rebuilt', () => {
    const changed = resolveKnobValues([values, { 'sheet.grain': 0.4 }])
    expect(project(changed).grain).toBe(0.4)
  })
})

describe('invalidationOf', () => {
  it('takes the strongest level a delta touches', () => {
    expect(registry.invalidationOf({ 'sheet.ambient': 0.5 })).toBe('draw')
    expect(registry.invalidationOf({ 'sheet.ambient': 0.5, 'sheet.tearAmp': 40 })).toBe('front')
    expect(registry.invalidationOf({ 'sheet.angularity': 0.6 })).toBe('hull')
    expect(registry.invalidationOf({ 'sheet.sdfRes': 256, 'sheet.ambient': 0.5 })).toBe('field')
  })

  it('is undefined for an empty delta, so P9 can skip the rebuild queue entirely', () => {
    expect(registry.invalidationOf({})).toBeUndefined()
  })

  it('ignores a path no descriptor owns rather than guessing a level', () => {
    expect(registry.invalidationOf({ 'sheet.nope': 1 })).toBeUndefined()
  })
})
