import { ABORTED, type BlitStage } from '@paper-crumple/core'
import { atom, bind, computed, context, isAbort, notify, top, wrap } from '@reatom/core'
import { afterEach, expect, it, vi } from 'vitest'
import { makeReactiveCanvas } from '../../core/src/testing/reactive-stage.js'
import { reatomScene } from './scene.js'
import { deferred, isolated, makeDirectSceneStage, sceneFixture } from './testing.js'
import { createFakeStage } from '../../react/src/testing/fake-stage.js'
import { asBitmap, fakeBitmap } from '../../core/src/testing/fake-source.js'

afterEach(() => vi.unstubAllGlobals())

it.each(['manual detach', 'raw disposal'] as const)(
  'reuses the stable canvas ref after %s',
  async (operation) =>
    isolated(async () => {
      const { stage } = await wrap(sceneFixture())
      const scene = reatomScene({ name: 'view.ref-cache', create: async () => stage })
      const picture = scene.view({ name: 'picture', source: '/a.png' })
      const canvas = makeReactiveCanvas()
      const ref = picture.ref
      ref(canvas)
      const sprite = await wrap(picture.ready())
      const original = picture.raw()!
      if (operation === 'manual detach') picture.attach(null)
      else original.dispose()
      expect(picture.raw()).toBeNull()
      ref(canvas)
      expect(picture.raw()).not.toBeNull()
      expect(picture.raw()).not.toBe(original)
      expect(await wrap(picture.ready())).toBe(sprite)
      expect(picture.ref).toBe(ref)
      scene.dispose()
    })(),
)

it(
  'reattaches the identical typed target after its raw View is disposed',
  isolated(async () => {
    const { stage } = await wrap(sceneFixture())
    const scene = reatomScene({ name: 'view.target-cache', create: async () => stage })
    const picture = scene.view({ name: 'picture', source: '/a.png' })
    const target = { canvas: makeReactiveCanvas() }
    picture.attach(target)
    const sprite = await wrap(picture.ready())
    const original = picture.raw()!
    original.dispose()
    picture.attach(target)
    expect(picture.raw()).not.toBeNull()
    expect(picture.raw()).not.toBe(original)
    expect(await wrap(picture.ready())).toBe(sprite)
    scene.dispose()
  }),
)

it(
  'preserves a reattachment issued by the outgoing initial Run end callback',
  isolated(async () => {
    const { stage, timers } = await wrap(sceneFixture())
    const scene = reatomScene({ name: 'view.attach-reentrant', create: async () => stage })
    const entered = deferred<void>()
    let reattach = false
    const picture = scene.view({
      name: 'picture',
      source: '/a.png',
      entrance: 'uncrumple',
      duration: 100,
      onStart: () => entered.resolve(),
      onEnd: () => {
        if (reattach) {
          reattach = false
          picture.ref(makeReactiveCanvas())
        }
      },
    })
    picture.ref(makeReactiveCanvas())
    const first = picture.ready().catch((error: unknown) => error)
    await wrap(entered.promise)
    reattach = true
    picture.ref(null)
    const second = picture.ready()
    for (let i = 0; i < 40; i += 1) {
      timers.advance(1000)
      await wrap(Promise.resolve())
    }
    expect(isAbort(await wrap(first))).toBe(true)
    const sprite = await wrap(second)
    expect(picture.raw()).not.toBeNull()
    expect(picture.sprite()).toBe(sprite)
    scene.dispose()
  }),
)

it(
  'shares explicit resources and refuses conflicting sources across separate view models',
  isolated(async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    const { stage } = await wrap(sceneFixture())
    const scene = reatomScene({ name: 'view.keys', create: async () => stage })
    const resource = scene.resource({ name: 'resource', key: 'shared', source: '/a.png' })
    const prepared = await wrap(resource.prepare())
    const a = scene.view({ name: 'a', key: 'shared', source: '/a.png' })
    a.ref(makeReactiveCanvas())
    expect(await wrap(a.ready())).toBe(prepared)
    const b = scene.view({ name: 'b', key: 'shared', source: '/b.png' })
    b.ref(makeReactiveCanvas())
    await wrap(expect(b.ready()).rejects.toThrow('replace'))
    expect(b.sprite()).toBeNull()
    const replaced = await wrap(resource.replace('/b.png'))
    expect(await wrap(b.ready())).toBe(replaced)
    a.source.set('/b.png')
    expect(await wrap(a.ready())).toBe(replaced)
    scene.dispose()
  }),
)

it(
  'returns a failed RunModel synchronously when play has no target',
  isolated(async () => {
    const scene = reatomScene<BlitStage>({
      name: 'view.no-play-target',
      create: async () => ABORTED,
    })
    const picture = scene.view({ name: 'picture', source: '/a.png' })
    const run = picture.play('flat', 'ball')
    expect(run).not.toBeInstanceOf(Promise)
    await wrap(expect(run.completion.done).rejects.toMatchObject({ name: 'ViewError' }))
    expect(run.completion.error()).toBeTruthy()
    scene.dispose()
  }),
)

it(
  'detaching one acquisition waiter leaves another consumer and the stage alive',
  isolated(async () => {
    const { stage } = await wrap(sceneFixture())
    const scene = reatomScene({ name: 'view.detach-acquire', create: async () => stage })
    const entered = deferred<void>()
    const image = deferred<ImageBitmap>()
    const source = () => {
      entered.resolve()
      return image.promise
    }
    const a = scene.view({ name: 'a', key: 'shared', source })
    const b = scene.view({ name: 'b', key: 'shared', source })
    a.ref(makeReactiveCanvas())
    b.ref(makeReactiveCanvas())
    const old = a.ready().catch((error: unknown) => error)
    const joined = b.ready()
    await wrap(entered.promise)
    a.ref(null)
    expect(isAbort(await wrap(old))).toBe(true)
    image.resolve(asBitmap(fakeBitmap()))
    const sprite = await wrap(joined)
    expect(a.raw()).toBeNull()
    expect(b.sprite()).toBe(sprite)
    expect(scene.raw()).toBe(stage)
    scene.dispose()
  }),
)

it(
  'rejects a detached swap before starting the scene',
  isolated(async () => {
    const create = vi.fn(async (): Promise<typeof ABORTED> => ABORTED)
    const scene = reatomScene<BlitStage>({ name: 'view.absent', create })
    const picture = scene.view({ name: 'view.picture', source: '/a.png' })
    await wrap(expect(picture.swap('/b.png')).rejects.toMatchObject({ name: 'ViewError' }))
    expect(picture.swap.error()).toBeTruthy()
    expect(create).not.toHaveBeenCalled()
    scene.dispose()
  }),
)

it(
  'joins automatic initial readiness and creates a new raw View on reattachment',
  isolated(async () => {
    const { stage } = await wrap(sceneFixture())
    const build = deferred<BlitStage>()
    const create = vi.fn(() => build.promise)
    const scene = reatomScene({ name: 'view.attach', create })
    const picture = scene.view({ name: 'view.picture', source: '/a.png' })
    const ref = picture.ref
    ref(makeReactiveCanvas())
    const first = picture.ready()
    expect(picture.ready()).toBe(first)
    expect(picture.ready.pending()).toBe(1)
    build.resolve(stage)
    const sprite = await wrap(first)
    const raw = picture.raw()
    expect(raw?.sprite).toBe(sprite)
    expect(picture.ready.data()).toBe(sprite)
    expect(create).toHaveBeenCalledTimes(1)
    ref(null)
    expect(raw?.state).toBe('disposed')
    expect(picture.raw()).toBeNull()
    expect(scene.raw()).toBe(stage)
    ref(makeReactiveCanvas())
    await wrap(picture.ready())
    expect(picture.ref).toBe(ref)
    expect(picture.raw()).not.toBe(raw)
    expect(picture.raw()?.sprite).toBe(sprite)
    scene.dispose()
    expect(picture.raw()).toBeNull()
  }),
)

it(
  'routes first-image failure to ready.error and permits retry without swap',
  isolated(async () => {
    const { stage } = await wrap(sceneFixture())
    const failed = new Error('first image refused')
    let attempts = 0
    const supplier = () => {
      attempts += 1
      return Promise.reject(failed)
    }
    const scene = reatomScene({ name: 'view.initial-error', create: async () => stage })
    const picture = scene.view({ name: 'view.picture', source: supplier })
    picture.ref(makeReactiveCanvas())
    await wrap(expect(picture.ready()).rejects.toBeInstanceOf(Error))
    expect(picture.ready.error()).toBeTruthy()
    expect(picture.swap.error()).toBeUndefined()
    expect(scene.lifecycle()).toBe('ready')
    expect(attempts).toBe(1)
    picture.source.set('/retry.png')
    const sprite = await wrap(picture.ready())
    expect(picture.ready.data()).toBe(sprite)
    expect(picture.ready.error()).toBeUndefined()
    scene.dispose()
  }),
)

it(
  'cancels the initial generation while building and keeps the replacement generation',
  isolated(async () => {
    const { stage } = await wrap(sceneFixture())
    const build = deferred<BlitStage>()
    const scene = reatomScene({ name: 'view.generation', create: () => build.promise })
    const picture = scene.view({ name: 'view.picture', source: '/a.png' })
    picture.ref(makeReactiveCanvas())
    const first = picture.ready().catch((error: unknown) => error)
    picture.ref(null)
    picture.source.set('/b.png')
    picture.ref(makeReactiveCanvas())
    const second = picture.ready()
    build.resolve(stage)
    expect(await wrap(first)).toMatchObject({ name: 'AbortError' })
    const sprite = await wrap(second)
    expect(picture.ready.data()).toBe(sprite)
    expect(picture.raw()?.sprite).toBe(sprite)
    expect(picture.ready.error()).toBeUndefined()
    scene.dispose()
  }),
)

it(
  'reads current render while disconnected and preserves unchanged value/ref/style identities',
  isolated(async () => {
    vi.stubGlobal('document', { createElement: makeReactiveCanvas })
    const fake = createFakeStage()
    const scene = reatomScene({ name: 'view.render', create: async () => fake.stage })
    const picture = scene.view({ name: 'view.picture', source: '/a.png', frameTo: 100 })
    const empty = picture.render()
    expect(empty).toEqual({ ref: picture.ref, shown: null, frameStyle: null })
    empty.ref(makeReactiveCanvas())
    const sprite = await wrap(picture.ready())
    const raw = picture.raw()!
    const handle = fake.views[0]!
    handle.setFrame({ box: { w: 200, h: 160 }, artwork: { x: 20, y: 10, w: 100, h: 80 } })
    const first = picture.render()
    expect(first.frameStyle).toEqual({
      width: '200px',
      height: '160px',
      left: '-20px',
      top: '-10px',
    })
    expect(first.shown).toBe(sprite.key)
    expect(picture.render()).toBe(first)
    handle.setFrame({ box: { w: 200, h: 160 }, artwork: { x: 20, y: 10, w: 100, h: 80 } })
    expect(picture.render()).toBe(first)
    raw.show(null)
    expect(picture.render().shown).toBeNull()
    raw.show(sprite)
    const computedRender = computed(() => picture.render(), 'render.consumer')
    const seen: unknown[] = []
    const off = computedRender.subscribe((value) => seen.push(value))
    notify()
    handle.setFrame({ box: { w: 300, h: 160 }, artwork: { x: 20, y: 10, w: 100, h: 80 } })
    notify()
    expect(computedRender().frameStyle?.width).toBe('300px')
    expect(seen.at(-1)).toBe(picture.render())
    off()
    notify()
    raw.show(null)
    const reconnected: unknown[] = []
    const offAgain = picture.render.subscribe((value) => reconnected.push(value.shown))
    notify()
    expect(reconnected).toEqual([null])
    offAgain()
    picture.ref(null)
    picture.ref(makeReactiveCanvas())
    await wrap(picture.ready())
    expect(picture.render().ref).toBe(first.ref)
    expect(picture.render().shown).toBe(sprite.key)
    scene.dispose()
  }),
)

it(
  'keeps render and frame reads out of 100 step events',
  isolated(async () => {
    vi.stubGlobal('document', { createElement: makeReactiveCanvas })
    const fake = createFakeStage()
    const scene = reatomScene({ name: 'view.steps', create: async () => fake.stage })
    const picture = scene.view({ name: 'view.picture', source: '/a.png', frameTo: 100 })
    picture.ref(makeReactiveCanvas())
    await wrap(picture.ready())
    const handle = fake.views[0]!
    const readFrame = vi.spyOn(handle.view, 'frame', 'get')
    const renderChanges = vi.fn()
    const off = picture.render.subscribe(renderChanges)
    notify()
    readFrame.mockClear()
    renderChanges.mockClear()
    for (let i = 0; i < 100; i += 1) handle.emit('step', { pose: i, frame: i * 2, ms: i * 10 })
    notify()
    expect(readFrame).not.toHaveBeenCalled()
    expect(renderChanges).not.toHaveBeenCalled()
    off()
    scene.dispose()
  }),
)

it(
  'returns a synchronous RunModel and preserves synchronous command Result values',
  isolated(async () => {
    const { stage, timers } = await wrap(sceneFixture())
    const scene = reatomScene({ name: 'view.commands', create: async () => stage })
    const picture = scene.view({ name: 'view.picture', source: '/a.png' })
    expect(picture.readPose()).toBeNull()
    expect(picture.set({ motionTilt: 0.4 })).toBeInstanceOf(Error)
    picture.ref(makeReactiveCanvas())
    await wrap(picture.ready())
    const run = picture.play('flat', 'ball', { duration: 100 })
    expect(run).not.toBeInstanceOf(Promise)
    expect(picture.state()).toBe('playing')
    timers.advance(1000)
    await wrap(run.completion.done)
    expect(picture.state()).toBe('idle')
    expect(picture.readPose()).toBe(5)
    expect(picture.draw(2)).toBeUndefined()
    expect(picture.readPose()).toBe(2)
    expect(picture.set({ motionTilt: 0.4 })).toBeUndefined()
    expect(picture.appliedKnobs()).toEqual({ 'motion.motionTilt': 0.4 })
    expect(picture.set({ motionTilt: 99 })).toBeInstanceOf(Error)
    expect(picture.appliedKnobs()).toEqual({ 'motion.motionTilt': 0.4 })
    const cancelled = picture.play('flat', 'ball')
    picture.ref(null)
    expect(isAbort(await wrap(cancelled.completion.done.catch((error: unknown) => error)))).toBe(
      true,
    )
    scene.dispose()
  }),
)

it(
  'new swaps cancel the predecessor before its delayed source can show or fail',
  isolated(async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    const { stage } = await wrap(sceneFixture())
    const scene = reatomScene({ name: 'view.latest', create: async () => stage })
    const picture = scene.view({ name: 'picture', source: '/initial.png' })
    picture.ref(makeReactiveCanvas())
    const initial = await wrap(picture.ready())
    const wait = deferred<ImageBitmap>()
    const entered = deferred<void>()
    const old = picture
      .swap(() => {
        entered.resolve()
        return wait.promise
      })
      .catch((error: unknown) => error)
    await wrap(entered.promise)
    const latest = await wrap(picture.swap('/latest.png'))
    expect(isAbort(await wrap(old))).toBe(true)
    wait.reject(new Error('late failure'))
    await wrap(Promise.resolve())
    expect(picture.sprite()).toBe(latest)
    expect(picture.swap.data()).toBe(latest)
    expect(picture.swap.error()).toBeUndefined()
    expect(picture.ready.data()).toBe(initial)
    scene.dispose()
  }),
)

it(
  'cancels initial acquisition when swap supersedes it and retains stage-owned shared work',
  isolated(async () => {
    const { stage } = await wrap(sceneFixture())
    const scene = reatomScene({ name: 'view.shared', create: async () => stage })
    const wait = deferred<ImageBitmap>()
    const entered = deferred<void>()
    const supplier = vi.fn(() => {
      entered.resolve()
      return wait.promise
    })
    const a = scene.view({ name: 'a', source: supplier, key: 'shared' })
    const b = scene.view({ name: 'b', source: supplier, key: 'shared' })
    a.ref(makeReactiveCanvas())
    b.ref(makeReactiveCanvas())
    const initial = a.ready().catch((error: unknown) => error)
    const other = b.ready()
    await wrap(entered.promise)
    a.options.set({})
    const next = await wrap(a.swap('/new.png'))
    expect(isAbort(await wrap(initial))).toBe(true)
    wait.resolve(asBitmap(fakeBitmap()))
    const shared = await wrap(other)
    expect(supplier).toHaveBeenCalledTimes(1)
    expect(b.sprite()).toBe(shared)
    expect(a.sprite()).toBe(next)
    expect(a.ready.data()).toBeNull()
    expect(stage.get('shared')).toBe(shared)
    scene.dispose()
  }),
)

it(
  'stops the actual entrance Run when swapping and resists reentrant onEnd replacement',
  isolated(async () => {
    const { stage, timers } = await wrap(sceneFixture())
    const scene = reatomScene({ name: 'view.reentrant', create: async () => stage })
    const started = deferred<void>()
    let replace = false
    let replacement: Promise<unknown> | undefined
    const picture = scene.view({
      name: 'picture',
      source: '/a.png',
      entrance: 'uncrumple',
      duration: 100,
      onStart: () => started.resolve(),
      onEnd: () => {
        if (replace) {
          replace = false
          replacement = picture.swap('/c.png')
        }
      },
    })
    picture.ref(makeReactiveCanvas())
    const initial = picture.ready().catch((error: unknown) => error)
    await wrap(started.promise)
    const actualRun = picture.raw()!.run!
    replace = true
    const b = picture.swap('/b.png').catch((error: unknown) => error)
    for (let i = 0; i < 40; i += 1) {
      timers.advance(1000)
      await wrap(Promise.resolve())
    }
    expect(await wrap(actualRun.done)).toBe(ABORTED)
    expect(isAbort(await wrap(initial))).toBe(true)
    expect(isAbort(await wrap(b))).toBe(true)
    const c = await wrap(replacement!)
    expect(picture.sprite()).toBe(c)
    expect(picture.swap.data()).toBe(c)
    scene.dispose()
  }),
)

it(
  'applies desired settings only at a successful explicit request and rejects implicit key changes',
  isolated(async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    const { stage } = await wrap(sceneFixture())
    const scene = reatomScene({ name: 'view.desired', create: async () => stage })
    const settled: unknown[] = []
    const picture = scene.view({
      name: 'picture',
      source: '/a.png',
      key: 'a',
      frameTo: 100,
      onSettle: (event) => settled.push(event),
    })
    picture.knobs.set({ motionTilt: 0.3 })
    picture.ref(makeReactiveCanvas())
    const initial = await wrap(picture.ready())
    const rendered = picture.render()
    picture.source.set('/b.png')
    picture.options.set({ key: 'a', frameTo: 200 })
    picture.knobs.set({ motionTilt: 99 })
    expect(picture.sprite()).toBe(initial)
    expect(picture.render()).toBe(rendered)
    await wrap(expect(picture.swap('/b.png')).rejects.toBeInstanceOf(Error))
    expect(picture.appliedKnobs()).toEqual({ 'motion.motionTilt': 0.3 })
    expect(picture.render()).toBe(rendered)
    picture.knobs.set({})
    await wrap(expect(picture.swap('/b.png')).rejects.toThrow('replace'))
    expect(picture.sprite()).toBe(initial)
    expect(settled[0]).toMatchObject({ key: 'a', error: null, reduced: true })
    scene.dispose()
  }),
)

it(
  'uses the supplied noncanvas factory and omits render/ref at runtime',
  isolated(async () => {
    const stage = await wrap(makeDirectSceneStage())
    const scene = reatomScene({ name: 'view.direct', create: async () => stage })
    const picture = scene.view({
      name: 'picture',
      source: '/a.png',
      createView: (stage, target) => stage.view(target),
    })
    expect(picture).not.toHaveProperty('ref')
    expect(picture).not.toHaveProperty('render')
    picture.attach({ rect: { x: 0, y: 0, w: 100, h: 80 } })
    const sprite = await wrap(picture.ready())
    expect(picture.sprite()).toBe(sprite)
    picture.attach(null)
    expect(picture.state()).toBe('detached')
    scene.dispose()
  }),
)

it(
  'keeps the newest swap issued by a cancelled swap onEnd callback',
  isolated(async () => {
    const { stage, timers } = await wrap(sceneFixture())
    const scene = reatomScene({ name: 'view.swap-reentrant', create: async () => stage })
    let replacing = false
    let latest: Promise<unknown> | undefined
    const picture = scene.view({
      name: 'picture',
      source: '/a.png',
      duration: 100,
      onEnd: () => {
        if (replacing) {
          replacing = false
          latest = picture.swap('/d.png')
        }
      },
    })
    picture.ref(makeReactiveCanvas())
    await wrap(picture.ready())
    const b = picture.swap('/b.png').catch((error: unknown) => error)
    replacing = true
    const c = picture.swap('/c.png').catch((error: unknown) => error)
    for (let i = 0; i < 40; i += 1) {
      timers.advance(1000)
      await wrap(Promise.resolve())
    }
    expect(isAbort(await wrap(b))).toBe(true)
    expect(isAbort(await wrap(c))).toBe(true)
    const d = await wrap(latest!)
    expect(picture.sprite()).toBe(d)
    expect(picture.source()).toBe('/d.png')
    scene.dispose()
  }),
)

it(
  'rejects a foreign-context command without invalidating the owner initial request',
  isolated(async () => {
    const owner = context()
    const { stage } = await wrap(sceneFixture())
    const build = deferred<BlitStage>()
    const scene = reatomScene({ name: 'view.foreign', create: () => build.promise })
    const picture = scene.view({ name: 'picture', source: '/a.png' })
    picture.ref(makeReactiveCanvas())
    const ready = picture.ready()
    const foreign = context.start()
    await wrap(
      expect(
        Promise.resolve().then(() => bind(() => picture.swap('/foreign.png'), foreign)()),
      ).rejects.toThrow('owner context'),
    )
    bind(() => build.resolve(stage), owner)()
    const sprite = await wrap(ready)
    expect(picture.sprite()).toBe(sprite)
    scene.dispose()
  }),
)

it(
  'runs retained suppliers and external lifecycle callbacks in the model owner frame',
  isolated(async () => {
    const owner = context()
    const marker = atom(37, 'view.owner.marker')
    const { stage, timers } = await wrap(sceneFixture())
    const seen: unknown[] = []
    const record = () => seen.push([context() === owner, top() === owner, marker()])
    const scene = reatomScene({ name: 'view.owner', create: async () => stage })
    const picture = scene.view({
      name: 'picture',
      source: async () => {
        record()
        await wrap(Promise.resolve())
        record()
        return asBitmap(fakeBitmap())
      },
      onSettle: record,
      onStart: record,
      onEnd: record,
    })
    await wrap(Promise.resolve().then(() => picture.ref(makeReactiveCanvas())))
    await wrap(picture.ready())
    const run = picture.play('flat', 'ball', { duration: 100 })
    await wrap(Promise.resolve().then(() => timers.advance(1000)))
    await wrap(run.completion.done)
    expect(seen).toEqual(Array.from({ length: 5 }, () => [true, true, 37]))
    picture.ref(null)
    scene.dispose()
  }),
)

it(
  'retries the same initial source after failure and terminal disposal cannot recreate a View',
  isolated(async () => {
    const { stage } = await wrap(sceneFixture())
    let calls = 0
    const scene = reatomScene({ name: 'view.retry', create: async () => stage })
    const picture = scene.view({
      name: 'picture',
      source: async () => {
        calls += 1
        if (calls === 1) return Promise.reject(new Error('temporary source failure'))
        return asBitmap(fakeBitmap())
      },
    })
    picture.ref(makeReactiveCanvas())
    await wrap(expect(picture.ready()).rejects.toBeInstanceOf(Error))
    const sprite = await wrap(picture.ready())
    expect(picture.sprite()).toBe(sprite)
    expect(calls).toBe(2)
    expect(picture.ready.error()).toBeUndefined()
    scene.dispose()
    picture.ref(null)
    picture.ref(makeReactiveCanvas())
    expect(picture.raw()).toBeNull()
    await wrap(expect(picture.ready()).rejects.toBeDefined())
  }),
)
