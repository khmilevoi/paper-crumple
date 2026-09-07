/**
 * @vitest-environment jsdom
 */
import { expect, test, vi } from 'vitest'
import { usePaperScene } from './use-paper-scene.js'
import { createFakeStage } from './testing/fake-stage.js'
import { flush, renderHook } from './testing/render.js'

interface Built {
  readonly label: string
}

test('the positional form builds, and infers M from create (§3.5)', async () => {
  const fake = createFakeStage()
  const meta: Built = { label: 'positional' }
  const harness = await renderHook(() =>
    usePaperScene<Built>(async () => ({ stage: fake.stage, meta }), [1]),
  )
  await flush()
  expect(harness.result.current.status).toBe('ready')
  expect(harness.result.current.meta).toBe(meta)
  await harness.unmount()
})

test('the positional form rebuilds on a deps change and not otherwise', async () => {
  const first = createFakeStage()
  const second = createFakeStage()
  let deps: readonly unknown[] = [1]
  let next = first
  const harness = await renderHook(() => usePaperScene(async () => next.stage, deps))
  await flush()
  expect(harness.result.current.generation).toBe(1)

  await harness.rerender()
  await flush()
  expect(harness.result.current.generation).toBe(1)

  deps = [2]
  next = second
  await harness.rerender()
  await flush()
  expect(harness.result.current.generation).toBe(2)
  await harness.unmount()
})

test('the third argument carries knobs and every callback', async () => {
  const onReady = vi.fn()
  const onError = vi.fn()
  const fake = createFakeStage()
  const harness = await renderHook(() =>
    usePaperScene(async () => fake.stage, [1], { knobs: { a: 1 }, onReady, onError }),
  )
  await flush()
  expect(onReady).toHaveBeenCalledTimes(1)
  expect(fake.calls.filter((c) => c.method === 'set').map((c) => c.args[0])).toEqual([{ a: 1 }])
  await harness.unmount()
})

test('omitting the third argument is legal', async () => {
  const fake = createFakeStage()
  const harness = await renderHook(() => usePaperScene(async () => fake.stage, []))
  await flush()
  expect(harness.result.current.status).toBe('ready')
  await harness.unmount()
})
