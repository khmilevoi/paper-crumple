/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from 'vitest'
import type { BlitStage, BlitTarget } from '../index.js'
import { ABORTED, SheetError } from '../index.js'
import { createFakeStage } from '../../../react/src/testing/fake-stage.js'
import { makeReactiveCanvas, makeReactiveStage } from '../testing/reactive-stage.js'
import { createSceneController } from './scene.js'
import { createTargetViewController, createViewController } from './view.js'

// Route the shared fake to the same real core module; source/dist Aborted symbols are nominal.
vi.mock('@paper-crumple/core', () => import('../index.js'))
afterEach(() => vi.unstubAllGlobals())

it('reattachment takes updated fit and tag inputs without changing the stable ref', async () => {
  const fake = createFakeStage()
  const scene = createSceneController(async () => fake.stage as unknown as BlitStage)
  await scene.ensure()
  const controller = createViewController({
    scene,
    source: '/a.png',
    key: 'a',
    fit: 'contain',
    onChange() {},
  })
  const ref = controller.ref
  ref(document.createElement('canvas'))
  controller.updateOptions({ fit: 'stretch', tag: 'new' })
  ref(null)
  ref(document.createElement('canvas'))
  expect(fake.views[1]?.target).toMatchObject({ fit: 'stretch', tag: 'new' })
  expect(controller.ref).toBe(ref)
  scene.dispose()
})

it('retry inside a real synchronous start leaves request() joined to the successor Run', async () => {
  const stage = await makeReactiveStage()
  const scene = createSceneController(async () => stage)
  await scene.ensure()
  let retried = false
  const controller = createViewController({
    scene,
    source: '/a.png',
    key: 'a',
    onChange() {},
    onStart: () => {
      if (retried) return
      retried = true
      void controller.retry()
    },
  })
  controller.ref(makeReactiveCanvas())
  await controller.request()
  controller.updateOptions({ source: '/b.png', key: 'b' })
  const superseded = controller.request()
  const successor = controller.request()
  let finished = false
  void successor.then(() => {
    finished = true
  })
  await Promise.resolve()
  await Promise.resolve()
  expect(finished).toBe(false)
  controller.stop()
  await Promise.all([superseded, successor])
  expect(controller.read().pending).toBe(null)
  scene.dispose()
})

it('supersession stops the actual entrance Run and only the latest request settles', async () => {
  const fake = createFakeStage()
  const scene = createSceneController(async () => fake.stage as unknown as BlitStage)
  await scene.ensure()
  const settled: string[] = []
  const controller = createViewController({
    scene,
    source: '/a.png',
    key: 'a',
    entrance: 'uncrumple',
    onChange() {},
    onSettle: (event) => settled.push(event.key),
  })
  controller.ref(document.createElement('canvas'))
  const entrance = controller.request()
  await Promise.resolve()
  await Promise.resolve()
  const run = controller.read().pending?.run
  expect(run).not.toBe(null)
  controller.updateOptions({ source: '/b.png', key: 'b' })
  const swap = controller.request()
  expect(await run?.done).toBe(ABORTED)
  expect(controller.read().pending?.key).toBe('b')
  fake.views[0]?.settleRun(undefined)
  await Promise.all([entrance, swap])
  expect(settled).toEqual(['b'])
  scene.dispose()
})

it('step observers get every step while semantic changes publish only park transitions', async () => {
  const fake = createFakeStage()
  const scene = createSceneController(async () => fake.stage as unknown as BlitStage)
  await scene.ensure()
  const changed = vi.fn()
  const step = vi.fn()
  const controller = createViewController({
    scene,
    source: '/a.png',
    key: 'a',
    onChange: changed,
    onStep: step,
  })
  controller.ref(document.createElement('canvas'))
  await controller.request()
  fake.views[0]?.emit('start', { from: 0, to: 0, via: 5 })
  changed.mockClear()
  fake.views[0]?.emit('step', { pose: 1, frame: 1, ms: 10 })
  fake.views[0]?.emit('step', { pose: 2, frame: 2, ms: 20 })
  expect(changed).not.toHaveBeenCalled()
  fake.views[0]?.emit('step', { pose: 5, frame: 5, ms: 30 })
  expect(controller.read().parked).toBe(true)
  fake.views[0]?.emit('step', { pose: 4, frame: 4, ms: 40 })
  expect(controller.read().parked).toBe(false)
  expect(changed).toHaveBeenCalledTimes(2)
  expect(step).toHaveBeenCalledTimes(4)
  scene.dispose()
})

it('retry from onError supersedes the failed settlement without stranding pending', async () => {
  let attempt = 0
  const failed = new SheetError('first source fails')
  const fake = createFakeStage({
    add: async () => (++attempt === 1 ? failed : fake.addSprite('a')),
  })
  const scene = createSceneController(async () => fake.stage as unknown as BlitStage)
  await scene.ensure()
  const settled: string[] = []
  let retry: Promise<void> | undefined
  const controller = createViewController({
    scene,
    source: '/a.png',
    key: 'a',
    onChange() {},
    onError: () => {
      retry = controller.retry()
    },
    onSettle: (event) => settled.push(event.key),
  })
  controller.ref(document.createElement('canvas'))
  await controller.request()
  await retry
  expect(controller.read().shown).toBe('a')
  expect(controller.read().error).toBe(null)
  expect(controller.read().pending).toBe(null)
  expect(settled).toEqual(['a'])
  scene.dispose()
})

it('two views share acquisition; detaching one leaves the other able to show the Sprite', async () => {
  let finish!: () => void
  const wait = new Promise<void>((resolve) => {
    finish = resolve
  })
  const fake = createFakeStage({
    add: async () => {
      await wait
      return fake.addSprite('a')
    },
  })
  const scene = createSceneController(async () => fake.stage as unknown as BlitStage)
  await scene.ensure()
  const first = createViewController({ scene, source: '/a.png', key: 'a', onChange() {} })
  const second = createViewController({ scene, source: '/a.png', key: 'a', onChange() {} })
  first.ref(document.createElement('canvas'))
  second.ref(document.createElement('canvas'))
  const requests = [first.request(), second.request()]
  first.detach()
  finish()
  await Promise.all(requests)
  expect(first.view).toBe(null)
  expect(second.read().shown).toBe('a')
  expect(fake.calls.filter((call) => call.method === 'add')).toHaveLength(1)
  expect(fake.disposed).toBe(false)
  scene.dispose()
})

it('reduced motion swaps by show and rechecks generations after consumer dispatch', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }))
  const fake = createFakeStage()
  const scene = createSceneController(async () => fake.stage as unknown as BlitStage)
  await scene.ensure()
  const settled: string[] = []
  const controller = createViewController({
    scene,
    source: '/a.png',
    key: 'a',
    onChange() {},
    onSettle: (event) => settled.push(event.key),
  })
  controller.ref(document.createElement('canvas'))
  await controller.request()
  controller.updateOptions({ source: '/b.png', key: 'b' })
  await controller.request()
  expect(controller.read().shown).toBe('b')
  expect(fake.calls.some((call) => call.method === 'view.swapTo')).toBe(false)
  expect(settled).toEqual(['a', 'b'])
  scene.dispose()
})

it('an explicit request applies the latest desired source once and keeps it for reattachment', async () => {
  const stage = await makeReactiveStage()
  const scene = createSceneController(async () => stage)
  await scene.ensure()
  const settled: string[] = []
  const controller = createViewController({
    scene,
    source: '/a.png',
    key: 'a',
    onChange() {},
    onSettle: (event) => settled.push(event.key),
  })
  controller.ref(makeReactiveCanvas())
  controller.updateOptions({ source: '/b.png', key: 'b', frameTo: 100 })
  expect(stage.get('b')).toBe(undefined)
  await controller.request()
  expect(controller.read().shown).toBe('b')
  expect(controller.read().frameStyle?.width).toBe('200px')
  expect(controller.requestGeneration).toBe(1)
  await controller.request()
  expect(controller.requestGeneration).toBe(1)
  expect(settled).toEqual(['b'])
  const sprite = controller.view?.sprite
  controller.ref(null)
  expect(stage.get('b')).toBe(sprite)
  controller.ref(makeReactiveCanvas())
  expect(controller.read().shown).toBe(null)
  await controller.request()
  expect(controller.view?.sprite).toBe(sprite)
  expect(settled).toEqual(['b', 'b'])
  scene.dispose()
})

it('raw disposal immediately invalidates the attachment and prevents a late acquisition applying', async () => {
  const stage = await makeReactiveStage()
  const scene = createSceneController(async () => stage)
  await scene.ensure()
  const settled = vi.fn()
  const controller = createViewController({
    scene,
    source: '/a.png',
    key: 'a',
    onChange() {},
    onSettle: settled,
  })
  controller.ref(makeReactiveCanvas())
  const request = controller.request()
  controller.view?.dispose()
  expect(controller.view).toBe(null)
  await request
  expect(controller.read().pending).toBe(null)
  expect(settled).not.toHaveBeenCalled()
  controller.ref(makeReactiveCanvas())
  stage.dispose()
  expect(controller.view).toBe(null)
  expect(controller.read().state).toBe('detached')
})

it('attachment creates only a View; source acquisition belongs to an explicit request', async () => {
  const stage = await makeReactiveStage()
  const scene = createSceneController(async () => stage)
  await scene.ensure()
  const target = { canvas: makeReactiveCanvas(), size: 'managed' as const }
  const createView = vi.fn((stage: typeof scene.stage & {}, destination: BlitTarget) =>
    stage.view(destination),
  )
  const controller = createTargetViewController({
    scene,
    createView,
    source: '/a.png',
    key: 'a',
    onChange() {},
  })
  controller.attach(target)
  expect(createView).toHaveBeenCalledWith(stage, target)
  expect(controller.view).not.toBe(null)
  expect(stage.get('a')).toBe(undefined)
  expect(controller.requestGeneration).toBe(0)
  expect(controller.read().pending).toBe(null)
  scene.dispose()
})

it('replacement subscribers follow attachment generations without subscribing to the old View', async () => {
  const stage = await makeReactiveStage()
  const scene = createSceneController(async () => stage)
  await scene.ensure()
  const controller = createViewController({ scene, source: '/a.png', key: 'a', onChange() {} })
  const replacements: number[] = []
  controller.subscribeReplacement(() => replacements.push(controller.attachmentGeneration))
  const canvas = makeReactiveCanvas()
  controller.ref(canvas)
  const first = controller.view
  controller.ref(canvas)
  expect(replacements).toEqual([1])
  controller.ref(null)
  expect(first?.state).toBe('disposed')
  expect(controller.view).toBe(null)
  expect(stage.disposed).toBe(false)
  controller.ref(canvas)
  expect(controller.view).not.toBe(first)
  expect(replacements).toEqual([1, 2, 3])
  scene.dispose()
})
