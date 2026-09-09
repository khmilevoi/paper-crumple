/**
 * @vitest-environment jsdom
 */
import type { Knobs } from '@paper-crumple/core'
import { expect, test, vi } from 'vitest'
import { usePaperScene } from './use-paper-scene.js'
import { createFakeStage, type FakeStageHandle } from './testing/fake-stage.js'
import { flush, renderHook } from './testing/render.js'

const setCalls = (fake: FakeStageHandle): unknown[] =>
  fake.calls.filter((c) => c.method === 'set').map((c) => c.args[0])

test('dropping a key writes stage.defaults back for it (§3.4)', async () => {
  const fake = createFakeStage({ defaults: { a: 0, b: 'base' } })
  let knobs: Knobs = { a: 5, b: 'moved' }
  const harness = await renderHook(() =>
    usePaperScene({ create: async () => fake.stage, deps: [1], knobs }),
  )
  await flush()
  expect(setCalls(fake)).toEqual([{ a: 5 }, { b: 'moved' }])

  knobs = { a: 5 }
  await harness.rerender()
  await flush()
  expect(setCalls(fake)).toEqual([{ a: 5 }, { b: 'moved' }, { b: 'base' }])
  await harness.unmount()
})

test('setKnobs({}) resets every moved knob at once', async () => {
  const fake = createFakeStage({ defaults: { a: 0, b: 'base' } })
  let knobs: Knobs = { a: 5, b: 'moved' }
  const harness = await renderHook(() =>
    usePaperScene({ create: async () => fake.stage, deps: [1], knobs }),
  )
  await flush()
  knobs = {}
  await harness.rerender()
  await flush()
  expect(setCalls(fake)).toEqual([{ a: 5 }, { b: 'moved' }, { a: 0 }, { b: 'base' }])
  await harness.unmount()
})

test('a reset counts in that batch’s knobEpoch bump, once', async () => {
  const fake = createFakeStage({ defaults: { a: 0, b: 'base' } })
  let knobs: Knobs = { a: 5, b: 'moved' }
  const harness = await renderHook(() =>
    usePaperScene({ create: async () => fake.stage, deps: [1], knobs }),
  )
  await flush()
  expect(harness.result.current.knobEpoch).toBe(1)

  knobs = {}
  await harness.rerender()
  await flush()
  expect(harness.result.current.knobEpoch).toBe(2)
  await harness.unmount()
})

test('a key the stage declares no default for is skipped silently', async () => {
  const onError = vi.fn()
  const onKnobRefused = vi.fn()
  const fake = createFakeStage({ defaults: { a: 0 } })
  let knobs: Knobs = { a: 5, undeclared: 9 }
  const harness = await renderHook(() =>
    usePaperScene({ create: async () => fake.stage, deps: [1], knobs, onError, onKnobRefused }),
  )
  await flush()
  onError.mockClear()

  knobs = {}
  await harness.rerender()
  await flush()
  expect(setCalls(fake)).toEqual([{ a: 5 }, { undeclared: 9 }, { a: 0 }])
  expect(onError).not.toHaveBeenCalled()
  expect(onKnobRefused).not.toHaveBeenCalled()
  await harness.unmount()
})

test('a key only Object.prototype declares is skipped, like any undeclared key', async () => {
  const fake = createFakeStage({ defaults: { a: 0 } })
  // `toString` is not in `stage.defaults`, but it *is* on the prototype of the object holding
  // them: a plain `defaults[key]` read resolves it to a function and writes that back.
  let knobs: Knobs = { a: 5, toString: 9 }
  const harness = await renderHook(() =>
    usePaperScene({ create: async () => fake.stage, deps: [1], knobs }),
  )
  await flush()
  // Annotated, because a bare literal mixing `{ toString: 9 }` with `{ a: 0 }` makes TS ask for
  // `toString?: undefined` on the sibling — and every object inherits one that is a function.
  const written: unknown[] = [{ a: 5 }, { toString: 9 }]
  expect(setCalls(fake)).toEqual(written)

  knobs = {}
  await harness.rerender()
  await flush()
  const afterReset: unknown[] = [{ a: 5 }, { toString: 9 }, { a: 0 }]
  expect(setCalls(fake)).toEqual(afterReset)
  await harness.unmount()
})

test('a refused reset is silent and does not bump knobEpoch on its own', async () => {
  const onError = vi.fn()
  const onKnobRefused = vi.fn()
  const fake = createFakeStage({ defaults: { a: 0 } })
  let knobs: Knobs = { a: 5 }
  const harness = await renderHook(() =>
    usePaperScene({ create: async () => fake.stage, deps: [1], knobs, onError, onKnobRefused }),
  )
  await flush()
  expect(harness.result.current.knobEpoch).toBe(1)

  fake.refuseKnob('a', new Error('the slot stopped declaring a'))
  knobs = {}
  await harness.rerender()
  await flush()
  expect(harness.result.current.knobEpoch).toBe(1)
  // Both channels, not just one: removing a key is not a write, so neither report fires.
  expect(onError).not.toHaveBeenCalled()
  expect(onKnobRefused).not.toHaveBeenCalled()
  await harness.unmount()
})

test('re-adding a reset key writes it again as a live write', async () => {
  const fake = createFakeStage({ defaults: { a: 0 } })
  let knobs: Knobs = { a: 5 }
  const harness = await renderHook(() =>
    usePaperScene({ create: async () => fake.stage, deps: [1], knobs }),
  )
  await flush()
  knobs = {}
  await harness.rerender()
  await flush()
  knobs = { a: 5 }
  await harness.rerender()
  await flush()
  expect(setCalls(fake)).toEqual([{ a: 5 }, { a: 0 }, { a: 5 }])
  await harness.unmount()
})

test('a rebuild is still not a reset — nothing is written back on a deps change', async () => {
  const first = createFakeStage({ defaults: { a: 0 } })
  const second = createFakeStage({ defaults: { a: 0 } })
  let deps: readonly unknown[] = [1]
  let next = first
  const harness = await renderHook(() =>
    usePaperScene({ create: async () => next.stage, deps, knobs: { a: 5 } }),
  )
  await flush()
  deps = [2]
  next = second
  await harness.rerender()
  await flush()
  expect(setCalls(first)).toEqual([{ a: 5 }])
  expect(setCalls(second)).toEqual([{ a: 5 }])
  await harness.unmount()
})
