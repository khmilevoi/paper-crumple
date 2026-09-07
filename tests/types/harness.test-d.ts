import { expectTypeOf, test } from 'vitest'

test('the type-level tier compares types rather than values', () => {
  expectTypeOf<{ a: 1 }>().not.toEqualTypeOf<{ a: 2 }>()
})

test('the type-level tier reports a real compiler error', () => {
  // @ts-expect-error - a string is not a number. If this tier were running the bundler
  // rather than tsc, the directive would never be checked and the tier would be a no-op.
  const notANumber: number = 'not a number'
  expectTypeOf(notANumber).toEqualTypeOf<number>()
})
