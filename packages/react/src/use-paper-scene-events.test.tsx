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

test('onReady fires once per landed build, with the build and the generation (§3.1)', async () => {
  const onReady = vi.fn()
  const fake = createFakeStage()
  const meta: Built = { label: 'first' }
  const harness = await renderHook(() =>
    usePaperScene<Built>({
      create: async () => ({ stage: fake.stage, meta }),
      deps: [1],
      onReady,
    }),
  )
  await flush()
  expect(onReady).toHaveBeenCalledTimes(1)
  expect(onReady.mock.calls[0]?.[0]).toEqual({ stage: fake.stage, meta })
  expect(onReady.mock.calls[0]?.[1]?.generation).toBe(1)
  expect(onReady.mock.calls[0]?.[1]?.signal.aborted).toBe(false)

  await harness.rerender()
  await flush()
  expect(onReady).toHaveBeenCalledTimes(1)
  await harness.unmount()
})

test('onReady fires again on a rebuild, with the next generation', async () => {
  const onReady = vi.fn()
  const first = createFakeStage()
  const second = createFakeStage()
  let deps: readonly unknown[] = [1]
  let next = first
  const harness = await renderHook(() =>
    usePaperScene({ create: async () => next.stage, deps, onReady }),
  )
  await flush()
  deps = [2]
  next = second
  await harness.rerender()
  await flush()
  expect(onReady).toHaveBeenCalledTimes(2)
  expect(onReady.mock.calls[1]?.[1]?.generation).toBe(2)
  await harness.unmount()
})

test('onReady fires after the ready bump and before React re-renders (§3.1)', async () => {
  const fake = createFakeStage()
  const renders: string[] = []
  let rendersAtCallback = -1
  const harness = await renderHook(() => {
    const scene = usePaperScene({
      create: async () => fake.stage,
      deps: [1],
      onReady: () => {
        rendersAtCallback = renders.length
      },
    })
    renders.push(scene.status)
    return scene
  })
  await flush()
  // The callback ran after the render that reported `building` and before the one that reports
  // `ready`: the bump it follows is what schedules that render. Reading `scene.status` from inside
  // the callback would read the *previous* render's memoised object, not the store, so the
  // ordering is asserted by render index instead.
  expect(renders).toContain('ready')
  expect(rendersAtCallback).toBe(renders.indexOf('ready'))
  await harness.unmount()
})

test('info.signal is the effect controller, aborted on unmount', async () => {
  let signal: AbortSignal | undefined
  const fake = createFakeStage()
  const harness = await renderHook(() =>
    usePaperScene({
      create: async () => fake.stage,
      deps: [1],
      onReady: (_build, info) => {
        signal = info.signal
      },
    }),
  )
  await flush()
  expect(signal?.aborted).toBe(false)
  await harness.unmount()
  expect(signal?.aborted).toBe(true)
})

test('onReady never fires for a build that failed or was aborted', async () => {
  const onReady = vi.fn()
  const harness = await renderHook(() =>
    usePaperScene({ create: async () => new Error('no stage today'), deps: [1], onReady }),
  )
  await flush()
  expect(onReady).not.toHaveBeenCalled()
  await harness.unmount()
})
