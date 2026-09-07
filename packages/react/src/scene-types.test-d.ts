import type {
  Aborted,
  BlitStage,
  Knobs,
  PoseRef,
  StageEvent,
  StagePlayOptions,
  StagePlayReport,
  View,
} from '@paper-crumple/core'
import { expectTypeOf, test } from 'vitest'
import type { Scene, SceneBuild, SceneOptions, SceneSnapshot } from './scene-types.js'

test('create takes the signal and the handed-down listener, and never rejects (§4.1)', () => {
  expectTypeOf<SceneOptions['create']>().toEqualTypeOf<
    (
      signal: AbortSignal,
      onError: (e: StageEvent<'error'>) => void,
    ) => Promise<SceneBuild<undefined> | BlitStage | Error | Aborted>
  >()
})

test('SceneBuild is a stage and its metadata, and nothing else (§3.2)', () => {
  expectTypeOf<keyof SceneBuild<string>>().toEqualTypeOf<'stage' | 'meta'>()
  expectTypeOf<SceneBuild<string>['meta']>().toEqualTypeOf<string>()
})

test('deps is the only rebuild trigger and is a plain readonly list', () => {
  expectTypeOf<SceneOptions['deps']>().toEqualTypeOf<readonly unknown[]>()
})

test('knobs is core’s own Knobs, not a third spelling of it (§4.2)', () => {
  expectTypeOf<NonNullable<SceneOptions['knobs']>>().toEqualTypeOf<Knobs>()
})

test('the snapshot carries exactly the eight reactive fields (§4.1)', () => {
  expectTypeOf<keyof SceneSnapshot>().toEqualTypeOf<
    'status' | 'stage' | 'meta' | 'error' | 'warnings' | 'lost' | 'generation' | 'knobEpoch'
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
