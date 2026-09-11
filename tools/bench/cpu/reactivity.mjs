import { DWELL_MS } from '@paper-crumple/core'
import { createStage } from '../../../packages/core/src/stage.ts'
import { fakeMotion, fakeSheet, stageEnv } from '../../../packages/core/src/testing/fake-slots.ts'
import { descriptorsFor } from '@paper-crumple/paper'
import { MOTION_KNOBS } from '@paper-crumple/motion'
import { createBenchTimers } from './timers.mjs'
import { observeReactivity } from '../reactivity-observers.mjs'

const context2d = { clearRect() {}, drawImage() {} }

async function setup(mode) {
  // Original CPU rows must run before any Reatom import affects module startup or heap.
  // All three new modes load the same runtime, outside the measured operation.
  const native = await import('./reatom-runtime.mjs')
  const { reatomScene } = await import('@paper-crumple/reatom')
  const api = { ...native, reatomScene }
  const timers = createBenchTimers()
  const sheet = fakeSheet({ knobs: descriptorsFor('hull') })
  const motion = fakeMotion({ knobs: MOTION_KNOBS, poseCount: DWELL_MS.length })
  const stage = await createStage(
    { sheet, motion, maxSize: 384, present: 'blit' },
    stageEnv({ timers }),
  )
  if (stage instanceof Error || typeof stage === 'symbol') return Promise.reject(stage)
  const cells = []
  try {
    for (let i = 0; i < 64; i++) {
      const source = `/tiles/${i}.png`
      const sprite = await stage.add(source, { key: `tile-${i}` })
      if (sprite instanceof Error || typeof sprite === 'symbol') {
        stage.dispose()
        return Promise.reject(sprite)
      }
      const canvas = {
        width: 64,
        height: 64,
        getContext: () => context2d,
        getBoundingClientRect: () => ({ width: 32, height: 32 }),
      }
      const view = stage.view({ canvas })
      if (view instanceof Error) {
        stage.dispose()
        return Promise.reject(view)
      }
      view.show(sprite)
      cells.push({ view, source, canvas })
    }
    const observation = await observeReactivity(mode, stage, cells, {
      ...api,
      async settleReady(promise) {
        let settled = false
        void promise.finally(() => {
          settled = true
        })
        for (let i = 0; !settled && i < 1000; i++) {
          timers.advance(1000)
          await Promise.resolve()
        }
        if (!settled) return Promise.reject(new Error('adapter setup did not settle'))
        return promise
      },
    })
    motion.calls.draw.length = 0
    return {
      stage,
      sheet,
      motion,
      timers,
      views: cells.map((cell) => cell.view),
      observation,
      tick: DWELL_MS.length,
    }
  } catch (error) {
    stage.dispose()
    return Promise.reject(error)
  }
}

export const reactivityScenarios = ['raw', 'semantic', 'progress'].map((mode) => ({
  name: `reactivity-${mode}`,
  note: `64-view dwell tick; ${mode} observation; identical fake slots, sources, commands and timers`,
  setup: () => setup(mode),
  prepare(c) {
    c.motion.calls.draw.length = 0
    if (c.tick >= DWELL_MS.length - 1) {
      c.stage.play('flat', 'ball')
      c.tick = 0
      c.observation.flush()
    }
  },
  op(c) {
    c.timers.advance(DWELL_MS[c.tick])
    c.tick++
    c.observation.flush()
  },
  teardown(c) {
    c.observed = c.observation.snapshot()
    c.observation.dispose()
    c.stage.dispose()
  },
  evidence: (c) => ({
    observed: c.observed,
    cleanup: c.observation.snapshot(),
    disposed: c.motion.disposed && c.sheet.disposed,
  }),
}))
