import type { BlitStage } from '@paper-crumple/core'
import type { Scene, SceneMethods } from '../scene-types.js'

const METHODS: SceneMethods = {
  async play() {
    return { started: [], skipped: [], failed: [], completed: false }
  },
  stop() {},
}

export function readyScene(
  stage: BlitStage,
  o?: { generation?: number; knobEpoch?: number },
): Scene {
  return {
    status: 'ready',
    stage,
    meta: undefined,
    error: null,
    warnings: [],
    lost: false,
    generation: o?.generation ?? 1,
    knobEpoch: o?.knobEpoch ?? 0,
    ...METHODS,
  }
}

export function buildingScene(): Scene {
  return {
    status: 'building',
    stage: null,
    meta: null,
    error: null,
    warnings: [],
    lost: false,
    generation: 0,
    knobEpoch: 0,
    ...METHODS,
  }
}

export function failedScene(error: Error, o?: { lost?: boolean }): Scene {
  return {
    status: 'failed',
    stage: null,
    meta: null,
    error,
    warnings: [],
    lost: o?.lost ?? false,
    generation: 0,
    knobEpoch: 0,
    ...METHODS,
  }
}
