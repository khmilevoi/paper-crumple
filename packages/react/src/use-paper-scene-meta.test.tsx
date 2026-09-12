/**
 * @vitest-environment jsdom
 */
import { expect, test } from 'vitest'
import { usePaperScene } from './use-paper-scene.js'
import { createFakeStage } from './testing/fake-stage.js'
import { deferred, type Deferred } from './testing/deferred.js'
import { flush, renderHook } from './testing/render.js'

interface Built {
  readonly label: string
}

test('a SceneBuild carries meta onto the ready snapshot (§3.2)', async () => {
  const fake = createFakeStage()
  const meta: Built = { label: 'first' }
  const harness = await renderHook(() =>
    usePaperScene<Built>({ create: async () => ({ stage: fake.stage, meta }), deps: [1] }),
  )
  await flush()
  expect(harness.result.current.status).toBe('ready')
  expect(harness.result.current.meta).toBe(meta)
  await harness.unmount()
})

test('a bare stage still lands, with meta undefined', async () => {
  const fake = createFakeStage()
  const harness = await renderHook(() =>
    usePaperScene({ create: async () => fake.stage, deps: [1] }),
  )
  await flush()
  expect(harness.result.current.status).toBe('ready')
  expect(harness.result.current.meta).toBeUndefined()
  await harness.unmount()
})

test('meta is cleared while a rebuild is in flight and replaced when it lands', async () => {
  const first = createFakeStage()
  const second = createFakeStage()
  let deps: readonly unknown[] = [1]
  let next = first
  let meta: Built = { label: 'first' }
  /**
   * The second build is held open, exactly as the neighbouring rebuild tests hold theirs:
   * `rerender()` runs inside `act`, which settles an already-resolved `create` before the
   * in-flight window could be asserted on.
   */
  let gate: Deferred<void> | null = null
  const harness = await renderHook(() =>
    usePaperScene<Built>({
      create: async () => {
        if (gate !== null) await gate.promise
        return { stage: next.stage, meta }
      },
      deps,
    }),
  )
  await flush()
  expect(harness.result.current.meta).toEqual({ label: 'first' })

  deps = [2]
  next = second
  meta = { label: 'second' }
  gate = deferred<void>()
  await harness.rerender()
  expect(harness.result.current.status).toBe('building')
  expect(harness.result.current.meta).toBeNull()

  gate.resolve()
  await flush()
  expect(harness.result.current.status).toBe('ready')
  expect(harness.result.current.meta).toEqual({ label: 'second' })
  await harness.unmount()
})

test('meta is null on a failed create and on a lost context', async () => {
  const failing = await renderHook(() =>
    usePaperScene<Built>({ create: async () => new Error('no stage today'), deps: [1] }),
  )
  await flush()
  expect(failing.result.current.status).toBe('failed')
  expect(failing.result.current.meta).toBeNull()
  await failing.unmount()

  const fake = createFakeStage()
  const lost = await renderHook(() =>
    usePaperScene<Built>({
      create: async () => ({ stage: fake.stage, meta: { label: 'first' } }),
      deps: [1],
    }),
  )
  await flush()
  fake.lose()
  await flush()
  expect(lost.result.current.status).toBe('failed')
  expect(lost.result.current.meta).toBeNull()
  await lost.unmount()
})

test('a SceneBuild that resolves after teardown disposes its stage, not the wrapper', async () => {
  const fake = createFakeStage()
  const harness = await renderHook(() =>
    usePaperScene<Built>({
      create: async () => ({ stage: fake.stage, meta: { label: 'late' } }),
      deps: [1],
    }),
  )
  await harness.unmount()
  await flush()
  expect(fake.disposed).toBe(true)
})
