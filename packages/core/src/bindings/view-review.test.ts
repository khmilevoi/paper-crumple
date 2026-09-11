/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from 'vitest'
import { ABORTED, SheetError, type BlitStage, type Sprite } from '../index.js'
import { createFakeStage } from '../../../react/src/testing/fake-stage.js'
import { makeReactiveCanvas, makeReactiveStage } from '../testing/reactive-stage.js'
import { createSceneController } from './scene.js'
import { createTargetViewController, createViewController } from './view.js'
import { createStage } from '../stage.js'
import { fakeMotion, fakeSheet, stageEnv } from '../testing/fake-slots.js'
import { createFakeTimers } from '../testing/fake-timers.js'
import { unwrap } from '../unwrap.js'

vi.mock('@paper-crumple/core', () => import('../index.js'))
afterEach(() => vi.unstubAllGlobals())

it('omitting onStep installs no raw step listener and performs no per-frame binding work', async () => {
  const fake = createFakeStage()
  const scene = createSceneController(async () => fake.stage as unknown as BlitStage)
  await scene.ensure()
  const changed = vi.fn()
  const subscribed: string[] = []
  const controller = createTargetViewController({
    scene,
    key: 'a',
    source: '/a.png',
    onChange: changed,
    createView(stage, target) {
      const view = stage.view(target)
      if (view instanceof Error) return view
      const on = view.on.bind(view)
      vi.spyOn(view, 'on').mockImplementation((event, listener) => {
        subscribed.push(event)
        return on(event, listener)
      })
      return view
    },
  })
  controller.attach({ canvas: document.createElement('canvas') })
  await controller.request()
  expect(subscribed.filter((event) => event === 'step')).toHaveLength(0)
  fake.views[0]?.emit('start', { from: 0, to: 0, via: 5 })
  changed.mockClear()
  fake.views[0]?.emit('step', { pose: 5, frame: 5, ms: 10 })
  fake.views[0]?.emit('step', { pose: 4, frame: 4, ms: 20 })
  expect(changed).not.toHaveBeenCalled()
  scene.dispose()
})

it.each(['change', 'settle', 'error'] as const)(
  '%s listener exceptions are surfaced without interrupting request completion',
  async (callback) => {
    const queued: Array<() => void> = []
    vi.stubGlobal('queueMicrotask', (run: () => void) => queued.push(run))
    const listenerError = new Error('listener failed')
    const sourceError = new SheetError('source failed')
    const fake = createFakeStage({
      add: async () => (callback === 'error' ? sourceError : fake.addSprite('a')),
    })
    const scene = createSceneController(async () => fake.stage as unknown as BlitStage)
    await scene.ensure()
    let active = false
    const fail = () => {
      if (active) unwrap(listenerError)
    }
    const controller = createViewController({
      scene,
      key: 'a',
      source: '/a.png',
      onChange: () => {
        if (callback === 'change') fail()
      },
      onSettle: () => {
        if (callback === 'settle') fail()
      },
      onError: () => {
        if (callback === 'error') fail()
      },
    })
    controller.attach({ canvas: document.createElement('canvas') })
    active = true
    let result: ReturnType<typeof controller.request> | undefined
    expect(() => {
      result = controller.request()
    }).not.toThrow()
    expect(await result).toBe(callback === 'error' ? sourceError : fake.sprites.get('a'))
    expect(controller.pending).toBe(false)
    expect(queued.length).toBeGreaterThan(0)
    expect(() => queued[0]?.()).toThrow(listenerError)
    active = false
    scene.dispose()
  },
)

it('generation subscribers synchronously observe coherent request supersession', async () => {
  const stage = await makeReactiveStage()
  const scene = createSceneController(async () => stage)
  await scene.ensure()
  const controller = createViewController({ scene, key: 'a', source: '/a.png', onChange() {} })
  controller.attach({ canvas: makeReactiveCanvas() })
  await controller.request()
  const observed: Array<{
    generation: number
    key: string | null
    pending: boolean
    attached: boolean
  }> = []
  controller.subscribeReplacement(() =>
    observed.push({
      generation: controller.requestGeneration,
      key: controller.requested,
      pending: controller.pending,
      attached: controller.view !== null,
    }),
  )
  const b = controller.request('b', '/b.png')
  const c = controller.request('c', '/c.png')
  try {
    expect(observed).toEqual([
      { generation: 2, key: 'b', pending: true, attached: true },
      { generation: 3, key: 'c', pending: true, attached: true },
    ])
  } finally {
    controller.stop()
    await Promise.all([b, c])
    scene.dispose()
  }
})

it.each(['change', 'start'] as const)(
  'same-key request reentered from %s joins the exact current promise',
  async (event) => {
    const stage = await makeReactiveStage()
    const scene = createSceneController(async () => stage)
    await scene.ensure()
    let joined: ReturnType<ReturnType<typeof createViewController>['request']> | undefined
    const join = () => {
      if (controller.requested === 'b' && joined === undefined)
        joined = controller.request('b', '/b.png')
    }
    const controller = createViewController({
      scene,
      key: 'a',
      source: '/a.png',
      onChange: () => {
        if (event === 'change') join()
      },
      onStart: () => {
        if (event === 'start') join()
      },
    })
    controller.attach({ canvas: makeReactiveCanvas() })
    await controller.request()
    const current = controller.request('b', '/b.png')
    try {
      expect(joined).toBe(current)
    } finally {
      controller.stop()
      await current
      scene.dispose()
    }
  },
)

it.each(['shown', 'pending'] as const)(
  'late prepare A cannot overwrite B while B is %s',
  async (phase) => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    let finishA!: (error: Error) => void
    const pendingA = new Promise<Error>((resolve) => {
      finishA = resolve
    })
    let finishB!: (sprite: Sprite) => void
    const pendingB = new Promise<Sprite>((resolve) => {
      finishB = resolve
    })
    let preparing = false
    const fake = createFakeStage({
      sprites: ['a', 'b'],
      prepare: async (key) => {
        if (key === 'a' && preparing) return pendingA as Promise<InstanceType<typeof SheetError>>
        if (key === 'b' && phase === 'pending') return pendingB
        return fake.sprites.get(key)!
      },
    })
    const scene = createSceneController(async () => fake.stage as unknown as BlitStage)
    await scene.ensure()
    const onError = vi.fn()
    const controller = createViewController({
      scene,
      key: 'a',
      source: '/a.png',
      onChange() {},
      onError,
    })
    controller.attach({ canvas: document.createElement('canvas') })
    await controller.request()
    preparing = true
    controller.prepare()
    const next = controller.request('b', '/b.png')
    if (phase === 'shown') await next
    finishA(new SheetError('stale A preparation'))
    for (let i = 0; i < 5; i += 1) await Promise.resolve()
    expect(controller.error).toBe(null)
    expect(onError).not.toHaveBeenCalled()
    expect(fake.calls.filter((call) => call.method === 'view.refresh')).toHaveLength(0)
    expect(controller.requested).toBe('b')
    expect(controller.pending).toBe(phase === 'pending')
    finishB(fake.sprites.get('b')! as unknown as Sprite)
    await next
    scene.dispose()
  },
)

it('animated fresh-key requests share one pinned stage acquisition after one View detaches', async () => {
  let finish!: () => void
  let gate = Promise.resolve()
  const sheet = fakeSheet({ gate: () => gate })
  const timers = createFakeTimers()
  const built = await createStage(
    { sheet, motion: fakeMotion(), maxSize: 384, present: 'blit' },
    stageEnv({ timers }),
  )
  if (built === ABORTED || built instanceof Error) return expect.fail('stage setup refused')
  const scene = createSceneController(async () => built)
  await scene.ensure()
  const first = createViewController({ scene, key: 'a', source: '/a.png', onChange() {} })
  const second = createViewController({ scene, key: 'a', source: '/a.png', onChange() {} })
  first.attach({ canvas: makeReactiveCanvas() })
  second.attach({ canvas: makeReactiveCanvas() })
  await Promise.all([first.request(), second.request()])
  gate = new Promise<void>((resolve) => {
    finish = resolve
  })
  const left = first.request('b', '/b.png', { pin: true })
  const right = second.request('b', '/b.png', { pin: true })
  first.detach()
  finish()
  for (let i = 0; i < 30; i += 1) {
    await Promise.resolve()
    timers.advance(100)
  }
  const result = await right
  expect(result).toBe(built.get('b'))
  expect(result).not.toBeInstanceOf(Error)
  expect(second.view?.sprite?.key).toBe('b')
  expect(second.view?.sprite?.pinned).toBe(true)
  expect(sheet.calls.source).toHaveLength(2)
  expect(await left).toBe(ABORTED)
  expect(built.disposed).toBe(false)
  scene.dispose()
})

it('the baseline controller returns acquired Sprite results and exposes request/frame state', async () => {
  const stage = await makeReactiveStage()
  const scene = createSceneController(async () => stage)
  await scene.ensure()
  const controller = createViewController({
    scene,
    key: 'initial',
    source: '/initial.png',
    onChange() {},
  })
  controller.attach({ canvas: makeReactiveCanvas() })
  const result = controller.request('hero', '/hero.png')
  expect(controller.requested).toBe('hero')
  expect(controller.pending).toBe(true)
  expect(await result).toBe(stage.get('hero'))
  expect(controller.pending).toBe(false)
  expect(controller.error).toBe(null)
  expect(controller.frame).toEqual(controller.view?.frame)
  expect(controller.set({ 'motion.motionTilt': 0.6 })).toBe(undefined)
  expect(controller.view?.appliedKnobs['motion.motionTilt']).toBe(0.6)
  expect(controller.draw(99)).toBeInstanceOf(Error)
  const run = controller.play('flat', 'ball')
  expect(run).not.toBeInstanceOf(Error)
  if (!(run instanceof Error)) run.stop()
  controller.attach(null)
  expect(controller.view).toBe(null)
  scene.dispose()
})

it.each(['initial', 'reduced'] as const)(
  'a %s request honors pin for an already resident Sprite',
  async (mode) => {
    const stage = await makeReactiveStage()
    const scene = createSceneController(async () => stage)
    await scene.ensure()
    const resident = await stage.add('/b.png', { key: 'b' })
    if (resident === ABORTED || resident instanceof Error)
      return expect.fail('sprite setup refused')
    const controller = createViewController({
      scene,
      key: 'a',
      source: '/a.png',
      onChange() {},
    })
    controller.attach({ canvas: makeReactiveCanvas() })
    if (mode === 'reduced') {
      await controller.request()
      vi.stubGlobal('matchMedia', () => ({ matches: true }))
    }
    expect(resident.pinned).toBe(false)
    expect(await controller.request('b', '/b.png', { pin: true })).toBe(resident)
    expect(resident.pinned).toBe(true)
    scene.dispose()
  },
)

it('detached commands return domain errors and disposal is terminal only for the controller', async () => {
  const stage = await makeReactiveStage()
  const scene = createSceneController(async () => stage)
  await scene.ensure()
  const controller = createViewController({ scene, key: 'a', source: '/a.png', onChange() {} })
  expect(await controller.request('a', '/a.png')).toBeInstanceOf(Error)
  expect(controller.play('flat', 'ball')).toBeInstanceOf(Error)
  expect(controller.draw('flat')).toBeInstanceOf(Error)
  expect(controller.set({})).toBeInstanceOf(Error)
  controller.attach({ canvas: makeReactiveCanvas() })
  controller.dispose()
  controller.attach({ canvas: makeReactiveCanvas() })
  expect(controller.view).toBe(null)
  expect(await controller.request('a', '/a.png')).toBeInstanceOf(Error)
  expect(stage.disposed).toBe(false)
  scene.dispose()
})

it('request cancellation returns ABORTED and never applies its acquired result', async () => {
  let finish!: () => void
  const pending = new Promise<void>((resolve) => {
    finish = resolve
  })
  const fake = createFakeStage({
    add: async () => {
      await pending
      return fake.addSprite('a')
    },
  })
  const scene = createSceneController(async () => fake.stage as unknown as BlitStage)
  await scene.ensure()
  const controller = createViewController({ scene, key: 'a', source: '/a.png', onChange() {} })
  controller.attach({ canvas: document.createElement('canvas') })
  const cancel = new AbortController()
  const result = controller.request('a', '/a.png', { signal: cancel.signal })
  cancel.abort()
  finish()
  expect(await result).toBe(ABORTED)
  expect(controller.view?.sprite).toBe(null)
  expect(controller.pending).toBe(false)
  scene.dispose()
})
