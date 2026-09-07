import { expectTypeOf, test } from 'vitest'
import { type Aborted } from './abort.js'
import { GlError } from './errors.js'
import { unwrap, unwrapAsync } from './unwrap.js'

type Result = number | InstanceType<typeof GlError> | Aborted

test('unwrap strips both the Error half and the sentinel', () => {
  expectTypeOf(unwrap<Result>).returns.toEqualTypeOf<number>()
})

test('unwrapAsync strips both, inside the promise', () => {
  expectTypeOf(unwrapAsync<Result>).returns.toEqualTypeOf<Promise<number>>()
})
