import { action, bind, computed, context, isAbort, notify, withAbort, wrap } from '@reatom/core'
import { expect, it, vi } from 'vitest'
import { makeReactiveCanvas } from '../../core/src/testing/reactive-stage.js'
import { asBitmap, fakeBitmap } from '../../core/src/testing/fake-source.js'
import { reatomScene } from './scene.js'
import { deferred, isolated, sceneFixture } from './testing.js'

it(
  'caches model identity per key, refuses implicit source replacement, and prepares lazily',
  isolated(async () => {
    const fixture = await wrap(sceneFixture())
    const create = vi.fn(async () => fixture.stage)
    const scene = reatomScene({ name: 'resource.cache', create })
    const a = scene.resource({ name: 'a', key: 'a', source: '/a.png' })
    const off = a.raw.subscribe()
    notify()
    expect(a.raw()).toBeNull()
    expect(a.resident()).toBe(false)
    expect(a.frontSize()).toBeNull()
    expect(a.rect()).toBeNull()
    expect(a.attachCount()).toBe(0)
    expect(a.pinned()).toBe(false)
    expect(a.appliedKnobs()).toEqual({})
    expect(scene.resource({ name: 'alias', key: 'a', source: '/a.png' })).toBe(a)
    expect(() => scene.resource({ name: 'conflict', key: 'a', source: '/b.png' })).toThrow(
      'replace',
    )
    expect(create).not.toHaveBeenCalled()
    const b = scene.resource({ name: 'b', key: 'b', source: '/b.png' })
    const [rawA, rawB] = await wrap(Promise.all([a.prepare(), b.prepare()]))
    expect(create).toHaveBeenCalledTimes(1)
    expect(a.raw()).toBe(rawA)
    expect(b.raw()).toBe(rawB)
    expect(a.prepare.data()).toBe(rawA)
    fixture.stage.dispose()
    expect(a.raw()).toBeNull()
    expect(b.raw()).toBeNull()
    expect(a.prepare.data()).toBe(rawA)
    off()
  }),
)

it(
  'keeps desired source and knobs separate from accepted raw state',
  isolated(async () => {
    const { stage } = await wrap(sceneFixture())
    const scene = reatomScene({ name: 'desired', create: async () => stage })
    const a = scene.resource({ name: 'a', key: 'a', source: '/a.png' })
    a.knobs.set({ motionTilt: 0.4 })
    const raw = await wrap(a.prepare())
    const size = a.frontSize()
    expect(a.frontSize()).toBe(size)
    expect(a.appliedKnobs()).toEqual({ 'motion.motionTilt': 0.4 })
    expect(a.appliedKnobs()).toBe(a.appliedKnobs())
    raw.set({ motionTilt: 0.8 } as never)
    expect(a.knobs()).toEqual({ motionTilt: 0.4 })
    expect(a.appliedKnobs()).toEqual({ 'motion.motionTilt': 0.8 })
    a.source.set('/b.png')
    await wrap(expect(a.prepare()).rejects.toThrow('replace'))
    expect(a.raw()).toBe(raw)
    a.knobs.set({ nonsense: 1 })
    a.source.set('/a.png')
    await wrap(expect(a.prepare()).rejects.toThrow())
    expect(a.appliedKnobs()).toEqual({ 'motion.motionTilt': 0.8 })
    a.knobs.set({})
    const before = a.rect()
    await wrap(a.replace(() => Promise.resolve(asBitmap(fakeBitmap({ width: 80, height: 30 })))))
    expect(a.rect()).not.toEqual(before)
    const replacementSource = a.source()
    await wrap(stage.replace('a', '/c.png'))
    expect(a.source()).toBe(replacementSource)
    expect(a.raw()).toBe(stage.get('a'))
    scene.dispose()
  }),
)

it(
  'tracks raw residency, pin, attachment, removal and replacement with connected native observables',
  isolated(async () => {
    const { stage } = await wrap(sceneFixture())
    const scene = reatomScene({ name: 'raw.resources', create: async () => stage })
    const a = scene.resource({ name: 'a', key: 'a', source: '/a.png' })
    const raw = await wrap(a.prepare())
    await wrap(stage.add('/b.png', { key: 'b' }))
    const rows: string[] = []
    const status = computed(
      () => `${a.resident()}:${a.pinned()}:${a.attachCount()}`,
      'resource.status',
    )
    const off = status.subscribe((value) => rows.push(value))
    notify()
    stage.budget({ bytes: 0 })
    notify()
    expect(a.resident()).toBe(false)
    stage.budget({ bytes: Infinity })
    expect(await wrap(a.prepare())).toBe(raw)
    stage.pin('a')
    notify()
    expect(a.pinned()).toBe(true)
    stage.unpin('a')
    const view = stage.view({ canvas: makeReactiveCanvas() })
    if (view instanceof Error) return expect.fail('view refused')
    view.show(raw)
    notify()
    expect(a.attachCount()).toBe(1)
    expect(() => a.remove()).toThrow()
    expect(a.raw()).toBe(raw)
    expect(a.remove({ detach: true })).toBeUndefined()
    notify()
    expect(a.raw()).toBeNull()
    expect(view.state).toBe('disposed')
    expect(rows).toContain('false:false:0')
    off()
    notify()
    const next = await wrap(stage.add('/a.png', { key: 'a' }))
    expect(a.raw()).toBe(next)
    expect(a.resident()).toBe(true)
    const reconnect = status.subscribe()
    notify()
    stage.pin('a')
    notify()
    expect(a.pinned()).toBe(true)
    reconnect()
    scene.dispose()
  }),
)

it(
  'one cancelled prepare waiter cannot cancel stage-owned acquisition',
  isolated(async () => {
    const { stage, sheet } = await wrap(sceneFixture())
    const gate = deferred<ImageBitmap>()
    const source = vi.fn(() => gate.promise)
    const scene = reatomScene({ name: 'acquire.owner', create: async () => stage })
    const a = scene.resource({ name: 'a', key: 'shared', source })
    await wrap(scene.ready())
    const wait = action(async () => wrap(a.prepare()), 'ui.prepare').extend(withAbort())
    const first = wait()
    await wrap(Promise.resolve())
    const second = a.prepare()
    const firstOutcome = Promise.allSettled([first])
    wait.abort()
    const bitmap = fakeBitmap()
    gate.resolve(asBitmap(bitmap))
    expect(await wrap(second)).toBe(stage.get('shared'))
    const [outcome] = await wrap(firstOutcome)
    expect(outcome.status).toBe('rejected')
    if (outcome.status === 'rejected') expect(isAbort(outcome.reason)).toBe(true)
    expect(source).toHaveBeenCalledTimes(1)
    expect(sheet.calls.source).toHaveLength(1)
    expect(bitmap.closes).toBe(1)
    scene.dispose()
  }),
)

it(
  'borrowed bitmap ownership survives prepare, replacement, removal and scene disposal',
  isolated(async () => {
    const { stage } = await wrap(sceneFixture())
    const scene = reatomScene({ name: 'borrowed', create: async () => stage })
    const bitmap = fakeBitmap()
    const next = fakeBitmap({ width: 50 })
    const a = scene.resource({ name: 'a', key: 'a', source: asBitmap(bitmap), pin: true })
    await wrap(a.prepare())
    expect(a.pinned()).toBe(true)
    await wrap(a.replace(asBitmap(next), { pin: true }))
    a.remove()
    scene.dispose()
    expect(bitmap.closes).toBe(0)
    expect(next.closes).toBe(0)
  }),
)

it(
  'resource cache and desired inputs belong to their model context',
  isolated(async () => {
    const owner = context()
    const scene = reatomScene({ name: 'owner', create: async () => (await sceneFixture()).stage })
    const resource = scene.resource({ name: 'a', key: 'a', source: '/a.png' })
    const foreign = context.start()
    const other = bind(
      () => reatomScene({ name: 'other', create: async () => (await sceneFixture()).stage }),
      foreign,
    )()
    const otherResource = bind(
      () => other.resource({ name: 'a', key: 'a', source: '/a.png' }),
      foreign,
    )()
    expect(resource).not.toBe(otherResource)
    expect(() => bind(resource.raw, foreign)()).toThrow('owner context')
    bind(scene.dispose, owner)()
    bind(other.dispose, foreign)()
    bind(context.reset, foreign)()
  }),
)

it(
  'scene disposal promptly cancels prepare and a late owned supplier bitmap is released',
  isolated(async () => {
    const { stage } = await wrap(sceneFixture())
    const gate = deferred<ImageBitmap>()
    const entered = deferred<void>()
    const source = () => {
      entered.resolve()
      return gate.promise
    }
    const scene = reatomScene({ name: 'late.resource', create: async () => stage })
    const resource = scene.resource({ name: 'a', key: 'a', source })
    const prepare = resource.prepare()
    const settled = Promise.allSettled([prepare])
    await wrap(entered.promise)
    scene.dispose()
    // Cancellation must finish without waiting for an arbitrary supplier to cooperate.
    const outcome = await wrap(
      Promise.race([
        settled,
        new Promise<string>((resolve) => setTimeout(() => resolve('still pending'), 0)),
      ]),
    )
    expect(outcome).not.toBe('still pending')
    const bitmap = fakeBitmap()
    gate.resolve(asBitmap(bitmap))
    await wrap(new Promise<void>((resolve) => setTimeout(resolve, 0)))
    expect(bitmap.closes).toBe(1)
    expect(resource.raw()).toBeNull()
    expect(resource.prepare.data()).toBeNull()
    expect(resource.prepare.error()).toBeUndefined()
  }),
)

it(
  'disconnect removes snapshot listeners and reconnect binds only the current raw sprite',
  isolated(async () => {
    const { stage } = await wrap(sceneFixture())
    const scene = reatomScene({ name: 'cleanup', create: async () => stage })
    const resource = scene.resource({ name: 'a', key: 'a', source: '/a.png' })
    const old = await wrap(resource.prepare())
    const original = old.changes.subscribe.bind(old.changes)
    const cleanups: Array<ReturnType<typeof vi.fn>> = []
    const subscribe = vi.spyOn(old.changes, 'subscribe').mockImplementation((area, callback) => {
      const off = vi.fn(original(area, callback))
      cleanups.push(off)
      return off
    })
    const off = resource.appliedKnobs.subscribe()
    notify()
    expect(subscribe).toHaveBeenCalledTimes(1)
    stage.remove('a')
    const next = await wrap(stage.add('/new.png', { key: 'a' }))
    if (next instanceof Error || typeof next === 'symbol') return expect.fail('add refused')
    const nextSubscribe = vi.spyOn(next.changes, 'subscribe')
    const reconnect = resource.frontSize.subscribe()
    notify()
    expect(cleanups.every((cleanup) => cleanup.mock.calls.length === 1)).toBe(true)
    expect(nextSubscribe).toHaveBeenCalledWith('geometry', expect.any(Function))
    off()
    reconnect()
    notify()
    expect(subscribe).toHaveBeenCalledTimes(1)
    scene.dispose()
  }),
)
