import { expectTypeOf, test } from 'vitest'
import type { Hex } from './knobs.js'
import type { FIXTURE_MOTION, FIXTURE_SHADOWING_SHEET, FIXTURE_SHEET } from './knob-fixtures.js'
import type {
  AmbiguousKeys,
  KnobPatch,
  KnobSetter,
  SpriteKnobPatch,
  ViewKnobPatch,
} from './knob-patch.js'

type S = typeof FIXTURE_SHEET
type M = typeof FIXTURE_MOTION
type Patch = KnobPatch<S, M>
type ViewPatch = ViewKnobPatch<S, M>
type SpritePatch = SpriteKnobPatch<S, M>

type Has<P, K extends string> = K extends keyof P ? true : false

test('an ambiguous flat key is not a member of the patch type (amendment 18)', () => {
  expectTypeOf<AmbiguousKeys<S, M>>().toEqualTypeOf<'grain' | 'debug'>()
  expectTypeOf<Has<Patch, 'grain'>>().toEqualTypeOf<false>()
  expectTypeOf<Has<Patch, 'debug'>>().toEqualTypeOf<false>()
})

test('the ambiguous remainder stays reachable namespaced, which is the ground truth', () => {
  expectTypeOf<Patch['sheet.grain']>().toEqualTypeOf<number>()
  expectTypeOf<Patch['motion.grain']>().toEqualTypeOf<number>()
  expectTypeOf<Patch['sheet.debug']>().toEqualTypeOf<'off' | 'sdf' | 'hull'>()
  expectTypeOf<Patch['motion.debug']>().toEqualTypeOf<'off' | 'normals' | 'depth'>()
})

test('a unique bare key resolves with no ceremony', () => {
  expectTypeOf<Patch['tearAmp']>().toEqualTypeOf<number>()
  expectTypeOf<Patch['sdfRes']>().toEqualTypeOf<number>()
  expectTypeOf<Patch['ambient']>().toEqualTypeOf<number>()
  expectTypeOf<Patch['fillLight']>().toEqualTypeOf<number>()
  expectTypeOf<Patch['shadow']>().toEqualTypeOf<boolean>()
})

test('a core-declared shared knob is bare, and its bound copies are not namespaced', () => {
  expectTypeOf<Patch['paperColor']>().toEqualTypeOf<Hex>()
  expectTypeOf<Patch['paperBack']>().toEqualTypeOf<Hex>()
  expectTypeOf<Has<Patch, 'sheet.paperColor'>>().toEqualTypeOf<false>()
  expectTypeOf<Has<Patch, 'motion.paperColor'>>().toEqualTypeOf<false>()
})

test('a slot key that shadows a core shared key is reachable only namespaced', () => {
  type Shadow = KnobPatch<typeof FIXTURE_SHADOWING_SHEET, M>
  // The shared knob keeps the bare key — stage.set({ paperColor }) is the design's own example.
  expectTypeOf<Shadow['paperColor']>().toEqualTypeOf<Hex>()
  expectTypeOf<Shadow['sheet.paperColor']>().toEqualTypeOf<Hex>()
})

test('a front-class knob is not assignable to View.set (amendment 20)', () => {
  expectTypeOf<Has<ViewPatch, 'tearAmp'>>().toEqualTypeOf<false>()
  expectTypeOf<Has<ViewPatch, 'sdfRes'>>().toEqualTypeOf<false>()
  expectTypeOf<Has<ViewPatch, 'paperColor'>>().toEqualTypeOf<false>()
  expectTypeOf<ViewPatch['ambient']>().toEqualTypeOf<number>()
  expectTypeOf<ViewPatch['fillLight']>().toEqualTypeOf<number>()
})

test('a sprite takes the whole ladder, draw class included (§6.6, resolved)', () => {
  expectTypeOf<SpritePatch['tearAmp']>().toEqualTypeOf<number>()
  expectTypeOf<SpritePatch['ambient']>().toEqualTypeOf<number>()
  expectTypeOf<SpritePatch['paperColor']>().toEqualTypeOf<Hex>()
  expectTypeOf<SpritePatch>().toEqualTypeOf<Patch>()
})

declare const set: KnobSetter<Patch>
declare const viewSet: KnobSetter<ViewPatch>

test('set() returns KnobError | undefined, so `if (err)` narrows and the result is storable', () => {
  const err = set({ tearAmp: 44 })
  expectTypeOf(err).toEqualTypeOf<
    InstanceType<typeof import('./errors.js').KnobError> | undefined
  >()
})

test('a typo is rejected in an object literal', () => {
  // @ts-expect-error — 'ambiant' is not a knob; the compiler suggests 'ambient'
  set({ ambiant: 0.5 })
})

test('a typo is rejected in a patch built in a variable, which is amendment 19', () => {
  const preset = { tearAmp: 44, ambiant: 0.5 }
  // @ts-expect-error — the generic captures the argument's own type, so the excess key is caught
  set(preset)
})

test('a correct patch built in a variable is accepted, because presets are the normal case', () => {
  const preset = { tearAmp: 44, ambient: 0.3 }
  expectTypeOf(set(preset)).not.toBeNever()
})

test('a wrong value type is rejected in both positions', () => {
  // @ts-expect-error — tearAmp is a number
  set({ tearAmp: 'wide' })
  const preset = { tearAmp: 'wide' }
  // @ts-expect-error — same, from a variable
  set(preset)
})

test('an ambiguous bare key cannot even be written from TypeScript', () => {
  // @ts-expect-error — 'grain' is declared by sheet and motion, so it is not in the union
  set({ grain: 0.2 })
})

test('a front-class knob on a view does not compile', () => {
  // @ts-expect-error — tearAmp is front-class and a view is a draw-class scope
  viewSet({ tearAmp: 52 })
})
