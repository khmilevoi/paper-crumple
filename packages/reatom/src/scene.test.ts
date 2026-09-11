import { ABORTED, GlError, type Aborted, type BlitStage } from '@paper-crumple/core'
import { action, bind, computed, context, isAbort, notify, withAbort, wrap } from '@reatom/core'
import { expect, it, vi } from 'vitest'
import { reatomScene } from './scene.js'
import {
  deferred,
  isolated,
  makeDirectSceneStage,
  makeSceneStage,
  sceneFixture,
} from './testing.js'
import { makeReactiveCanvas } from '../../core/src/testing/reactive-stage.js'
import { toAsyncValue } from './result.js'

it(
  'raw Direct resize notifies surface size once while retaining the same surface',
  isolated(async () => {
    const stage = await wrap(makeDirectSceneStage())
    const scene = reatomScene({ name: 'direct.resize', create: async () => stage })
    await wrap(scene.ready())
    const surface = scene.surface()
    const seen: unknown[] = []
    const off = scene.surfaceSize.subscribe((size) => seen.push(size))
    notify()
    stage.resize(215, 115)
    stage.resize(215, 115)
    notify()
    expect(seen).toHaveLength(2)
    expect(seen.at(-1)).toEqual({ width: 215, height: 115 })
    expect(scene.surface()).toBe(surface)
    off()
    scene.dispose()
  }),
)

it(
  'allocation, direct reads, subscriptions and disposal never construct a stage',
  isolated(() => {
    const create = vi.fn(async (): Promise<Aborted> => ABORTED)
    const scene = reatomScene({ name: 'lazy', create })
    const off = scene.raw.subscribe()
    expect(scene.raw()).toBeNull()
    expect(scene.lifecycle()).toBe('idle')
    expect(scene.surfaceSize()).toBeNull()
    expect(scene.descriptors()).toEqual([])
    expect(scene.defaults()).toEqual({})
    expect(scene.appliedKnobs()).toEqual({})
    scene.dispose()
    expect(scene.lifecycle()).toBe('disposed')
    expect(create).not.toHaveBeenCalled()
    off()
  }),
)

it(
  'reads accepted settings only at semantic revisions and applies desired settings on explicit ready',
  isolated(async () => {
    const { stage } = await wrap(sceneFixture())
    const settings = vi.spyOn(stage, 'appliedKnobs', 'get')
    const scene = reatomScene({ name: 'settings', create: async () => stage })
    scene.knobs.set({ sheetTint: 0.2 })
    expect(settings).not.toHaveBeenCalled()
    await wrap(scene.ready())
    expect(scene.appliedKnobs()).toEqual({ 'sheet.sheetTint': 0.2 })
    const applied = scene.appliedKnobs()
    expect(scene.appliedKnobs()).toBe(applied)
    expect(settings).toHaveBeenCalledTimes(1)
    const seen: unknown[] = []
    const off = scene.appliedKnobs.subscribe((value) => seen.push(value))
    notify()
    stage.set({ sheetTint: 0.7 } as never)
    notify()
    expect(scene.knobs()).toEqual({ sheetTint: 0.2 })
    expect(seen).toEqual([{ 'sheet.sheetTint': 0.2 }, { 'sheet.sheetTint': 0.7 }])
    expect(settings).toHaveBeenCalledTimes(2)
    const warnings = scene.warnings()
    stage.resize(48, 32)
    expect(scene.warnings()).toBe(warnings)
    scene.knobs.set({ unknown: 2 })
    await wrap(expect(scene.ready()).rejects.toThrow())
    expect(scene.appliedKnobs()).toEqual({ 'sheet.sheetTint': 0.7 })
    off()
    scene.dispose()
  }),
)

it(
  'keeps raw orphan/loss events separate from native ready error and clears live resources',
  isolated(async () => {
    const fixture = await wrap(sceneFixture())
    const scene = reatomScene({ name: 'loss', create: async () => fixture.stage })
    const resource = scene.resource({ name: 'a', key: 'a', source: '/a.png' })
    await wrap(resource.prepare())
    const seen: unknown[] = []
    const off = scene.lastEvent.subscribe((value) => seen.push(value))
    notify()
    fixture.lose()
    notify()
    expect(scene.lifecycle()).toBe('failed')
    expect(scene.lost()).toBe(true)
    expect(scene.raw()).toBeNull()
    expect(scene.surface()).toBeNull()
    expect(resource.raw()).toBeNull()
    expect(scene.lastEvent()).toMatchObject({
      observed: false,
      view: null,
      error: expect.any(Error),
    })
    expect(seen).toHaveLength(2)
    expect(scene.ready.error()).toBeUndefined()
    scene.dispose()
    off()
  }),
)

it(
  'keeps partial aggregate play failures as native report data without frame snapshot work',
  isolated(async () => {
    const { stage, motion, timers } = await wrap(sceneFixture())
    const scene = reatomScene({ name: 'aggregate', create: async () => stage })
    const resource = scene.resource({ name: 'a', key: 'a', source: '/a.png' })
    const sprite = await wrap(resource.prepare())
    for (const tag of ['good', 'bad']) {
      const view = stage.view({ canvas: makeReactiveCanvas(), tag })
      if (view instanceof Error) return expect.fail('view refused')
      view.show(sprite)
    }
    const original = motion.draw.bind(motion)
    let calls = 0
    motion.draw = (args) => (++calls === 2 ? new GlError('one view failed') : original(args))
    const sizeRead = vi.fn(() => scene.surfaceSize())
    const size = computed(sizeRead, 'aggregate.size')
    const usage = vi.spyOn(stage, 'usage')
    const off = size.subscribe()
    notify()
    sizeRead.mockClear()
    const result = scene.play('flat', 'ball')
    await wrap(Promise.resolve())
    timers.advance(10_000)
    const report = await wrap(result)
    expect(report.failed).toHaveLength(1)
    expect(report.started).toHaveLength(1)
    expect(report.completed).toBe(false)
    expect(scene.play.data()).toBe(report)
    expect(scene.play.error()).toBeUndefined()
    expect(usage).not.toHaveBeenCalled()
    expect(sizeRead).not.toHaveBeenCalled()
    off()
    scene.dispose()
  }),
)

it(
  'calls the delayed scene factory in its model owner context',
  isolated(async () => {
    const owner = context()
    const seen: unknown[] = []
    const scene = reatomScene({
      name: 'factory.context',
      create: async () => {
        seen.push(context())
        return (await sceneFixture()).stage
      },
    })
    const stage = await wrap(scene.ready())
    expect(seen).toEqual([owner])
    scene.dispose()
    expect(stage.disposed).toBe(true)
  }),
)

it(
  'joins before native action hooks and keeps build ownership outside UI waiters',
  isolated(async () => {
    const stage = await wrap(makeSceneStage())
    const gate = deferred<BlitStage>()
    let signal: AbortSignal | undefined
    const create = vi.fn((next: AbortSignal) => {
      signal = next
      return gate.promise
    })
    const scene = reatomScene({ name: 'join', create })
    let reentered: Promise<BlitStage> | undefined
    const off = scene.lifecycle.subscribe((state) => {
      if (state === 'building') reentered = scene.ready()
    })
    notify()
    const wait = action(async () => wrap(scene.ready()), 'ui.wait').extend(withAbort())
    const ui = wait()
    const first = scene.ready()
    notify()
    expect(scene.ready()).toBe(first)
    expect(reentered).toBe(first)
    expect(scene.ready.pending()).toBe(1)
    wait.abort()
    const [outcome] = await wrap(Promise.allSettled([ui]))
    expect(outcome.status).toBe('rejected')
    expect(signal?.aborted).toBe(false)
    gate.resolve(stage)
    expect(await wrap(first)).toBe(stage)
    expect(scene.ready.data()).toBe(stage)
    expect(scene.ready.pending()).toBe(0)
    expect(scene.ready.error()).toBeUndefined()
    expect('retry' in scene.ready).toBe(false)
    expect('reset' in scene.ready).toBe(false)
    expect(create).toHaveBeenCalledTimes(1)
    scene.dispose()
    off()
  }),
)

it.each(['value', 'throw', 'abort'] as const)(
  'uses native readiness settlement for %s',
  async (kind) =>
    isolated(async () => {
      const failure = new Error('factory failed')
      const scene = reatomScene({
        name: `failure.${kind}`,
        create: async () => {
          if (kind === 'throw') return toAsyncValue<never>(failure)
          return kind === 'abort' ? ABORTED : failure
        },
      })
      const [outcome] = await wrap(Promise.allSettled([scene.ready()]))
      expect(outcome.status).toBe('rejected')
      expect(scene.ready.data()).toBeNull()
      expect(scene.ready.pending()).toBe(0)
      expect(scene.ready.error()).toBe(kind === 'abort' ? undefined : failure)
      expect(scene.lifecycle()).toBe(kind === 'abort' ? 'disposed' : 'failed')
      scene.dispose()
    })(),
)

it(
  'cancels owner readiness immediately and disposes a late stage',
  isolated(async () => {
    const gate = deferred<BlitStage>()
    const stage = await wrap(makeSceneStage())
    let signal: AbortSignal | undefined
    const scene = reatomScene({
      name: 'late',
      create: (next) => {
        signal = next
        return gate.promise
      },
    })
    const pending = scene.ready()
    await wrap(Promise.resolve())
    scene.dispose()
    const [outcome] = await wrap(Promise.allSettled([pending]))
    expect(outcome.status).toBe('rejected')
    if (outcome.status === 'rejected') expect(isAbort(outcome.reason)).toBe(true)
    expect(signal?.aborted).toBe(true)
    expect(scene.ready.error()).toBeUndefined()
    gate.resolve(stage)
    await wrap(new Promise<void>((resolve) => queueMicrotask(resolve)))
    expect(stage.disposed).toBe(true)
    expect(scene.raw()).toBeNull()
    expect(scene.lifecycle()).toBe('disposed')
  }),
)

it(
  'native observable reads stay fresh disconnected and notify connected computed consumers once',
  isolated(async () => {
    const stage = await wrap(makeSceneStage())
    const scene = reatomScene({ name: 'snapshots', create: async () => stage })
    await wrap(scene.ready())
    const usage = vi.spyOn(stage, 'usage')
    const size = scene.surfaceSize()
    const surface = scene.surface()
    stage.resize(101, 77)
    expect(scene.surfaceSize()).toEqual({ width: 101, height: 77 })
    expect(scene.surfaceSize()).not.toBe(size)
    const rows: string[] = []
    const label = computed(
      () => `${scene.surfaceSize()?.width} x ${scene.surfaceSize()?.height}`,
      'size.label',
    )
    const off = label.subscribe((value) => rows.push(value))
    notify()
    stage.resize(123, 45)
    stage.resize(123, 45)
    notify()
    expect(rows).toEqual(['101 x 77', '123 x 45'])
    expect(scene.surface()).toBe(surface)
    off()
    notify()
    stage.resize(67, 89)
    expect(scene.surfaceSize()).toEqual({ width: 67, height: 89 })
    const again: string[] = []
    const reconnect = label.subscribe((value) => again.push(value))
    notify()
    expect(again.at(-1)).toBe('67 x 89')
    expect(usage).not.toHaveBeenCalled()
    reconnect()
    scene.dispose()
  }),
)

it(
  'raw disposal clears live references and never rebuilds',
  isolated(async () => {
    const stage = await wrap(makeSceneStage())
    const create = vi.fn(async () => stage)
    const scene = reatomScene({ name: 'raw.dispose', create })
    await wrap(scene.ready())
    const states: string[] = []
    const off = scene.lifecycle.subscribe((state) => states.push(state))
    notify()
    scene.raw()!.dispose()
    notify()
    expect(states).toEqual(['ready', 'disposed'])
    expect(scene.raw()).toBeNull()
    expect(scene.surface()).toBeNull()
    expect(scene.surfaceSize()).toBeNull()
    expect(scene.ready.data()).toBe(stage)
    const [outcome] = await wrap(Promise.allSettled([scene.ready()]))
    expect(outcome.status).toBe('rejected')
    expect(create).toHaveBeenCalledTimes(1)
    off()
  }),
)

it(
  'separate owner contexts have independent models and reject foreign GPU access',
  isolated(async () => {
    const a = context()
    const sceneA = reatomScene({ name: 'a', create: makeSceneStage })
    const b = context.start()
    const sceneB = bind(() => reatomScene({ name: 'b', create: makeSceneStage }), b)()
    const stageA = await wrap(bind(sceneA.ready, a)())
    const stageB = await wrap(bind(sceneB.ready, b)())
    expect(stageA).not.toBe(stageB)
    expect(bind(sceneA.raw, a)()).toBe(stageA)
    expect(bind(sceneB.raw, b)()).toBe(stageB)
    expect(() => bind(sceneA.raw, b)()).toThrow('owner context')
    bind(sceneA.dispose, a)()
    bind(sceneB.dispose, b)()
    bind(context.reset, b)()
  }),
)
