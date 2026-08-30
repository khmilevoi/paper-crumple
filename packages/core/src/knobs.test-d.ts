import { expectTypeOf, test } from 'vitest'
import { enumKnob, knobs } from './knobs.js'
import type { KnobDescriptor } from './knobs.js'

test('knobs() preserves every literal the generated types are built from', () => {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const d = knobs([
    { key: 'ambient', kind: 'number', invalidates: 'draw', default: 0.35, min: 0, max: 1 },
    { key: 'shadow', kind: 'bool', invalidates: 'front', default: true },
  ])
  expectTypeOf<(typeof d)[0]['key']>().toEqualTypeOf<'ambient'>()
  expectTypeOf<(typeof d)[0]['invalidates']>().toEqualTypeOf<'draw'>()
  expectTypeOf<(typeof d)[1]['invalidates']>().toEqualTypeOf<'front'>()
})

test('a descriptor without binds does not carry the property, so Extract can partition on it', () => {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const d = knobs([
    { key: 'ambient', kind: 'number', invalidates: 'draw', default: 0.35, min: 0, max: 1 },
    {
      key: 'paperColor',
      kind: 'color',
      invalidates: 'front',
      default: '#f7f4ed',
      binds: 'paperColor',
    },
  ])
  expectTypeOf<
    Extract<(typeof d)[number], { binds: 'paperColor' }>['key']
  >().toEqualTypeOf<'paperColor'>()
  expectTypeOf<
    Exclude<(typeof d)[number], { binds: 'paperColor' | 'paperBack' }>['key']
  >().toEqualTypeOf<'ambient'>()
})

test('enumKnob() preserves the value tuple and the key', () => {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const d = enumKnob({
    key: 'debug',
    invalidates: 'draw',
    values: ['off', 'normals', 'depth'],
    default: 'off',
  })
  expectTypeOf<(typeof d)['values'][number]>().toEqualTypeOf<'off' | 'normals' | 'depth'>()
  expectTypeOf<(typeof d)['key']>().toEqualTypeOf<'debug'>()
  expectTypeOf<(typeof d)['kind']>().toEqualTypeOf<'enum'>()
})

test('a default outside values is rejected at the field that is wrong (§6.8)', () => {
  enumKnob({
    // @ts-expect-error — 'normal' is not one of 'off' | 'normals'
    key: 'debug',
    // @ts-expect-error — constraint cascade
    invalidates: 'draw',
    // @ts-expect-error — constraint cascade
    values: ['off', 'normals'],
    // @ts-expect-error — constraint cascade
    default: 'normal',
  })
})

test('min and max are required on the numeric kinds (§6.1)', () => {
  knobs([
    // @ts-expect-error — a number knob without min/max matches no member of the union
    { key: 'ambient', kind: 'number', invalidates: 'draw', default: 0.35 },
  ])
  knobs([
    // @ts-expect-error — an int knob without max matches no member of the union
    { key: 'seed', kind: 'int', invalidates: 'hull', default: 1, min: 0 },
  ])
})

test('ui is optional, so a bundle need not carry English labels', () => {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const d = knobs([{ key: 'shadow', kind: 'bool', invalidates: 'draw', default: true }])
  expectTypeOf<(typeof d)[number]>().toExtend<KnobDescriptor>()
})
