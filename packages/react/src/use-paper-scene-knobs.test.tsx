/**
 * @vitest-environment jsdom
 */
import { expect, test, vi } from 'vitest'
import type { BlitStage } from '@paper-crumple/core'
import type { KnobValue } from './scene-types.js'
import { usePaperScene } from './use-paper-scene.js'
import { createFakeStage, type FakeStageHandle } from './testing/fake-stage.js'
import { deferred } from './testing/deferred.js'
import { flush, renderHook } from './testing/render.js'

const setCalls = (fake: FakeStageHandle): unknown[] =>
  fake.calls.filter((c) => c.method === 'set').map((c) => c.args[0])

test('every declared knob is written once, one stage.set per key (§4.3)', async () => {
  const fake = createFakeStage()
  const harness = await renderHook(() =>
    usePaperScene({
      create: async () => fake.stage,
      deps: [1],
      knobs: { a: 1, b: 'two', c: true },
    }),
  )
  await flush()
  expect(setCalls(fake)).toEqual([{ a: 1 }, { b: 'two' }, { c: true }])
  await harness.unmount()
})

test('only changed keys reach stage.set (§9)', async () => {
  const fake = createFakeStage()
  let knobs: Readonly<Record<string, KnobValue>> = { a: 1, b: 2 }
  const harness = await renderHook(() =>
    usePaperScene({ create: async () => fake.stage, deps: [1], knobs }),
  )
  await flush()
  expect(setCalls(fake)).toHaveLength(2)

  knobs = { a: 1, b: 3 }
  await harness.rerender()
  await flush()
  expect(setCalls(fake)).toEqual([{ a: 1 }, { b: 2 }, { b: 3 }])
  await harness.unmount()
})

test('a new object with identical values writes nothing', async () => {
  const fake = createFakeStage()
  let knobs: Readonly<Record<string, KnobValue>> = { a: 1 }
  const harness = await renderHook(() =>
    usePaperScene({ create: async () => fake.stage, deps: [1], knobs }),
  )
  await flush()
  knobs = { a: 1 }
  await harness.rerender()
  await flush()
  expect(setCalls(fake)).toHaveLength(1)
  await harness.unmount()
})

test('a batch with one invalid key still writes the valid ones (§9)', async () => {
  const fake = createFakeStage()
  fake.refuseKnob('b', new Error('unknown knob b'))
  const harness = await renderHook(() =>
    usePaperScene({ create: async () => fake.stage, deps: [1], knobs: { a: 1, b: 2, c: 3 } }),
  )
  await flush()
  expect(setCalls(fake)).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }])
  await harness.unmount()
})

test('a refused key is reported through onError as an unobserved error (§0.3)', async () => {
  const onError = vi.fn()
  const refusal = new Error('unknown knob b')
  const fake = createFakeStage()
  fake.refuseKnob('b', refusal)
  const harness = await renderHook(() =>
    usePaperScene({
      create: async () => fake.stage,
      deps: [1],
      knobs: { a: 1, b: 2 },
      onError,
    }),
  )
  await flush()
  expect(onError).toHaveBeenCalledTimes(1)
  expect(onError).toHaveBeenCalledWith({ error: refusal, observed: false, view: null })
  await harness.unmount()
})

test('knobEpoch is bumped once per batch that wrote, and never by a build', async () => {
  const fake = createFakeStage()
  let knobs: Readonly<Record<string, KnobValue>> = {}
  const harness = await renderHook(() =>
    usePaperScene({ create: async () => fake.stage, deps: [1], knobs }),
  )
  await flush()
  expect(harness.result.current.knobEpoch).toBe(0)
  expect(harness.result.current.generation).toBe(1)

  knobs = { a: 1, b: 2 }
  await harness.rerender()
  await flush()
  expect(harness.result.current.knobEpoch).toBe(1)

  knobs = { a: 1, b: 2 }
  await harness.rerender()
  await flush()
  expect(harness.result.current.knobEpoch).toBe(1)

  knobs = { a: 9, b: 2 }
  await harness.rerender()
  await flush()
  expect(harness.result.current.knobEpoch).toBe(2)
  await harness.unmount()
})

test('a batch where every key is refused does not bump knobEpoch', async () => {
  const fake = createFakeStage()
  fake.refuseKnob('a', new Error('no'))
  const harness = await renderHook(() =>
    usePaperScene({ create: async () => fake.stage, deps: [1], knobs: { a: 1 } }),
  )
  await flush()
  expect(harness.result.current.knobEpoch).toBe(0)
  await harness.unmount()
})

test('a rebuild is not a reset: every moved knob is carried onto the new stage (§4.1)', async () => {
  const first = createFakeStage()
  const second = createFakeStage()
  let deps: readonly unknown[] = [1]
  let next = first
  let knobs: Readonly<Record<string, KnobValue>> = { a: 1 }
  const harness = await renderHook(() =>
    usePaperScene({ create: async () => next.stage, deps, knobs }),
  )
  await flush()
  knobs = { a: 1, b: 2 }
  await harness.rerender()
  await flush()
  expect(setCalls(first)).toEqual([{ a: 1 }, { b: 2 }])

  deps = [2]
  next = second
  await harness.rerender()
  await flush()
  expect(setCalls(second)).toEqual([{ a: 1 }, { b: 2 }])
  await harness.unmount()
})

test('a carried key the new stage refuses is skipped rather than reported (§4.1)', async () => {
  const onError = vi.fn()
  const first = createFakeStage()
  const second = createFakeStage()
  second.refuseKnob('b', new Error('this slot set does not declare b'))
  let deps: readonly unknown[] = [1]
  let next = first
  const harness = await renderHook(() =>
    usePaperScene({ create: async () => next.stage, deps, knobs: { a: 1, b: 2 }, onError }),
  )
  await flush()
  expect(onError).not.toHaveBeenCalled()

  deps = [2]
  next = second
  await harness.rerender()
  await flush()
  expect(setCalls(second)).toEqual([{ a: 1 }, { b: 2 }])
  expect(onError).not.toHaveBeenCalled()
  await harness.unmount()
})

test('a key added in the same render that changes deps is a live write, reported when refused', async () => {
  const onError = vi.fn()
  const refusal = new Error('this slot set does not declare b')
  const first = createFakeStage()
  const second = createFakeStage()
  second.refuseKnob('b', refusal)
  let deps: readonly unknown[] = [1]
  let next = first
  let knobs: Readonly<Record<string, KnobValue>> = { a: 1 }
  const harness = await renderHook(() =>
    usePaperScene({ create: async () => next.stage, deps, knobs, onError }),
  )
  await flush()
  expect(onError).not.toHaveBeenCalled()

  // Lose the first stage so the knob effect has nothing live to write onto for the render that
  // follows; this keeps the deps-change + new-key render's own pass clean of a write that would
  // otherwise land on the outgoing stage before the replacement lands.
  first.lose()
  await flush()
  // Losing the stage reports its own error through onError; that is not part of what this test
  // is checking.
  onError.mockClear()

  // `b` is new in the same render that changes `deps`: it never reached the first stage, so it
  // is a live write on the replacement stage, not a carry-forward.
  deps = [2]
  next = second
  knobs = { a: 1, b: 2 }
  await harness.rerender()
  await flush()
  expect(onError).toHaveBeenCalledTimes(1)
  expect(onError).toHaveBeenCalledWith({ error: refusal, observed: false, view: null })
  await harness.unmount()
})

test('nothing is written before the stage is ready, or after it is lost', async () => {
  const fake = createFakeStage()
  const gate = deferred<BlitStage>()
  let knobs: Readonly<Record<string, KnobValue>> = { a: 1 }
  const harness = await renderHook(() =>
    usePaperScene({ create: () => gate.promise, deps: [1], knobs }),
  )
  expect(setCalls(fake)).toHaveLength(0)
  gate.resolve(fake.stage)
  await flush()
  expect(setCalls(fake)).toHaveLength(1)

  fake.lose()
  await flush()
  knobs = { a: 2 }
  await harness.rerender()
  await flush()
  expect(setCalls(fake)).toHaveLength(1)
  await harness.unmount()
})

test('omitting knobs entirely writes nothing and never bumps knobEpoch', async () => {
  const fake = createFakeStage()
  const harness = await renderHook(() =>
    usePaperScene({ create: async () => fake.stage, deps: [1] }),
  )
  await flush()
  await harness.rerender()
  await flush()
  expect(setCalls(fake)).toHaveLength(0)
  expect(harness.result.current.knobEpoch).toBe(0)
  await harness.unmount()
})
