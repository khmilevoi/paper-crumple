/**
 * @vitest-environment jsdom
 */
import { expect, test, vi } from 'vitest'
import type { BlitStage } from '@paper-crumple/core'
import { usePaperScene } from './use-paper-scene.js'
import { createFakeStage } from './testing/fake-stage.js'
import { deferred } from './testing/deferred.js'
import { flush, renderHook } from './testing/render.js'

test('a lost context moves the scene to failed, with lost true and the GlError (§5.5, §9)', async () => {
  const fake = createFakeStage()
  const harness = await renderHook(() =>
    usePaperScene({ create: async () => fake.stage, deps: [1] }),
  )
  await flush()
  expect(harness.result.current.status).toBe('ready')

  fake.lose()
  await flush()

  expect(harness.result.current.status).toBe('failed')
  expect(harness.result.current.lost).toBe(true)
  expect(harness.result.current.stage).toBeNull()
  expect(harness.result.current.error?.name).toBe('GlError')
  await harness.unmount()
})

test('warnings are re-read on every bump, not mirrored at build time', async () => {
  const fake = createFakeStage()
  const harness = await renderHook(() =>
    usePaperScene({ create: async () => fake.stage, deps: [1] }),
  )
  await flush()
  expect(harness.result.current.warnings).toHaveLength(0)

  fake.pushWarning(new Error('a warning nobody subscribed for'))
  fake.emit('error', {
    error: new Error('and the error that produced it'),
    observed: false,
    view: null,
  })
  await flush()

  expect(harness.result.current.warnings).toHaveLength(1)
  await harness.unmount()
})

test('a rebuild after a loss comes back to ready and clears lost', async () => {
  const first = createFakeStage()
  const second = createFakeStage()
  let deps: readonly unknown[] = [1]
  let next = first
  const harness = await renderHook(() => usePaperScene({ create: async () => next.stage, deps }))
  await flush()
  first.lose()
  await flush()
  expect(harness.result.current.status).toBe('failed')

  deps = [2]
  next = second
  await harness.rerender()
  await flush()

  expect(harness.result.current.status).toBe('ready')
  expect(harness.result.current.lost).toBe(false)
  expect(harness.result.current.error).toBeNull()
  expect(harness.result.current.stage).toBe(second.stage)
  await harness.unmount()
})

test('play on a scene that is not ready resolves to an empty report with completed false (§4.1)', async () => {
  const fake = createFakeStage()
  const gate = deferred<BlitStage>()
  const harness = await renderHook(() => usePaperScene({ create: () => gate.promise, deps: [1] }))
  // The build is still open, so the scene is `building` — `renderHook` resolves inside an
  // `act(async …)` that drains microtasks, so an ungated factory would already have landed.
  const beforeSettle = await harness.result.current.play('flat', 'ball')
  expect(beforeSettle).toEqual({ started: [], skipped: [], failed: [], completed: false })

  gate.resolve(fake.stage)
  await flush()
  fake.lose()
  await flush()

  const afterLoss = await harness.result.current.play('flat', 'ball')
  expect(afterLoss).toEqual({ started: [], skipped: [], failed: [], completed: false })
  expect(fake.calls.filter((c) => c.method === 'play')).toHaveLength(0)
  await harness.unmount()
})

test('play on a ready scene reaches the stage', async () => {
  const fake = createFakeStage()
  const harness = await renderHook(() =>
    usePaperScene({ create: async () => fake.stage, deps: [1] }),
  )
  await flush()
  await harness.result.current.play('flat', 'ball', { duration: 2 })
  const call = fake.calls.find((c) => c.method === 'play')
  expect(call?.args).toEqual(['flat', 'ball', { duration: 2 }])
  await harness.unmount()
})

test('stop is a no-op before ready and reaches the stage after (§4.1)', async () => {
  const fake = createFakeStage()
  const gate = deferred<BlitStage>()
  const harness = await renderHook(() => usePaperScene({ create: () => gate.promise, deps: [1] }))
  harness.result.current.stop()
  expect(fake.calls.filter((c) => c.method === 'stop')).toHaveLength(0)

  gate.resolve(fake.stage)
  await flush()

  harness.result.current.stop({ all: true })
  expect(fake.calls.filter((c) => c.method === 'stop')).toHaveLength(1)
  await harness.unmount()
})

test('the loss reaches the consumer onError as well, exactly once', async () => {
  const onError = vi.fn()
  const fake = createFakeStage()
  const harness = await renderHook(() =>
    usePaperScene({ create: async () => fake.stage, deps: [1], onError }),
  )
  await flush()
  fake.lose()
  await flush()
  expect(onError).toHaveBeenCalledTimes(1)
  await harness.unmount()
})
