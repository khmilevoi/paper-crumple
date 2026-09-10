/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest'
import { createFakeStage } from './fake-stage.js'
import { buildingScene, failedScene, readyScene } from './scene-fixtures.js'

describe('scene fixtures', () => {
  it('creates a ready scene around the supplied stage and counters', async () => {
    const fake = createFakeStage()
    const scene = readyScene(fake.stage, { generation: 4, knobEpoch: 7 })
    expect(scene).toMatchObject({
      status: 'ready',
      stage: fake.stage,
      meta: undefined,
      error: null,
      warnings: [],
      lost: false,
      generation: 4,
      knobEpoch: 7,
    })
    await expect(scene.play('flat', 'ball')).resolves.toEqual({
      started: [],
      skipped: [],
      failed: [],
      completed: false,
    })
    expect(() => scene.stop()).not.toThrow()
  })

  it('creates the building discriminant with no stage, meta, or error', () => {
    expect(buildingScene()).toMatchObject({
      status: 'building',
      stage: null,
      meta: null,
      error: null,
      warnings: [],
      lost: false,
      generation: 0,
      knobEpoch: 0,
    })
  })

  it('creates a failed discriminant with the supplied error and lost flag', () => {
    const error = new Error('build failed')
    expect(failedScene(error, { lost: true })).toMatchObject({
      status: 'failed',
      stage: null,
      meta: null,
      error,
      warnings: [],
      lost: true,
      generation: 0,
      knobEpoch: 0,
    })
  })
})
