import { expectTypeOf, test } from 'vitest'
import type {
  PlayOptions,
  Run,
  RunOwner,
  SkipReason,
  StagePlayOptions,
  StagePlayReport,
  ViewState,
} from './index.js'
import type { PlayResult } from './index.js'

test('the types §4.2, §4.4 and §4.5 put in a consumer signature are on the root', () => {
  expectTypeOf<Run>().toEqualTypeOf<Run<PlayResult>>()
  expectTypeOf<RunOwner>().toEqualTypeOf<'view' | 'stage'>()
  expectTypeOf<SkipReason>().toEqualTypeOf<'busy' | 'no-sprite' | 'cancelled' | 'disposed'>()
  expectTypeOf<PlayOptions>().toExtend<{ duration?: number; signal?: AbortSignal }>()
  expectTypeOf<StagePlayOptions>().toExtend<PlayOptions>()
})

test('ViewState is §4.5 s table exposed — seven states, and no `stopped`', () => {
  expectTypeOf<ViewState>().toEqualTypeOf<
    | 'idle'
    | 'playing'
    | 'crumpling.rise'
    | 'crumpling.ball'
    | 'crumpling.fall'
    | 'crumpling.recover'
    | 'disposed'
  >()
})

test('the stage.play report is a report and not a Run (amendment 22 is view-scoped)', () => {
  type Report = StagePlayReport<{ id: string }>
  expectTypeOf<Report['completed']>().toEqualTypeOf<boolean>()
  expectTypeOf<Report['started']>().toEqualTypeOf<Array<{ id: string }>>()
  expectTypeOf<Report>().not.toExtend<PromiseLike<unknown>>()
})
