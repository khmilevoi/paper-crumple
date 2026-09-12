/**
 * @vitest-environment jsdom
 */
import { ABORTED } from '@paper-crumple/core'
import type { BlitStage } from '@paper-crumple/core'
import { afterEach, expect, test, vi } from 'vitest'
import { act } from 'react'
import type { SceneOptions } from './scene-types.js'
import { usePaperScene } from './use-paper-scene.js'
import { createFakeStage, type FakeStageHandle } from './testing/fake-stage.js'
import { deferred } from './testing/deferred.js'
import { flush, renderHook } from './testing/render.js'

const CORE_MARKER_KEY = Symbol.for('paper-crumple.core')

test('direct raw disposal clears scene metadata and prevents future scene commands', async () => {
  const fake = createFakeStage()
  const create = vi.fn(async () => ({ stage: fake.stage, meta: { title: 'hero' } }))
  const harness = await renderHook(() => usePaperScene({ create, deps: [] }))
  await flush()
  await act(async () => {
    fake.stage.dispose()
    const immediateCalls = fake.calls.length
    await harness.result.current.play('flat', 'ball')
    harness.result.current.stop()
    expect(fake.calls).toHaveLength(immediateCalls)
  })
  await flush()
  expect(harness.result.current.stage).toBeNull()
  expect(harness.result.current.meta).toBeNull()
  expect(harness.result.current.status).toBe('failed')
  const before = fake.calls.length
  await harness.result.current.play('flat', 'ball')
  harness.result.current.stop()
  expect(fake.calls).toHaveLength(before)
  expect(create).toHaveBeenCalledTimes(1)
  await harness.unmount()
})

afterEach(() => {
  vi.restoreAllMocks()
})

test('a landed build reports ready, carries the stage, and bumps generation to one', async () => {
  const fake = createFakeStage()
  const harness = await renderHook(() =>
    usePaperScene({ create: async () => fake.stage, deps: [1] }),
  )
  await flush()
  expect(harness.result.current.status).toBe('ready')
  expect(harness.result.current.stage).toBe(fake.stage)
  expect(harness.result.current.error).toBeNull()
  expect(harness.result.current.generation).toBe(1)
  await harness.unmount()
})

test('the scene is building until the factory settles', async () => {
  const gate = deferred<BlitStage>()
  const harness = await renderHook(() => usePaperScene({ create: () => gate.promise, deps: [1] }))
  expect(harness.result.current.status).toBe('building')
  expect(harness.result.current.stage).toBeNull()
  const fake = createFakeStage()
  gate.resolve(fake.stage)
  await flush()
  expect(harness.result.current.status).toBe('ready')
  await harness.unmount()
})

test('an Error from create fails the scene and publishes no stage (§4.1)', async () => {
  const boom = new Error('the factory refused')
  const harness = await renderHook(() => usePaperScene({ create: async () => boom, deps: [1] }))
  await flush()
  expect(harness.result.current.status).toBe('failed')
  expect(harness.result.current.error).toBe(boom)
  expect(harness.result.current.stage).toBeNull()
  await harness.unmount()
})

test('ABORTED never reaches the consumer through the fields (§7)', async () => {
  const harness = await renderHook(() => usePaperScene({ create: async () => ABORTED, deps: [1] }))
  await flush()
  expect(harness.result.current.status).toBe('building')
  expect(harness.result.current.error).toBeNull()
  expect(harness.result.current.stage).toBeNull()
  await harness.unmount()
})

test('unmount aborts the in-flight build', async () => {
  const seen: { current: AbortSignal | null } = { current: null }
  const gate = deferred<BlitStage>()
  const harness = await renderHook(() =>
    usePaperScene({
      create: (signal) => {
        seen.current = signal
        return gate.promise
      },
      deps: [1],
    }),
  )
  expect(seen.current?.aborted).toBe(false)
  await harness.unmount()
  expect(seen.current?.aborted).toBe(true)
})

test('unmount disposes the landed stage — §1 covers the loser only', async () => {
  const fake = createFakeStage()
  const harness = await renderHook(() =>
    usePaperScene({ create: async () => fake.stage, deps: [1] }),
  )
  await flush()
  expect(fake.disposed).toBe(false)
  await harness.unmount()
  expect(fake.disposed).toBe(true)
})

test('a build that lands after its own cleanup is disposed, not published', async () => {
  const gate = deferred<BlitStage>()
  const harness = await renderHook(() => usePaperScene({ create: () => gate.promise, deps: [1] }))
  await harness.unmount()
  const fake = createFakeStage()
  gate.resolve(fake.stage)
  await flush()
  expect(fake.disposed).toBe(true)
})

test('a deps change disposes the outgoing stage — one live stage after three builds (§9)', async () => {
  const built: FakeStageHandle[] = []
  let deps: readonly unknown[] = [1]
  const options = (): SceneOptions => ({
    create: async () => {
      const fake = createFakeStage()
      built.push(fake)
      return fake.stage
    },
    deps,
  })
  const harness = await renderHook(() => usePaperScene(options()))
  await flush()
  deps = [2]
  await harness.rerender()
  await flush()
  deps = [3]
  await harness.rerender()
  await flush()

  expect(built).toHaveLength(3)
  expect(built.filter((f) => !f.disposed)).toHaveLength(1)
  expect(built[2]?.disposed).toBe(false)
  expect(harness.result.current.stage).toBe(built[2]?.stage)
  expect(harness.result.current.generation).toBe(3)
  await harness.unmount()
})

test('a re-render that does not change deps does not rebuild', async () => {
  const create = vi.fn(async () => createFakeStage().stage)
  const harness = await renderHook(() => usePaperScene({ create, deps: [1] }))
  await flush()
  await harness.rerender()
  await harness.rerender()
  await flush()
  expect(create).toHaveBeenCalledTimes(1)
  await harness.unmount()
})

test('a create that closes over changed state is not re-invoked until deps ask (§2.1)', async () => {
  let sheet = 'a'
  const seen: string[] = []
  let deps: readonly unknown[] = [1]
  const harness = await renderHook(() =>
    usePaperScene({
      create: async () => {
        seen.push(sheet)
        return createFakeStage().stage
      },
      deps,
    }),
  )
  await flush()
  sheet = 'b'
  await harness.rerender()
  await flush()
  expect(seen).toEqual(['a'])
  deps = [2]
  await harness.rerender()
  await flush()
  expect(seen).toEqual(['a', 'b'])
  await harness.unmount()
})

test('strict mode leaves exactly one live stage', async () => {
  const built: FakeStageHandle[] = []
  const harness = await renderHook(
    () =>
      usePaperScene({
        create: async (signal) => {
          const fake = createFakeStage()
          built.push(fake)
          await Promise.resolve()
          if (signal.aborted) {
            fake.stage.dispose()
            return ABORTED
          }
          return fake.stage
        },
        deps: [1],
      }),
    { strict: true },
  )
  await flush()
  expect(built.filter((f) => !f.disposed)).toHaveLength(1)
  expect(harness.result.current.status).toBe('ready')
  await harness.unmount()
  expect(built.filter((f) => !f.disposed)).toHaveLength(0)
})

test('the Scene identity changes only when a field does (§2.1)', async () => {
  const fake = createFakeStage()
  const harness = await renderHook(() =>
    usePaperScene({ create: async () => fake.stage, deps: [1] }),
  )
  await flush()
  const settled = harness.result.current
  await harness.rerender()
  expect(harness.result.current).toBe(settled)
  await harness.unmount()
})

test('play and stop keep one identity for the life of the scene (§2.1)', async () => {
  const fake = createFakeStage()
  const harness = await renderHook(() =>
    usePaperScene({ create: async () => fake.stage, deps: [1] }),
  )
  const { play, stop } = harness.result.current
  await flush()
  await harness.rerender()
  expect(harness.result.current.play).toBe(play)
  expect(harness.result.current.stop).toBe(stop)
  await harness.unmount()
})

test('a duplicate core fails the scene outright and create is never called (§3)', async () => {
  const registry = globalThis as unknown as Record<symbol, unknown>
  const own = registry[CORE_MARKER_KEY]
  registry[CORE_MARKER_KEY] = { version: '0.0.0-impostor' }
  try {
    const create = vi.fn(async () => createFakeStage().stage)
    const harness = await renderHook(() => usePaperScene({ create, deps: [1] }))
    await flush()
    expect(harness.result.current.status).toBe('failed')
    expect(harness.result.current.error?.name).toBe('CoreDuplicateError')
    expect(create).not.toHaveBeenCalled()
    await harness.unmount()
  } finally {
    registry[CORE_MARKER_KEY] = own
  }
})

test('the duplicate-core failure reports through onFailed, with lost false (§3)', async () => {
  const registry = globalThis as unknown as Record<symbol, unknown>
  const own = registry[CORE_MARKER_KEY]
  registry[CORE_MARKER_KEY] = { version: '0.0.0-impostor' }
  try {
    const onFailed = vi.fn()
    const create = vi.fn(async () => createFakeStage().stage)
    const harness = await renderHook(() => usePaperScene({ create, deps: [1], onFailed }))
    await flush()
    // The startup gate fails the scene before `create` is ever reached, and §3.1's "at most once
    // per build" covers this dispatch site too — `generation` is 0 because nothing ever landed.
    expect(create).not.toHaveBeenCalled()
    expect(onFailed).toHaveBeenCalledTimes(1)
    expect(onFailed.mock.calls[0]?.[0]?.name).toBe('CoreDuplicateError')
    expect(onFailed.mock.calls[0]?.[0]).toBe(harness.result.current.error)
    expect(onFailed.mock.calls[0]?.[1]).toEqual({ lost: false, generation: 0 })
    await harness.unmount()
  } finally {
    registry[CORE_MARKER_KEY] = own
  }
})
