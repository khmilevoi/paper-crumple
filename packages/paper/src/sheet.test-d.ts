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
import { COMMON_KNOBS, SMOOTH_KNOBS, VARIANCE_KNOB, WIDTH_PX_KNOB } from './paper-knobs.js'

describe('paperSheet satisfies the sheet slot (spec 5.2)', () => {
  it('is assignable to SheetRenderer', () => {
    expectTypeOf(paperSheet()).toMatchTypeOf<SheetRenderer>()
    expectTypeOf(
      paperSheet({ edgeShape: 'none', edgeFinish: 'paper' }),
    ).toMatchTypeOf<SheetRenderer>()
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

describe("a smooth factory's descriptor tuple excludes the torn-only keys (spec 11)", () => {
  // `descriptorsFor({ shape: 'smooth', finish: 'clean', widthUnit: 'px' })` (paper-knobs.ts) is
  // `[...COMMON_KNOBS, width, variance, ...SMOOTH_KNOBS, SDF_RES_KNOB]` — reconstructed here at
  // the type level, minus `SDF_RES_KNOB`, so the check is a genuine type-level assertion rather
  // than a runtime scan. `SDF_RES_KNOB` is excluded on purpose: it carries an explicit
  // `: KnobDescriptor` annotation (paper-knobs.ts), which widens its own `key` to plain `string`
  // and would make `KnobsOf` accept every string key, including `tearFreq` — defeating this exact
  // assertion. Its own key is `'sdfRes'`, never `'tearFreq'`, so dropping it changes nothing
  // about what this test claims. `WIDTH_PX_KNOB` and `VARIANCE_KNOB` lost their own
  // `: KnobDescriptor` annotations for the same reason (ruling R5); `descriptorsFor` attaches
  // `invalidates` when it composes the array, which does not change either key.
  type Hull<T> = T & { readonly invalidates: 'hull' }
  type SmoothDescriptors = readonly [
    ...typeof COMMON_KNOBS,
    Hull<typeof WIDTH_PX_KNOB>,
    Hull<typeof VARIANCE_KNOB>,
    ...typeof SMOOTH_KNOBS,
  ]
  type SmoothKnobBag = KnobsOf<SmoothDescriptors>

  it('has no tearFreq — a smooth stage exposes no torn-only knob', () => {
    expectTypeOf<SmoothKnobBag>().not.toHaveProperty('tearFreq')
  })

  // design 2026-09-05 §2.2: `tearAmp` and `midAmp` ceased to be knobs in EVERY cell — they are
  // derived from the width and the variance by `tearAmpsFor`, never set.
  it('has no tearAmp, which is no longer a knob in any cell', () => {
    expectTypeOf<SmoothKnobBag>().not.toHaveProperty('tearAmp')
  })
})
