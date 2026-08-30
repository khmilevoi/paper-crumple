import { expectTypeOf, test } from 'vitest'
import { enumKnob, knobs } from './knobs.js'
import type { Hex } from './knobs.js'
import type { KnobValue, KnobsAt, KnobsOf } from './knob-types.js'

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const D = knobs([
  { key: 'ambient', kind: 'number', invalidates: 'draw', default: 0.35, min: 0, max: 1 },
  { key: 'seed', kind: 'int', invalidates: 'hull', default: 1, min: 0, max: 65535 },
  { key: 'shadow', kind: 'bool', invalidates: 'draw', default: true },
  { key: 'tint', kind: 'color', invalidates: 'front', default: '#f7f4ed' },
  enumKnob({ key: 'debug', invalidates: 'draw', values: ['off', 'normals'], default: 'off' }),
])

test('KnobValue maps each kind to the value set the validator enforces (§6.8)', () => {
  expectTypeOf<KnobValue<(typeof D)[0]>>().toEqualTypeOf<number>()
  expectTypeOf<KnobValue<(typeof D)[1]>>().toEqualTypeOf<number>()
  expectTypeOf<KnobValue<(typeof D)[2]>>().toEqualTypeOf<boolean>()
  expectTypeOf<KnobValue<(typeof D)[3]>>().toEqualTypeOf<Hex>()
  expectTypeOf<KnobValue<(typeof D)[4]>>().toEqualTypeOf<'off' | 'normals'>()
})

test('KnobsOf keys the bag by the descriptor keys', () => {
  expectTypeOf<keyof KnobsOf<typeof D>>().toEqualTypeOf<
    'ambient' | 'seed' | 'shadow' | 'tint' | 'debug'
  >()
  expectTypeOf<KnobsOf<typeof D>['debug']>().toEqualTypeOf<'off' | 'normals'>()
  expectTypeOf<KnobsOf<typeof D>['tint']>().toEqualTypeOf<Hex>()
})

test('KnobsAt partitions the same tuple on invalidates (amendment 20)', () => {
  expectTypeOf<keyof KnobsAt<typeof D, 'draw'>>().toEqualTypeOf<'ambient' | 'shadow' | 'debug'>()
  expectTypeOf<keyof KnobsAt<typeof D, 'front'>>().toEqualTypeOf<'tint'>()
  expectTypeOf<keyof KnobsAt<typeof D, 'hull'>>().toEqualTypeOf<'seed'>()
  expectTypeOf<keyof KnobsAt<typeof D, 'field'>>().toEqualTypeOf<never>()
})

test('KnobsAt takes a union of levels, which is how the sprite scope is written', () => {
  expectTypeOf<keyof KnobsAt<typeof D, 'draw' | 'front' | 'hull' | 'field'>>().toEqualTypeOf<
    'ambient' | 'seed' | 'shadow' | 'tint' | 'debug'
  >()
})
