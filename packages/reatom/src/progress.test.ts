import { atom, bind, context, notify, wrap } from '@reatom/core'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createFakeStage } from '../../react/src/testing/fake-stage.js'
import { makeReactiveCanvas } from '../../core/src/testing/reactive-stage.js'
import { reatomScene } from './scene.js'
import { isolated } from './testing.js'

beforeEach(() => vi.stubGlobal('document', { createElement: makeReactiveCanvas }))
afterEach(() => vi.unstubAllGlobals())

it(
  'subscribes step only while observed and rebinds raw View replacement',
  isolated(async () => {
    const fake = createFakeStage()
    const scene = reatomScene({ name: 'progress.scene', create: async () => fake.stage })
    const picture = scene.view({ name: 'picture', source: '/a.png' })
    picture.ref(makeReactiveCanvas())
    await wrap(picture.ready())
    const first = fake.views[0]!
    const originalOn = first.view.on
    let activeSteps = 0
    const subscribed = vi.spyOn(first.view, 'on').mockImplementation((event, listener) => {
      const off = originalOn(event, listener)
      if (event === 'step') activeSteps += 1
      return () => {
        if (event === 'step') activeSteps -= 1
        off()
      }
    })
    expect(picture.progress()).toBeNull()
    for (let i = 0; i < 100; i += 1) first.emit('step', { pose: i, frame: i * 2, ms: i * 10 })
    expect(picture.progress()).toBeNull()
    expect(subscribed).not.toHaveBeenCalled()
    const changes = vi.fn()
    const off = picture.progress.subscribe(changes)
    notify()
    expect(subscribed.mock.calls.map(([event]) => event)).toEqual(['step'])
    expect(activeSteps).toBe(1)
    first.view.draw(2)
    first.emit('step', { pose: 2, frame: 4, ms: 17 })
    notify()
    expect(picture.progress()).toEqual({ pose: 2, frame: 4, ms: 17 })
    expect(changes).toHaveBeenLastCalledWith({ pose: 2, frame: 4, ms: 17 })
    off()
    notify()
    expect(activeSteps).toBe(0)
    const count = changes.mock.calls.length
    first.view.draw(3)
    first.emit('step', { pose: 3, frame: 6, ms: 29 })
    notify()
    expect(changes).toHaveBeenCalledTimes(count)
    const again = picture.progress.subscribe(changes)
    notify()
    expect(picture.progress()).toBeNull()
    picture.ref(null)
    picture.ref(makeReactiveCanvas())
    await wrap(picture.ready())
    expect(picture.progress()).toBeNull()
    expect(activeSteps).toBe(0)
    const second = fake.views[1]!
    second.view.draw(4)
    second.emit('step', { pose: 4, frame: 8, ms: 40 })
    notify()
    expect(picture.progress()).toEqual({ pose: 4, frame: 8, ms: 40 })
    first.emit('step', { pose: 1, frame: 2, ms: 1 })
    expect(picture.progress()).toEqual({ pose: 4, frame: 8, ms: 40 })
    again()
    notify()
    expect(scene.raw()).toBe(fake.stage)
    scene.dispose()
  }),
)

it(
  'binds externally delivered progress to its non-default model context',
  isolated(async () => {
    const owner = context()
    const marker = atom('owner', 'progress.marker')
    const fake = createFakeStage()
    const scene = reatomScene({ name: 'progress.owner', create: async () => fake.stage })
    const picture = scene.view({ name: 'picture', source: '/a.png' })
    await wrap(Promise.resolve().then(() => picture.ref(makeReactiveCanvas())))
    await wrap(picture.ready())
    const seen: unknown[] = []
    const off = picture.progress.subscribe((sample) => seen.push([context(), marker(), sample]))
    notify()
    await wrap(
      Promise.resolve().then(() => {
        fake.views[0]!.view.draw(2)
        fake.views[0]!.emit('step', { pose: 2, frame: 4, ms: 23 })
      }),
    )
    notify()
    expect(seen.at(-1)).toEqual([owner, 'owner', { pose: 2, frame: 4, ms: 23 }])
    const foreign = context.start()
    expect(() => bind(() => picture.progress(), foreign)()).toThrow('owner context')
    off()
    scene.dispose()
  }),
)
