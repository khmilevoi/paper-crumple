import type { BlitStage } from '@paper-crumple/core'
import { expectTypeOf, test } from 'vitest'
import type { Crumple, Scene } from '../index.js'
import {
  buildingScene,
  createFakeStage,
  deferred,
  detachedCrumple,
  failedScene,
  readyScene,
  type FakeCall,
  type FakeStageHandle,
  type FakeStageOptions,
  type FakeViewHandle,
} from './index.js'

test('the testing barrel exposes the specified callable signatures', () => {
  expectTypeOf(createFakeStage).returns.toEqualTypeOf<FakeStageHandle>()
  expectTypeOf<Parameters<typeof createFakeStage>>().toEqualTypeOf<[o?: FakeStageOptions]>()
  expectTypeOf(readyScene).returns.toEqualTypeOf<Scene>()
  expectTypeOf<Parameters<typeof readyScene>>().toEqualTypeOf<
    [stage: BlitStage, o?: { generation?: number; knobEpoch?: number }]
  >()
  expectTypeOf(buildingScene).returns.toEqualTypeOf<Scene>()
  expectTypeOf(failedScene).returns.toEqualTypeOf<Scene>()
  expectTypeOf<Parameters<typeof failedScene>>().toEqualTypeOf<
    [error: Error, o?: { lost?: boolean }]
  >()
  expectTypeOf(detachedCrumple).returns.toEqualTypeOf<Crumple>()
  expectTypeOf<Parameters<typeof detachedCrumple>>().toEqualTypeOf<[over?: Partial<Crumple>]>()
  expectTypeOf(deferred<number>().promise).toEqualTypeOf<Promise<number>>()
})

test('the four fake-stage handle types are importable', () => {
  expectTypeOf<FakeStageHandle['stage']>().toEqualTypeOf<BlitStage>()
  expectTypeOf<FakeViewHandle['calls']>().toEqualTypeOf<FakeCall[]>()
})
