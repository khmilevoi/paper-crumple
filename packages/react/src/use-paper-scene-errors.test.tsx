/**
 * @vitest-environment jsdom
 */
import type { BlitStage, StageEvent } from '@paper-crumple/core'
import { expect, test, vi } from 'vitest'
import { usePaperScene } from './use-paper-scene.js'
import { createFakeStage } from './testing/fake-stage.js'
import { deferred } from './testing/deferred.js'
import { flush, renderHook } from './testing/render.js'

function errorEvent(message: string): StageEvent<'error'> {
  return { error: new Error(message), observed: false, view: null }
}

test('the handed-down listener carries a pre-mount error to SceneOptions.onError', async () => {
  const onError = vi.fn()
  const harness = await renderHook(() =>
    usePaperScene({
      create: async (_signal, handedDown) => {
        handedDown(errorEvent('pre-mount'))
        return createFakeStage().stage
      },
      deps: [1],
      onError,
    }),
  )
  await flush()
  expect(onError).toHaveBeenCalledTimes(1)
  expect(onError.mock.calls[0]?.[0]?.error.message).toBe('pre-mount')
  await harness.unmount()
})

test('the handed-down listener stops forwarding the moment create resolves (§7)', async () => {
  const onError = vi.fn()
  let handedDown: ((e: StageEvent<'error'>) => void) | null = null
  const harness = await renderHook(() =>
    usePaperScene({
      create: async (_signal, forward) => {
        handedDown = forward
        return createFakeStage().stage
      },
      deps: [1],
      onError,
    }),
  )
  await flush()
  expect(onError).not.toHaveBeenCalled()
  handedDown?.(errorEvent('after resolve'))
  expect(onError).not.toHaveBeenCalled()
  await harness.unmount()
})

test('a post-resolve error arrives exactly once, through stage.on', async () => {
  const onError = vi.fn()
  const fake = createFakeStage()
  let handedDown: ((e: StageEvent<'error'>) => void) | null = null
  const harness = await renderHook(() =>
    usePaperScene({
      create: async (_signal, forward) => {
        handedDown = forward
        // What a real consumer does: spread it into paperStage, which registers it permanently.
        fake.stage.on('error', forward)
        return fake.stage
      },
      deps: [1],
      onError,
    }),
  )
  await flush()
  expect(handedDown).not.toBeNull()
  fake.emit('error', errorEvent('post-resolve'))
  expect(onError).toHaveBeenCalledTimes(1)
  await harness.unmount()
})

test('a consumer who drops the second parameter still gets every post-resolve error', async () => {
  const onError = vi.fn()
  const fake = createFakeStage()
  const harness = await renderHook(() =>
    usePaperScene({ create: async () => fake.stage, deps: [1], onError }),
  )
  await flush()
  fake.emit('error', errorEvent('post-resolve'))
  expect(onError).toHaveBeenCalledTimes(1)
  await harness.unmount()
})

test('the newest onError is called by a listener attached before it was replaced (§2.1)', async () => {
  const first = vi.fn()
  const second = vi.fn()
  const fake = createFakeStage()
  let handler = first
  const harness = await renderHook(() =>
    usePaperScene({ create: async () => fake.stage, deps: [1], onError: handler }),
  )
  await flush()
  handler = second
  await harness.rerender()
  fake.emit('error', errorEvent('late'))
  expect(first).not.toHaveBeenCalled()
  expect(second).toHaveBeenCalledTimes(1)
  await harness.unmount()
})

test('a superseded build stops forwarding through its own stage listener', async () => {
  const onError = vi.fn()
  const first = createFakeStage()
  const second = createFakeStage()
  let deps: readonly unknown[] = [1]
  let next: BlitStage = first.stage
  const harness = await renderHook(() => usePaperScene({ create: async () => next, deps, onError }))
  await flush()
  deps = [2]
  next = second.stage
  await harness.rerender()
  await flush()
  first.emit('error', errorEvent('from the disposed stage'))
  expect(onError).not.toHaveBeenCalled()
  second.emit('error', errorEvent('from the live stage'))
  expect(onError).toHaveBeenCalledTimes(1)
  await harness.unmount()
})

test('a pre-mount error on a build that is then aborted is not forwarded after cleanup', async () => {
  const onError = vi.fn()
  const gate = deferred<BlitStage>()
  let handedDown: ((e: StageEvent<'error'>) => void) | null = null
  const harness = await renderHook(() =>
    usePaperScene({
      create: (_signal, forward) => {
        handedDown = forward
        return gate.promise
      },
      deps: [1],
      onError,
    }),
  )
  await harness.unmount()
  handedDown?.(errorEvent('too late'))
  expect(onError).not.toHaveBeenCalled()
  gate.resolve(createFakeStage().stage)
  await flush()
})
