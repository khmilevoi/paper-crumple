import { expect, it } from 'vitest'
import { ABORTED, type View } from '../index.js'
import { createStage } from '../stage.js'
import { fakeMotion, fakeSheet, stageEnv } from '../testing/fake-slots.js'
import { makeReactiveCanvas, makeReactiveStage } from '../testing/reactive-stage.js'
import { createSceneController } from './scene.js'
import { createTargetViewController, createViewController } from './view.js'

it.each(['detach', 'dispose', 'successor', 'same target', 'stage disposal'] as const)(
  'creation lifecycle %s cannot leave an obsolete attached or registered View',
  async (operation) => {
    const stage = await createStage(
      { sheet: fakeSheet(), motion: fakeMotion(), maxSize: 384, present: 'direct' },
      stageEnv(),
    )
    if (stage === ABORTED || stage instanceof Error) return expect.fail('stage refused')
    const scene = createSceneController(async () => stage)
    await scene.ensure()
    const controller = createTargetViewController({
      scene,
      source: '/a.png',
      key: 'a',
      onChange() {},
      createView: (owner, target) => owner.view(target),
    })
    const successor = { rect: { x: 0, y: 0, w: 20, h: 20 }, tag: 'successor' }
    const initial = { rect: { x: 0, y: 0, w: 10, h: 10 }, tag: 'initial' }
    let obsolete: View | undefined
    const off = stage.changes.subscribe('lifecycle', () => {
      if (obsolete !== undefined || stage.views.length === 0) return
      obsolete = stage.views[0]
      if (operation === 'detach') controller.detach()
      if (operation === 'dispose') controller.dispose()
      if (operation === 'successor') controller.attach(successor)
      if (operation === 'same target') controller.attach(initial)
      if (operation === 'stage disposal') stage.dispose()
    })
    try {
      controller.attach(initial)
      if (operation === 'same target') {
        expect(controller.view).toBe(obsolete)
        expect(obsolete?.state).toBe('idle')
        expect(stage.views).toEqual([obsolete])
      } else if (operation === 'successor') {
        expect(obsolete?.state).toBe('disposed')
        expect(controller.view?.tag).toBe('successor')
        expect(stage.views).toEqual([controller.view])
      } else {
        expect(obsolete?.state).toBe('disposed')
        expect(controller.view).toBe(null)
        expect(stage.views).toEqual([])
      }
      controller.dispose()
      controller.dispose()
      controller.attach(successor)
      expect(controller.view).toBe(null)
      expect(stage.views).toEqual([])
    } finally {
      off()
      controller.dispose()
      scene.dispose()
    }
  },
)

it.each([
  'same canvas',
  'detach and same canvas',
  'controller detach and same canvas',
  'different canvas',
] as const)(
  'creation lifecycle ref with %s retains one usable View without a canvas claim error',
  async (operation) => {
    const stage = await makeReactiveStage()
    const scene = createSceneController(async () => stage)
    await scene.ensure()
    const controller = createViewController({
      scene,
      key: 'a',
      source: '/a.png',
      tag: 'initial',
      onChange() {},
    })
    const initial = makeReactiveCanvas()
    const next = operation === 'different canvas' ? makeReactiveCanvas() : initial
    let first: View | undefined
    const off = stage.changes.subscribe('lifecycle', () => {
      if (first !== undefined || stage.views.length === 0) return
      first = stage.views[0]
      if (operation === 'detach and same canvas') controller.ref(null)
      if (operation === 'controller detach and same canvas') controller.detach()
      if (operation !== 'same canvas') controller.updateOptions({ tag: 'next' })
      controller.ref(next)
    })
    try {
      controller.ref(initial)
      expect(controller.error).toBe(null)
      expect(controller.view).not.toBe(null)
      expect(stage.views).toEqual([controller.view])
      if (operation === 'same canvas') expect(controller.view).toBe(first)
      else {
        expect(first?.state).toBe('disposed')
        expect(controller.view?.tag).toBe('next')
      }
      expect(await controller.request()).toBe(stage.get('a'))
      expect(controller.view?.sprite?.key).toBe('a')
      expect(next.ops.length).toBeGreaterThan(0)
      controller.dispose()
      controller.dispose()
      expect(stage.views).toEqual([])
      const reclaimed = stage.view({ canvas: next })
      expect(reclaimed).not.toBeInstanceOf(Error)
      if (!(reclaimed instanceof Error)) reclaimed.dispose()
    } finally {
      off()
      controller.dispose()
      scene.dispose()
    }
  },
)
