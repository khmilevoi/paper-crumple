import { expectTypeOf, test } from 'vitest'
import { INVALIDATION_ORDER } from './invalidation.js'
import type { Invalidates } from './knobs.js'

test('the ladder is closed: the constant and the type are the same four members (§6.3, §6.5)', () => {
  expectTypeOf<(typeof INVALIDATION_ORDER)[number]>().toEqualTypeOf<Invalidates>()
})

test('the constant is ordered, so rank is position', () => {
  expectTypeOf<typeof INVALIDATION_ORDER>().toEqualTypeOf<
    readonly ['draw', 'front', 'hull', 'field']
  >()
})
