/**
 * # `stage.defaults` (spec §3.4)
 *
 * `stage.knobs` is `readonly KnobDescriptor[]` with slot-local keys and no path, so a consumer
 * holding a knob key has no way to ask what its default was — which is why the React binding
 * could only ever write the keys it was already given and could not reset one. The knob registry
 * has held a frozen, namespaced default map since mount; this pins that the stage hands it out.
 *
 * The identity pin is load-bearing, not decorative: the binding uses `stage.defaults` as an
 * effect dependency, and a fresh object per read would rerun that effect on every render.
 */
import { describe, expect, expectTypeOf, it } from 'vitest'
import { isAborted } from './abort.js'
import { createStage } from './stage.js'
import type { StageOptions } from './stage-types.js'
import type { KnobPrimitive, KnobValues } from './knob-registry.js'
import { fakeMotion, fakeSheet, stageEnv } from './testing/fake-slots.js'

const base = (): StageOptions => ({ sheet: fakeSheet(), motion: fakeMotion(), maxSize: 384 })

// `createStage` answers `BlitStage | Error | Aborted`; both refusals have to be narrowed away
// before the stage is usable, exactly as every existing stage test does it.
async function blitStage() {
  const stage = await createStage({ ...base(), present: 'blit' }, stageEnv())
  if (stage instanceof Error || isAborted(stage)) return expect.fail('stage refused')
  return stage
}

describe('stage.defaults', () => {
  it('is the registry’s frozen map, handed out by identity rather than rebuilt per read', async () => {
    const stage = await blitStage()
    expect(Object.isFrozen(stage.defaults)).toBe(true)
    // Two reads, one object. A getter that called `registry.defaults()` per read would also be
    // frozen and would still fail this, which is the point.
    expect(stage.defaults).toBe(stage.defaults)
    stage.dispose()
  })

  it('names every entry under a namespaced path, with a primitive value', async () => {
    const stage = await blitStage()
    const entries = Object.entries(stage.defaults)
    // The shared knobs are registered by every stage, so the map is never empty.
    expect(entries.length).toBeGreaterThan(0)
    expect(stage.defaults['core.paperColor']).toBe('#f7f4ed')
    expect(stage.defaults['core.paperBack']).toBe('#e8e2d4')
    for (const [path, value] of entries) {
      // `<slot>.<key>` — never the bare, slot-local key `stage.knobs` carries.
      expect(path).toContain('.')
      expect(['string', 'number', 'boolean']).toContain(typeof value)
    }
    stage.dispose()
  })

  it('every default is a value stage.set accepts, and an undeclared key is undefined', async () => {
    const stage = await blitStage()
    for (const [path, value] of Object.entries(stage.defaults)) {
      // The exact call the React binding makes when it writes a key back to its default. A
      // slot-scoped default is written under its own namespaced path; a core-declared shared knob
      // is written under its BARE key, because setting the bare key is what writes core's
      // descriptor and every descriptor that binds it at once, which is what keeps the 2D sheet
      // and the 3D fill identical by construction (§6.8).
      // The `core.` test is sufficient here only because `fakeSheet`/`fakeMotion` declare no
      // `binds`; a bound descriptor's namespaced path is refused too, and is written by its
      // `binds` key.
      // `as never` matches how the implementation and the existing knob tests call `set` — the
      // flat patch type collapses at the widest slot instantiation, and `registry.normalise` is
      // the enforcement that runs.
      const writable = path.startsWith('core.') ? path.slice('core.'.length) : path
      expect(stage.set({ [writable]: value } as never)).toBeUndefined()
    }
    expect(stage.defaults['nope.notAKnob']).toBeUndefined()
    stage.dispose()
  })

  it('refuses a core-scoped default under its namespaced path, and takes the bare key instead', async () => {
    const stage = await blitStage()
    // `resolve` accepts only the `sheet.` and `motion.` namespaces (knob-registry.ts:117-125), so
    // the two core-declared shared knobs are addressable by path in `defaults` but not in `set`.
    // Pinned rather than papered over: this is the one place where `defaults`' spelling and
    // `set`'s spelling differ, and a consumer writing a default back has to know it.
    const refused = stage.set({ 'core.paperColor': stage.defaults['core.paperColor'] } as never)
    expect(refused).toBeInstanceOf(Error)
    expect((refused as Error).message).toContain("unknown knob namespace 'core'")
    // The bare key is the accepted spelling for the very same knob, and it writes every bound
    // descriptor at once.
    expect(stage.set({ paperColor: stage.defaults['core.paperColor'] } as never)).toBeUndefined()
    stage.dispose()
  })

  it('is typed as the registry’s KnobValues', async () => {
    const stage = await blitStage()
    expectTypeOf(stage.defaults).toEqualTypeOf<KnobValues>()
    expectTypeOf<KnobValues[string]>().toEqualTypeOf<KnobPrimitive>()
    expectTypeOf<KnobPrimitive>().toEqualTypeOf<string | number | boolean>()
    stage.dispose()
  })
})
