import type { BlitStage, DirectStage, Run } from '@paper-crumple/core'
import { bind, clearStack, context } from '@reatom/core'
import { expect } from 'vitest'
import { isAborted } from '../../core/src/abort.js'
import { createStage } from '../../core/src/stage.js'
import { fakeMotion, fakeSheet, stageEnv } from '../../core/src/testing/fake-slots.js'
import { createFakeTimers } from '../../core/src/testing/fake-timers.js'

export async function sceneFixture() {
  const motion = fakeMotion()
  const sheet = fakeSheet()
  const timers = createFakeTimers()
  let lose = () => {}
  const stage = await createStage(
    { sheet, motion, maxSize: 384, present: 'blit' },
    stageEnv({
      timers,
      onContextLost: (callback) => {
        lose = callback
        return () => {
          lose = () => {}
        }
      },
    }),
  )
  if (stage instanceof Error || isAborted(stage)) return expect.fail('fixture stage refused')
  // Source-built fixture crosses the package declaration boundary only here: its unique
  // ABORTED symbol is typed from source while consumers compile against the published barrel.
  return { stage: stage as unknown as BlitStage, sheet, motion, timers, lose: () => lose() }
}

export async function makeSceneStage(): Promise<BlitStage> {
  return (await sceneFixture()).stage
}

export async function makeDirectSceneStage(): Promise<DirectStage> {
  const stage = await createStage(
    { sheet: fakeSheet(), motion: fakeMotion(), maxSize: 384, present: 'direct' },
    stageEnv(),
  )
  if (stage instanceof Error || isAborted(stage)) return expect.fail('fixture stage refused')
  return stage as unknown as DirectStage
}

export function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  let reject: (reason: unknown) => void = () => {}
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

export function isolated(test: () => void | Promise<void>) {
  return async () => {
    const frame = context.start()
    try {
      await bind(test, frame)()
    } finally {
      bind(context.reset, frame)()
      clearStack()
    }
  }
}

interface RunHandle<R> {
  readonly run: Run<R>
  readonly settled: boolean
  settle(value: R): void
}

export function createRun<R>(stop: () => void): RunHandle<R> {
  let settled = false
  let resolve: (value: R) => void = () => {}
  const done = new Promise<R>((r) => {
    resolve = r
  })
  const run: Run<R> = {
    done,
    stop,
    then<T1 = R, T2 = never>(
      onfulfilled?: ((value: R) => T1 | PromiseLike<T1>) | null,
      onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
    ): PromiseLike<T1 | T2> {
      return done.then(onfulfilled, onrejected)
    },
  }
  return {
    run,
    get settled() {
      return settled
    },
    settle(value) {
      if (settled) return
      settled = true
      resolve(value)
    },
  }
}
