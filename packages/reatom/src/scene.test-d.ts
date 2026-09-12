import type {
  Aborted,
  BlitStage,
  DirectStage,
  HostedStage,
  StagePlayReport,
  View,
} from '@paper-crumple/core'
import type { Atom } from '@reatom/core'
import { expectTypeOf, test } from 'vitest'
import { reatomScene, type SceneModel } from './index.js'

declare const blitFactory: () => Promise<BlitStage | Error | Aborted>
declare const directFactory: () => Promise<DirectStage | Error | Aborted>
declare const hostedFactory: () => Promise<HostedStage | Error | Aborted>

test('preserves all three raw stage and surface types', () => {
  const blit = reatomScene({ name: 'blit', create: blitFactory })
  const direct = reatomScene({ name: 'direct', create: directFactory })
  const hosted = reatomScene({ name: 'hosted', create: hostedFactory })
  expectTypeOf(blit).toEqualTypeOf<SceneModel<BlitStage>>()
  expectTypeOf(blit.raw).toExtend<Atom<BlitStage | null>>()
  expectTypeOf(direct.raw()).toEqualTypeOf<DirectStage | null>()
  expectTypeOf(hosted.raw()).toEqualTypeOf<HostedStage | null>()
  expectTypeOf(blit.surface()).toEqualTypeOf<BlitStage['surface'] | null>()
  expectTypeOf(direct.surface()).toEqualTypeOf<DirectStage['surface'] | null>()
  expectTypeOf(direct.surface()?.canvas).toEqualTypeOf<HTMLCanvasElement | undefined>()
  expectTypeOf(hosted.surface()).toEqualTypeOf<HostedStage['surface'] | null>()
  expectTypeOf(direct.ready()).toEqualTypeOf<Promise<DirectStage>>()
  expectTypeOf(hosted.ready.data()).toEqualTypeOf<HostedStage | null>()
  expectTypeOf(blit.play('flat', 'ball')).toEqualTypeOf<Promise<StagePlayReport<View>>>()
  expectTypeOf(blit.play.data()).toEqualTypeOf<StagePlayReport<View> | null>()
  expectTypeOf(blit.dispose()).toEqualTypeOf<void>()
  // @ts-expect-error hosted stages have no resize operation.
  hosted.raw()?.resize(1, 1)
  // @ts-expect-error joining ready only reexports native result state.
  blit.ready.retry()
  // @ts-expect-error public ready cannot reset the owned native tracker.
  blit.ready.reset()
  // @ts-expect-error a waiter cannot abort the shared scene build.
  blit.ready.abort()
})
