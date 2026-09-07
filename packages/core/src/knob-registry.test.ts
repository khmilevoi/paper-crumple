import { describe, expect, it } from 'vitest'
import { KnobError } from './errors.js'
import { FIXTURE_MOTION, FIXTURE_SHADOWING_SHEET, FIXTURE_SHEET } from './knob-fixtures.js'
import { SPRITE_SCOPE, VIEW_SCOPE } from './invalidation.js'
import { createKnobRegistry } from './knob-registry.js'

const registry = createKnobRegistry({ sheet: FIXTURE_SHEET, motion: FIXTURE_MOTION })

const paths = (key: string): readonly string[] => {
  const resolved = registry.resolve(key)
  expect(KnobError.is(resolved), `resolve(${key}) failed`).toBe(false)
  return (resolved as ReadonlyArray<{ path: string }>).map((t) => t.path)
}

const fails = (key: string): string => {
  const resolved = registry.resolve(key)
  expect(KnobError.is(resolved), `resolve(${key}) unexpectedly succeeded`).toBe(true)
  return (resolved as unknown as Error).message
}

describe('what a stage exposes', () => {
  it('lists core first, then each slot, for stage.knobs (§10.6)', () => {
    expect(registry.descriptors).toHaveLength(2 + FIXTURE_SHEET.length + FIXTURE_MOTION.length)
    expect(registry.descriptors.slice(0, 2).map((d) => d.key)).toEqual(['paperColor', 'paperBack'])
    expect(registry.bySlot.core.map((d) => d.key)).toEqual(['paperColor', 'paperBack'])
    expect(registry.bySlot.sheet).toEqual(FIXTURE_SHEET)
    expect(registry.bySlot.motion).toEqual(FIXTURE_MOTION)
  })
})

describe('resolution (§6.2)', () => {
  it('resolves a namespaced key always, which is the ground truth', () => {
    expect(paths('sheet.grain')).toEqual(['sheet.grain'])
    expect(paths('motion.grain')).toEqual(['motion.grain'])
  })

  it('resolves a unique bare key with no ceremony', () => {
    expect(paths('tearAmp')).toEqual(['sheet.tearAmp'])
    expect(paths('fillLight')).toEqual(['motion.fillLight'])
  })

  it('returns a KnobError for an ambiguous bare key, for the untyped caller', () => {
    // A TypeScript consumer cannot write this at all (amendment 18). A JavaScript one, and the
    // descriptor loop of §6.1 that writes stage.set({ [k.key]: v }), still can.
    const message = fails('grain')
    expect(message).toContain('ambiguous')
    expect(message).toContain('sheet.grain')
    expect(message).toContain('motion.grain')
    expect(fails('debug')).toContain('ambiguous')
  })

  it('names the exact ambiguity set the type tier excludes', () => {
    expect([...registry.ambiguous].sort()).toEqual(['debug', 'grain'])
  })

  it('rejects an unknown key and an unknown namespace', () => {
    expect(fails('nope')).toContain('unknown knob')
    expect(fails('sheet.nope')).toContain('unknown knob')
    expect(fails('paper.grain')).toContain('unknown knob namespace')
  })
})

describe('binding (§6.2)', () => {
  it('writes a shared key to core and to every descriptor bound to it', () => {
    expect(paths('paperColor')).toEqual([
      'core.paperColor',
      'sheet.paperColor',
      'motion.paperColor',
    ])
    expect(paths('paperBack')).toEqual(['core.paperBack'])
  })

  it('refuses a bound descriptor addressed namespaced, and says what to set instead', () => {
    const message = fails('sheet.paperColor')
    expect(message).toContain('paperColor')
    expect(message).toContain('bound')
  })

  it('keeps the shared key bare when a slot shadows it, and namespaces the slot key', () => {
    const shadowed = createKnobRegistry({
      sheet: FIXTURE_SHADOWING_SHEET,
      motion: FIXTURE_MOTION,
    })
    const shared = shadowed.resolve('paperColor')
    expect((shared as ReadonlyArray<{ path: string }>).map((t) => t.path)).toEqual([
      'core.paperColor',
      'motion.paperColor',
    ])
    const own = shadowed.resolve('sheet.paperColor')
    expect((own as ReadonlyArray<{ path: string }>).map((t) => t.path)).toEqual([
      'sheet.paperColor',
    ])
    expect([...shadowed.ambiguous]).toContain('paperColor')
  })
})

describe('normalise (§6.6)', () => {
  it('turns a bare patch into namespaced ground truth', () => {
    expect(registry.normalise({ tearAmp: 44, 'motion.grain': 0.2 }, SPRITE_SCOPE)).toEqual({
      'sheet.tearAmp': 44,
      'motion.grain': 0.2,
    })
  })

  it('expands a shared key across every bound descriptor', () => {
    expect(registry.normalise({ paperColor: '#123456' }, SPRITE_SCOPE)).toEqual({
      'core.paperColor': '#123456',
      'sheet.paperColor': '#123456',
      'motion.paperColor': '#123456',
    })
  })

  it('rejects an out-of-range value, which no type can bound', () => {
    const err = registry.normalise({ tearAmp: 900 }, SPRITE_SCOPE)
    expect(KnobError.is(err)).toBe(true)
    expect((err as unknown as Error).message).toContain('out of range')
  })

  it('rejects a front-class knob on a draw-class scope, for the untyped caller', () => {
    const err = registry.normalise({ tearAmp: 52 }, VIEW_SCOPE)
    expect(KnobError.is(err)).toBe(true)
    expect((err as unknown as Error).message).toContain('front')
  })

  it('accepts a draw-class knob on a sprite, because the resolution order says so (§6.6)', () => {
    expect(registry.normalise({ ambient: 0.5 }, SPRITE_SCOPE)).toEqual({ 'sheet.ambient': 0.5 })
  })

  it('accepts a draw-class knob on a view', () => {
    expect(registry.normalise({ ambient: 0.45 }, VIEW_SCOPE)).toEqual({ 'sheet.ambient': 0.45 })
  })

  it('returns the first fault and stops, so one bad key does not half-apply a patch', () => {
    const err = registry.normalise({ tearAmp: 900, ambient: 0.5 }, SPRITE_SCOPE)
    expect(KnobError.is(err)).toBe(true)
  })

  it('never fails on a name at mount — construction takes any pair of slots', () => {
    expect(() => createKnobRegistry({ sheet: FIXTURE_SHEET, motion: FIXTURE_SHEET })).not.toThrow()
  })
})
