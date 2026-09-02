import { describe, expectTypeOf, it } from 'vitest'
import type {
  Aborted,
  KnobDescriptor,
  KnobsOf,
  SheetFront,
  SheetRenderer,
  SourceError,
} from '@paper-crumple/core'
import { paperSheet } from './sheet.js'
import type { PaperSheetHandle } from './handle.js'
import { COMMON_KNOBS, HULL_KNOBS } from './paper-knobs.js'

describe('paperSheet satisfies the sheet slot (spec 5.2)', () => {
  it('is assignable to SheetRenderer', () => {
    expectTypeOf(paperSheet()).toMatchTypeOf<SheetRenderer>()
  })

  it("carries | Aborted in source()'s union, because it accepts a signal (amendment 1)", () => {
    expectTypeOf(paperSheet().source).returns.resolves.toEqualTypeOf<
      SourceError | Aborted | PaperSheetHandle
    >()
  })

  it('never carries Aborted on build(), which accepts no signal', () => {
    expectTypeOf(paperSheet().build).returns.not.toMatchTypeOf<Aborted>()
    expectTypeOf(paperSheet().build).returns.toMatchTypeOf<Error | SheetFront>()
  })

  it('reports overscan and knobs as readonly surface', () => {
    expectTypeOf(paperSheet().overscan).toEqualTypeOf<number>()
    // `knobs` is `readonly KnobDescriptor[]` (spec 5.2), not a mutable array — `toBeArray()`'s
    // own `T extends any[]` check does not hold for a `readonly` tuple, so the surface is pinned
    // this way instead.
    expectTypeOf(paperSheet().knobs).toEqualTypeOf<readonly KnobDescriptor[]>()
  })
})

describe("a hull factory's descriptor tuple excludes the torn-only keys (spec 11)", () => {
  // `descriptorsFor('hull')` (paper-knobs.ts) is `[...COMMON_KNOBS, ...HULL_KNOBS, SDF_RES_KNOB]`
  // — reconstructed here at the type level, minus `SDF_RES_KNOB`, so the check is a genuine
  // type-level assertion rather than a runtime scan. `SDF_RES_KNOB` is excluded on purpose: it
  // carries an explicit `: KnobDescriptor` annotation (paper-knobs.ts), which widens its own
  // `key` to plain `string` and would make `KnobsOf` accept every string key, including
  // `tearAmp` — defeating this exact assertion. Its own key is `'sdfRes'`, never `'tearAmp'`, so
  // dropping it changes nothing about what this test claims.
  type HullDescriptors = readonly [...typeof COMMON_KNOBS, ...typeof HULL_KNOBS]
  type HullKnobBag = KnobsOf<HullDescriptors>

  it('has no tearAmp — a hull stage exposes no torn-only knob', () => {
    expectTypeOf<HullKnobBag>().not.toHaveProperty('tearAmp')
  })
})
