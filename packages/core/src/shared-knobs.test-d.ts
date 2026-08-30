import { expectTypeOf, test } from 'vitest'
import type { Hex, Knobs, SharedKnob } from './knobs.js'
import type { MotionKnobs, SharedKnobs, SheetKnobs } from './shared-knobs.js'

test('SharedKnob and the generated bag name the same two knobs', () => {
  expectTypeOf<keyof SharedKnobs>().toEqualTypeOf<SharedKnob>()
  expectTypeOf<SharedKnobs['paperColor']>().toEqualTypeOf<Hex>()
  expectTypeOf<SharedKnobs['paperBack']>().toEqualTypeOf<Hex>()
})

test('a slot sees its own knobs plus the shared ones, and never the other slot (§5.5)', () => {
  interface SheetOwn extends Knobs {
    readonly grain: number
    readonly tearAmp: number
  }
  interface MotionOwn extends Knobs {
    readonly fillLight: number
  }
  expectTypeOf<SheetKnobs<SheetOwn>['grain']>().toEqualTypeOf<number>()
  expectTypeOf<SheetKnobs<SheetOwn>['paperColor']>().toEqualTypeOf<Hex>()
  expectTypeOf<MotionKnobs<MotionOwn>['fillLight']>().toEqualTypeOf<number>()
  expectTypeOf<MotionKnobs<MotionOwn>['paperBack']>().toEqualTypeOf<Hex>()
})
