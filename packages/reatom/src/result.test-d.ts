import { ABORTED, type Aborted } from '@paper-crumple/core'
import { abortVar, action, throwAbort, withAsyncData } from '@reatom/core'
import { expectTypeOf, test } from 'vitest'
import { toAsyncValue } from './result.js'

test('the installed async extension and boundary retain success types', () => {
  const operation = action(async (value: number | Error | Aborted) => {
    expectTypeOf(abortVar.require().signal).toEqualTypeOf<AbortSignal>()
    return toAsyncValue(value)
  }, 'result.types').extend(withAsyncData({ initState: 0 }))
  expectTypeOf(operation(ABORTED)).toEqualTypeOf<Promise<number>>()
  expectTypeOf(operation.data()).toEqualTypeOf<number>()
  expectTypeOf(operation.error()).toEqualTypeOf<Error | undefined>()
  expectTypeOf(operation.pending()).toEqualTypeOf<number>()
  expectTypeOf(operation.ready()).toEqualTypeOf<boolean>()
  expectTypeOf(operation.data.reset()).toEqualTypeOf<number>()
  expectTypeOf(throwAbort).returns.toEqualTypeOf<never>()
})
