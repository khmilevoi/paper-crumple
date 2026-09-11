import {
  action,
  atom,
  bind,
  computed,
  context,
  isAbort,
  notify,
  top,
  withAbort,
  wrap,
} from '@reatom/core'
import { expect, it, vi } from 'vitest'
import { makeReactiveCanvas } from '../../core/src/testing/reactive-stage.js'
import { asBitmap, fakeBitmap } from '../../core/src/testing/fake-source.js'
import { reatomScene } from './scene.js'
import { deferred, isolated, sceneFixture } from './testing.js'

it(
  'blocks source claims during replacement and restores the old descriptor after failure',
  isolated(async () => {
    const { stage } = await wrap(sceneFixture())
    const scene = reatomScene({ name: 'replacement.claim', create: async () => stage })
    const oldSource = async () => asBitmap(fakeBitmap({ width: 40 }))
    const resource = scene.resource({ name: 'resource', key: 'shared', source: oldSource })
    await wrap(resource.prepare())
    const entered = deferred<void>()
    const image = deferred<ImageBitmap>()
    const newSource = () => {
      entered.resolve()
      return image.promise
    }
    const replacement = resource.replace(newSource).catch((error: unknown) => error)
    await wrap(entered.promise)
    resource.source.set(() => oldSource)
    const oldPrepare = resource.prepare().catch((error: unknown) => error)
    image.reject(new Error('replacement failed'))
    expect(await wrap(replacement)).toBeInstanceOf(Error)
    expect(await wrap(oldPrepare)).toBeInstanceOf(Error)
    expect(resource.prepare.error()?.message).toContain('replacement')
    expect(scene.resource({ name: 'alias', key: 'shared', source: oldSource })).toBe(resource)
    const restored = await wrap(resource.prepare())
    expect(restored.rect.w).toBe(40)
    expect(() => scene.resource({ name: 'invalid', key: 'shared', source: newSource })).toThrow(
      'replace',
    )
    scene.dispose()
  }),
)

it(
  'a prepare started before explicit replacement cannot register the replaced source as its own',
  isolated(async () => {
    const { stage } = await wrap(sceneFixture())
    const scene = reatomScene({ name: 'replacement.settlement', create: async () => stage })
    const a = async () => asBitmap(fakeBitmap({ width: 40 }))
    const b = async () => asBitmap(fakeBitmap({ width: 80 }))
    const resource = scene.resource({ name: 'resource', key: 'shared', source: a })
    await wrap(resource.prepare())
    const old = resource.prepare().catch((error: unknown) => error)
    const replacement = await wrap(resource.replace(b))
    expect(isAbort(await wrap(old))).toBe(true)
    expect(resource.prepare.error()).toBeUndefined()
    expect(replacement.rect.w).toBe(80)
    expect(scene.resource({ name: 'alias', key: 'shared', source: b })).toBe(resource)
    expect(() => scene.resource({ name: 'invalid', key: 'shared', source: a })).toThrow('replace')
    expect(await wrap(resource.prepare())).toBe(replacement)
    scene.dispose()
  }),
)

it(
  'refuses a changed desired source while a view owns the original pending acquisition',
  isolated(async () => {
    const { stage } = await wrap(sceneFixture())
    const entered = deferred<void>()
    const image = deferred<ImageBitmap>()
    const original = vi.fn(() => {
      entered.resolve()
      return image.promise
    })
    const changed = vi.fn(async () => asBitmap(fakeBitmap({ width: 80 })))
    const scene = reatomScene({ name: 'pending.source-identity', create: async () => stage })
    const resource = scene.resource({ name: 'resource', key: 'shared', source: original })
    resource.source.set(() => changed)
    const a = scene.view({ name: 'a', key: 'shared', source: original })
    a.ref(makeReactiveCanvas())
    const ready = a.ready()
    await wrap(entered.promise)
    const prepare = resource.prepare().catch((error: unknown) => error)
    for (let i = 0; i < 10; i += 1) await wrap(Promise.resolve())
    image.resolve(asBitmap(fakeBitmap({ width: 40 })))
    const sprite = await wrap(ready)
    expect(await wrap(prepare)).toBeInstanceOf(Error)
    expect(resource.prepare.error()?.message).toContain('replace')
    expect(scene.resource({ name: 'alias', key: 'shared', source: original })).toBe(resource)
    const b = scene.view({ name: 'b', key: 'shared', source: changed })
    b.ref(makeReactiveCanvas())
    await wrap(expect(b.ready()).rejects.toThrow('replace'))
    expect(b.sprite()).toBeNull()
    expect(sprite.rect.w).toBe(40)
    resource.source.set(() => original)
    expect(await wrap(resource.prepare())).toBe(sprite)
    expect(original).toHaveBeenCalledTimes(1)
    expect(changed).not.toHaveBeenCalled()
    scene.dispose()
  }),
)

it.each(['initial', 'replacement', 'evicted'] as const)(
  'retained %s suppliers read and resume in the model owner context',
  async (phase) =>
    isolated(async () => {
      const owner = context()
      const width = atom(41, `supplier.${phase}.width`)
      const { stage } = await wrap(sceneFixture())
      const scene = reatomScene({ name: `supplier.${phase}`, create: async () => stage })
      const bitmaps: ReturnType<typeof fakeBitmap>[] = []
      const seen: unknown[] = []
      const ownedFrames: boolean[] = []
      let requiresContext = phase !== 'evicted'
      const supplier = vi.fn(async () => {
        if (requiresContext) {
          seen.push([context(), width()])
          ownedFrames.push(top() === owner)
          await wrap(Promise.resolve())
          seen.push([context(), width()])
          ownedFrames.push(top() === owner)
        }
        const bitmap = fakeBitmap({ width: 41 })
        bitmaps.push(bitmap)
        return asBitmap(bitmap)
      })
      const source = phase === 'replacement' ? '/initial.png' : supplier
      const resource = scene.resource({ name: 'a', key: 'a', source })
      const add = vi.spyOn(stage, 'add')
      try {
        await wrap(resource.prepare())
        if (phase === 'replacement') await wrap(resource.replace(supplier))
        if (phase === 'evicted') {
          requiresContext = true
          await wrap(stage.add('/other.png', { key: 'other' }))
          stage.budget({ bytes: 0 })
          expect(resource.resident()).toBe(false)
          stage.budget({ bytes: Infinity })
          // The retained callback must also work when raw core is invoked outside Reatom.
          const prepared = await wrap(Promise.resolve().then(() => stage.prepare('a')))
          expect(prepared).toBe(resource.raw())
          expect(resource.resident()).toBe(true)
        }
        expect(seen).toEqual([
          [owner, 41],
          [owner, 41],
        ])
        expect(ownedFrames).toEqual([true, true])
        expect(resource.source()).toBe(supplier)
        expect(scene.resource({ name: 'alias', key: 'a', source: supplier })).toBe(resource)
        if (phase === 'initial') {
          const bound = add.mock.calls[0]?.[0]
          expect(bound).not.toBe(supplier)
          const calls = supplier.mock.calls.length
          resource.source()
          resource.raw()
          resource.frontSize()
          expect(supplier).toHaveBeenCalledTimes(calls)
          resource.remove()
          await wrap(resource.prepare())
          expect(add.mock.calls[1]?.[0]).toBe(bound)
        }
      } finally {
        scene.dispose()
      }
      expect(bitmaps.length).toBeGreaterThan(0)
      expect(bitmaps.every((bitmap) => bitmap.closes === 1)).toBe(true)
    })(),
)

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
