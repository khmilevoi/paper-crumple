import type { BlitStage, PlayResult, PoseRef, Run, Sprite, SwapResult } from '@paper-crumple/core'
import { expectTypeOf, test } from 'vitest'
import {
  Crumple,
  PaperScene,
  useCrumple,
  usePaperScene,
  useScene,
  type Scene,
  type SceneOptions,
  type CrumpleArtworkStyle,
  type CrumpleOptions,
  type CrumplePending,
  type CrumpleSettleEvent,
  type CrumpleStatus,
} from './index.js'

test('usePaperScene takes SceneOptions and returns a Scene', () => {
  expectTypeOf(usePaperScene).parameter(0).toEqualTypeOf<SceneOptions>()
  expectTypeOf(usePaperScene).returns.toEqualTypeOf<Scene>()
})

test('useScene returns a Scene, never null — the no-provider case is a failed scene (§4.2)', () => {
  expectTypeOf(useScene).returns.toEqualTypeOf<Scene>()
})

test('PaperScene takes a Scene, not options', () => {
  expectTypeOf<Parameters<typeof PaperScene>[0]['value']>().toEqualTypeOf<Scene>()
})

test('scene.stage narrows to BlitStage once status is checked', () => {
  const scene = {} as Scene
  if (scene.stage !== null) {
    expectTypeOf(scene.stage).toEqualTypeOf<BlitStage>()
  }
})

test('useCrumple returns the Crumple the component takes (§2, §6)', () => {
  expectTypeOf(useCrumple<string>).returns.toEqualTypeOf<Crumple>()
  expectTypeOf<Parameters<typeof Crumple>[0]['value']>().toEqualTypeOf<Crumple>()
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
