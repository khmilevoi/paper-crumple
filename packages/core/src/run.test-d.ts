import { expectTypeOf, test } from 'vitest'
import type { Aborted } from './abort.js'
import type { AddError, PlayResult, SwapResult } from './results.js'
import type { Run } from './run.js'

test('Run defaults its payload to PlayResult (§4.2)', () => {
  expectTypeOf<Run>().toEqualTypeOf<Run<PlayResult>>()
})

test('awaiting a Run yields its payload, so the headline example needs no change', () => {
  expectTypeOf<Awaited<Run<PlayResult>>>().toEqualTypeOf<PlayResult>()
  expectTypeOf<Awaited<Run<SwapResult>>>().toEqualTypeOf<SwapResult>()
})

test('an `async` method cannot return a Run — this is the edit amendment 22 exists to catch', () => {
  // §4.2 warns that refactoring `crumpleTo` to `async` silently breaks iOS audio, because `start`
  // must be emitted synchronously before the call returns. A prose warning cannot prevent that
  // edit; a non-promise return type turns it into a type error at every call site.
  // @ts-expect-error — a Promise is not a Run: it has neither `done` nor `stop`.
  const fromAsync: Run<PlayResult> = (async (): Promise<PlayResult> => undefined)()
  void fromAsync
})

test('crumpleTo carries the target failure that a play between two poses cannot', () => {
  expectTypeOf<AddError>().toExtend<SwapResult>()
  expectTypeOf<AddError>().not.toExtend<PlayResult>()
})

test('a Run<PlayResult> is assignable to a Run<SwapResult>, which is what view.run needs', () => {
  // §4.5 writes the accessor `view.run: Run | null`, which is `Run<PlayResult> | null` and cannot
  // hold the `Run<SwapResult>` a live `crumpleTo` produces. Widening the accessor is the fix, and
  // it is sound because `Run` is covariant in `R` through both `done` and `then`.
  expectTypeOf<Run<PlayResult>>().toExtend<Run<SwapResult>>()
  expectTypeOf<Run<SwapResult>>().not.toExtend<Run<PlayResult>>()
})

test('a cancelled run settles to the sentinel, not to an AbortedError (amendment 1)', () => {
  expectTypeOf<Aborted>().toExtend<PlayResult>()
  expectTypeOf<Aborted>().toExtend<SwapResult>()
})
