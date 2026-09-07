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
