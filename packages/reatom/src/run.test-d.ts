import { ABORTED, type Aborted, type Run } from '@paper-crumple/core'
import type { Atom, Computed } from '@reatom/core'
import { expectTypeOf, test } from 'vitest'
import { reatomRun, type RunModel } from './index.js'

declare const run: Run<{ completed: true } | Error | Aborted>

test('the run model keeps the successful payload and native completion state types', () => {
  const model = reatomRun<{ completed: true }>(run, 'run.types')

  expectTypeOf(model).toEqualTypeOf<RunModel<{ completed: true }>>()
  expectTypeOf(model.raw).toEqualTypeOf<Run<{ completed: true } | Error | Aborted>>()
  expectTypeOf(model.stop()).toEqualTypeOf<void>()
  expectTypeOf(model.completion.done).toEqualTypeOf<Promise<{ completed: true }>>()
  expectTypeOf(model.completion.data).toExtend<Atom<{ completed: true } | null>>()
  expectTypeOf(model.completion.data()).toEqualTypeOf<{ completed: true } | null>()
  expectTypeOf(model.completion.error).toEqualTypeOf<Atom<Error | undefined>>()
  expectTypeOf(model.completion.pending).toEqualTypeOf<Computed<number>>()
  expectTypeOf(model.completion.ready).toEqualTypeOf<Computed<boolean>>()

  // @ts-expect-error — completion is a frozen state facade, not the internal action.
  model.completion()
  // @ts-expect-error — callers cannot restart the one-shot completion tracker.
  model.completion.retry()
  // @ts-expect-error — callers cannot reset the one-shot completion tracker.
  model.completion.reset()
  // @ts-expect-error — callers cannot cancel tracking separately from the owned Run.
  model.completion.abort()
})

test('a view-style play call returns the model synchronously', () => {
  const play = (): RunModel<number> =>
    reatomRun<number>(run as unknown as Run<number | Error | Aborted>, 'view.play')
  const model = play()

  expectTypeOf(model).toEqualTypeOf<RunModel<number>>()
  expectTypeOf(model).not.toExtend<PromiseLike<unknown>>()
  expectTypeOf(model.completion.done).toEqualTypeOf<Promise<number>>()
  expectTypeOf(
    reatomRun<number>(run as unknown as Run<number | Error | Aborted>, 'direct'),
  ).toEqualTypeOf<RunModel<number>>()
  void ABORTED
})
