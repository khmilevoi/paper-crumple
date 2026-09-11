import type { BlitStage } from '@paper-crumple/core'
import { expectTypeOf, test } from 'vitest'
import {
  Crumple,
  PaperScene,
  useCrumple,
  usePaperScene,
  useScene,
  type Scene,
  type SceneOptions,
} from './index.js'
// --- P4: the crumple request surface (§2.1, §2.3, §2.5) ---
// Separate statements rather than widened lists: this file is append-only across plans, and a
// second import from an already-imported specifier is an established pattern in this package.
import type { PlayResult, PoseRef, Run, Sprite, SwapResult } from '@paper-crumple/core'
import type {
  CrumpleArtworkStyle,
  CrumpleOptions,
  CrumplePending,
  CrumpleSettleEvent,
  CrumpleStatus,
} from './index.js'

// --- P6: binding-owned callback names (§4.3) ---
import type { CreateStage, StageErrorListener } from './index.js'

test('usePaperScene takes SceneOptions and returns a Scene, with meta defaulting to undefined', () => {
  expectTypeOf<Parameters<typeof usePaperScene<undefined>>[0]>().toEqualTypeOf<SceneOptions>()
  expectTypeOf<ReturnType<typeof usePaperScene<undefined>>>().toEqualTypeOf<Scene>()
})

test('useScene returns a Scene, never null — the no-provider case is a failed scene (§4.2)', () => {
  expectTypeOf<ReturnType<typeof useScene<undefined>>>().toEqualTypeOf<Scene>()
})

test('PaperScene takes a Scene, not options', () => {
  expectTypeOf<Parameters<typeof PaperScene<undefined>>[0]['value']>().toEqualTypeOf<Scene>()
})

test('scene.stage narrows to BlitStage once status is checked', () => {
  const scene = {} as Scene
  if (scene.stage !== null) {
    expectTypeOf(scene.stage).toEqualTypeOf<BlitStage>()
  }
  // §4.1: `scene.error.message` after a status check, with no `?.` and no `!`.
  if (scene.status === 'failed') {
    expectTypeOf(scene.error.message).toEqualTypeOf<string>()
  }
})

test('useCrumple returns the Crumple the component takes (§2, §6)', () => {
  expectTypeOf(useCrumple<string>).returns.toEqualTypeOf<Crumple>()
  expectTypeOf<Crumple>().toExtend<Parameters<typeof Crumple>[0]['value']>()
})

test('the crumple request surface is exported and reads as one snapshot (§2.1, §2.5)', () => {
  const crumple = {} as Crumple
  expectTypeOf(crumple.status).toEqualTypeOf<CrumpleStatus>()
  expectTypeOf(crumple.pending).toEqualTypeOf<CrumplePending | null>()
  expectTypeOf(crumple.artworkStyle).toEqualTypeOf<CrumpleArtworkStyle | null>()
  expectTypeOf(crumple.sprite).toEqualTypeOf<Sprite | null>()
})

test('pending narrows to a typed run through its phase (§2.1)', () => {
  const pending = {} as CrumplePending
  if (pending.phase === 'swapping') {
    expectTypeOf(pending.run).toEqualTypeOf<Run<SwapResult>>()
  }
  if (pending.phase === 'entering') {
    expectTypeOf(pending.run).toEqualTypeOf<Run<PlayResult>>()
  }
  if (pending.phase === 'acquiring') {
    expectTypeOf(pending.run).toEqualTypeOf<null>()
  }
})

test('onSettle takes the binding s own settle event (§2.1)', () => {
  expectTypeOf<NonNullable<CrumpleOptions<string>['onSettle']>>().toEqualTypeOf<
    (e: CrumpleSettleEvent) => void
  >()
})

test('the crumple carries draw, sync and retry (§2.2, §2.6)', () => {
  const crumple = {} as Crumple
  expectTypeOf(crumple.draw).toEqualTypeOf<(pose: PoseRef) => void>()
  expectTypeOf(crumple.sync).toEqualTypeOf<() => void>()
  expectTypeOf(crumple.retry).toEqualTypeOf<() => void>()
})

test('the React root exports the binding-owned callback names (§4.3)', () => {
  expectTypeOf<CreateStage>().toEqualTypeOf<SceneOptions['create']>()
  expectTypeOf<CreateStage<{ id: string }>>().toEqualTypeOf<
    SceneOptions<{ id: string }>['create']
  >()
  expectTypeOf<StageErrorListener>().toEqualTypeOf<NonNullable<SceneOptions['onError']>>()
  expectTypeOf<NonNullable<CrumpleOptions<string>['onError']>>().toEqualTypeOf<StageErrorListener>()
})
