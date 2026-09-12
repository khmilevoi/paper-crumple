import { ViewError, type View } from '@paper-crumple/core'
import { bind, wrap } from '@reatom/core'
import { expect, it, vi } from 'vitest'
import { makeReactiveCanvas } from '../../core/src/testing/reactive-stage.js'
import { asBitmap, fakeBitmap } from '../../core/src/testing/fake-source.js'
import { reatomScene } from './scene.js'
import { isolated, makeDirectSceneStage, sceneFixture } from './testing.js'

it(
  'publishes an automatic initial error when a ready Blit stage refuses a claimed canvas',
  isolated(async () => {
    const { stage } = await wrap(sceneFixture())
    const scene = reatomScene({ name: 'view.claim-refusal', create: async () => stage })
    await wrap(scene.ready())
    const canvas = makeReactiveCanvas()
    const reserved = stage.view({ canvas })
    if (reserved instanceof Error) return expect.fail('fixture canvas claim refused')
    const onError = vi.fn()
    const picture = scene.view({ name: 'picture', source: '/a.png', onError })
    try {
      picture.ref(canvas)
      for (let i = 0; i < 40; i += 1) await wrap(Promise.resolve())
      expect(picture.raw()).toBeNull()
      expect(picture.ready.error()).toMatchObject({ name: 'ViewError' })
      expect(picture.ready.error()).toBe(onError.mock.calls[0]?.[0].error)
      expect(onError).toHaveBeenCalledTimes(1)
      expect(picture.ready.pending()).toBe(0)
      expect(picture.ready.data()).toBeNull()
      reserved.dispose()
      picture.ref(canvas)
      for (let i = 0; i < 40; i += 1) await wrap(Promise.resolve())
      expect(picture.ready.error()).toBeUndefined()
      expect(picture.sprite()).not.toBeNull()
    } finally {
      scene.dispose()
    }
  }),
)

it(
  'publishes the queued successor factory refusal after obsolete creation returns',
  isolated(async () => {
    const stage = await wrap(makeDirectSceneStage())
    const scene = reatomScene({ name: 'view.queued-refusal', create: async () => stage })
    await wrap(scene.ready())
    const failure = new ViewError('successor factory refused')
    const picture = scene.view({
      name: 'picture',
      source: '/a.png',
      createView: (owner, target) => (target.tag === 'successor' ? failure : owner.view(target)),
    })
    let entered = false
    const off = stage.changes.subscribe(
      'lifecycle',
      bind(() => {
        if (entered || stage.views.length === 0) return
        entered = true
        picture.attach({ rect: { x: 0, y: 0, w: 20, h: 20 }, tag: 'successor' })
      }),
    )
    try {
      picture.attach({ rect: { x: 0, y: 0, w: 10, h: 10 } })
      for (let i = 0; i < 40; i += 1) await wrap(Promise.resolve())
      expect(picture.ready.error()).toBe(failure)
      expect(picture.ready.pending()).toBe(0)
      expect(picture.ready.data()).toBeNull()
      expect(stage.views).toEqual([])
    } finally {
      off()
      scene.dispose()
    }
  }),
)

it(
  'does not publish an obsolete refusal after its error callback attaches a successor',
  isolated(async () => {
    const stage = await wrap(makeDirectSceneStage())
    const scene = reatomScene({ name: 'view.refusal-recovery', create: async () => stage })
    await wrap(scene.ready())
    const picture = scene.view({
      name: 'picture',
      key: 'a',
      source: '/a.png',
      createView: (owner, target) =>
        target.tag === 'refused' ? new ViewError('refused') : owner.view(target),
      onError: () => picture.attach({ rect: { x: 0, y: 0, w: 20, h: 20 }, tag: 'successor' }),
    })
    const errors: unknown[] = []
    const off = picture.ready.error.subscribe((error) => errors.push(error))
    try {
      picture.attach({ rect: { x: 0, y: 0, w: 10, h: 10 }, tag: 'refused' })
      for (let i = 0; i < 40; i += 1) await wrap(Promise.resolve())
      expect(errors.filter((error) => error !== undefined)).toEqual([])
      expect(picture.ready.error()).toBeUndefined()
      expect(picture.shown()).toBe('a')
      expect(picture.ready.data()).toBe(picture.sprite())
      expect(picture.raw()?.tag).toBe('successor')
    } finally {
      off()
      scene.dispose()
    }
  }),
)

it(
  'publishes a Direct factory refusal through automatic readiness',
  isolated(async () => {
    const stage = await wrap(makeDirectSceneStage())
    const scene = reatomScene({ name: 'view.factory-refusal', create: async () => stage })
    await wrap(scene.ready())
    const failure = new ViewError('factory refused')
    const factory = vi.fn(() => failure)
    const picture = scene.view({ name: 'picture', source: '/a.png', createView: factory })
    try {
      picture.attach({ rect: { x: 0, y: 0, w: 10, h: 10 } })
      for (let i = 0; i < 40; i += 1) await wrap(Promise.resolve())
      expect(picture.ready.error()).toBe(failure)
      expect(picture.ready.pending()).toBe(0)
      expect(picture.ready.data()).toBeNull()
      expect(picture.raw()).toBeNull()
      expect(factory).toHaveBeenCalledTimes(1)
    } finally {
      scene.dispose()
    }
  }),
)

it.each(
  (['different canvas', 'same canvas', 'detach and same canvas', 'dispose'] as const).flatMap(
    (operation) => [true, false].map((preload) => ({ operation, preload })),
  ),
)(
  'auto-ready waits for authoritative adoption after $operation (preload: $preload)',
  async ({ operation, preload }) =>
    isolated(async () => {
      const { stage } = await wrap(sceneFixture())
      const scene = reatomScene({ name: 'view.creation', create: async () => stage })
      if (preload) await wrap(scene.ready())
      const settled = vi.fn()
      const originalSource = vi.fn(async () => asBitmap(fakeBitmap()))
      const successorSource = vi.fn(async () => asBitmap(fakeBitmap()))
      const picture = scene.view({
        name: 'picture',
        key: 'a',
        source: originalSource,
        onSettle: settled,
      })
      const errors: unknown[] = []
      const offError = picture.ready.error.subscribe((error) => errors.push(error))
      const initial = makeReactiveCanvas()
      const next = operation === 'different canvas' ? makeReactiveCanvas() : initial
      let first: View | undefined
      const off = stage.changes.subscribe(
        'lifecycle',
        bind(() => {
          if (first !== undefined || stage.views.length === 0) return
          first = stage.views[0]
          if (operation === 'dispose') {
            picture.dispose()
            picture.ref(next)
            return
          }
          picture.source.set(() => successorSource)
          picture.options.set({ key: 'b', onSettle: settled })
          if (operation === 'detach and same canvas') picture.ref(null)
          picture.ref(next)
        }),
      )
      try {
        picture.ref(initial)
        // Observe automatic readiness without calling ready(), which would retry and mask the bug.
        for (let i = 0; i < 40; i += 1) await wrap(Promise.resolve())
        expect(errors.filter((error) => error !== undefined)).toEqual([])
        expect(picture.ready.pending()).toBe(0)
        expect(originalSource).not.toHaveBeenCalled()
        if (operation === 'dispose') {
          expect(picture.raw()).toBeNull()
          expect(picture.ready.data()).toBeNull()
          expect(stage.views).toEqual([])
          expect(settled).not.toHaveBeenCalled()
          expect(successorSource).not.toHaveBeenCalled()
        } else {
          expect(picture.shown()).toBe('b')
          expect(successorSource).toHaveBeenCalledTimes(1)
          expect(picture.ready.data()).toBe(picture.sprite())
          expect(stage.views).toEqual([picture.raw()])
          expect(settled).toHaveBeenCalledTimes(1)
          expect(next.ops.length).toBeGreaterThan(0)
          if (operation === 'same canvas') expect(picture.raw()).toBe(first)
          else expect(first?.state).toBe('disposed')
        }
      } finally {
        off()
        offError()
        scene.dispose()
      }
    })(),
)

it(
  'automatically readies the typed successor adopted after a factory callback',
  isolated(async () => {
    const stage = await wrap(makeDirectSceneStage())
    const scene = reatomScene({ name: 'view.typed-creation', create: async () => stage })
    await wrap(scene.ready())
    const picture = scene.view({
      name: 'picture',
      key: 'a',
      source: '/a.png',
      createView: (owner, target) => owner.view(target),
    })
    const initial = { rect: { x: 0, y: 0, w: 10, h: 10 }, tag: 'initial' }
    const successor = { rect: { x: 0, y: 0, w: 20, h: 20 }, tag: 'successor' }
    let first: View | undefined
    const off = stage.changes.subscribe(
      'lifecycle',
      bind(() => {
        if (first !== undefined || stage.views.length === 0) return
        first = stage.views[0]
        picture.attach(successor)
      }),
    )
    try {
      picture.attach(initial)
      for (let i = 0; i < 40; i += 1) await wrap(Promise.resolve())
      expect(picture.ready.error()).toBeUndefined()
      expect(picture.raw()?.tag).toBe('successor')
      expect(picture.shown()).toBe('a')
      expect(picture.ready.data()).toBe(picture.sprite())
      expect(stage.views).toEqual([picture.raw()])
      expect(first?.state).toBe('disposed')
    } finally {
      off()
      scene.dispose()
    }
  }),
)
