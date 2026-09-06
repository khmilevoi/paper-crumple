import type {
  Aborted,
  BlitStage,
  PoseRef,
  StageEvent,
  StagePlayOptions,
  StagePlayReport,
  View,
} from '@paper-crumple/core'
import { expectTypeOf, test } from 'vitest'
import type { Scene, SceneOptions, SceneSnapshot } from './scene-types.js'

test('create takes the signal and the handed-down listener, and never rejects (§4.1)', () => {
  expectTypeOf<SceneOptions['create']>().toEqualTypeOf<
    (
      signal: AbortSignal,
      onError: (e: StageEvent<'error'>) => void,
    ) => Promise<BlitStage | Error | Aborted>
  >()
})

test('deps is the only rebuild trigger and is a plain readonly list', () => {
  expectTypeOf<SceneOptions['deps']>().toEqualTypeOf<readonly unknown[]>()
})

test('knobs is a flat map of primitives (§4.3)', () => {
  expectTypeOf<NonNullable<SceneOptions['knobs']>>().toEqualTypeOf<
    Readonly<Record<string, string | number | boolean>>
  >()
})

test('the snapshot carries exactly the seven reactive fields (§4.1)', () => {
  expectTypeOf<keyof SceneSnapshot>().toEqualTypeOf<
    'status' | 'stage' | 'error' | 'warnings' | 'lost' | 'generation' | 'knobEpoch'
  >()
  expectTypeOf<SceneSnapshot['stage']>().toEqualTypeOf<BlitStage | null>()
  expectTypeOf<SceneSnapshot['error']>().toEqualTypeOf<Error | null>()
  expectTypeOf<SceneSnapshot['warnings']>().toEqualTypeOf<readonly Error[]>()
})

test('Scene is the snapshot plus play and stop, and play never rejects (§7)', () => {
  expectTypeOf<Scene>().toMatchTypeOf<SceneSnapshot>()
  expectTypeOf<Scene['play']>().toEqualTypeOf<
    (from: PoseRef, to: PoseRef, o?: StagePlayOptions) => Promise<StagePlayReport<View>>
  >()
  expectTypeOf<Scene['stop']>().toEqualTypeOf<(o?: { all?: boolean }) => void>()
})
