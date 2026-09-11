import { isAborted, type DirectStage } from '@paper-crumple/core'
import { isAbort, wrap } from '@reatom/core'
import { expect, it } from 'vitest'
import { createStage } from '../../core/src/stage.js'
import { createFakeTimers } from '../../core/src/testing/fake-timers.js'
import { fakeMotion, fakeSheet, stageEnv } from '../../core/src/testing/fake-slots.js'
import { reatomScene } from './scene.js'
import { isolated } from './testing.js'

async function grid() {
  const timers = createFakeTimers()
  const raw = await createStage(
    { sheet: fakeSheet(), motion: fakeMotion(), maxSize: 384, present: 'direct' },
    stageEnv({ timers }),
  )
  if (raw instanceof Error || isAborted(raw)) return expect.fail('stage refused')
  const stage = raw as unknown as DirectStage
  const sprite = await stage.add('/shared.png', { key: 'shared' })
  if (sprite instanceof Error || isAborted(sprite)) return expect.fail('sprite refused')
  for (const tag of ['first', 'second', 'third']) {
    const view = stage.view({ tag, rect: { x: 0, y: 0, w: 64, h: 64 } })
    if (view instanceof Error) return expect.fail('view refused')
    view.show(sprite)
  }
  const starts: string[] = []
  stage.on('start', (event) => {
    if (event.view !== null) starts.push(event.view.tag!)
  })
  return { stage, timers, starts }
}

it.each([false, true])(
  'native scene play abort prevents delayed starts with caller signal=%s',
  async (withCaller) =>
    isolated(async () => {
      const { stage, timers, starts } = await wrap(grid())
      const scene = reatomScene({ name: 'play.abort', create: async () => stage })
      await wrap(scene.ready())
      const settled = Promise.allSettled([
        scene.play('flat', 'ball', {
          stagger: 100,
          ...(withCaller ? { signal: new AbortController().signal } : {}),
        }),
      ])
      expect(starts).toEqual(['first'])
      scene.play.abort()
      timers.advance(10_000)
      const [outcome] = await wrap(settled)
      expect(outcome.status).toBe('rejected')
      if (outcome.status === 'rejected') expect(isAbort(outcome.reason)).toBe(true)
      expect(starts).toEqual(['first'])
      expect(scene.play.error()).toBeUndefined()
      expect(scene.play.pending()).toBe(0)
      scene.dispose()
    })(),
)

it(
  'superseding scene play cancels old delayed starts without interrupting its successor',
  isolated(async () => {
    const { stage, timers, starts } = await wrap(grid())
    const scene = reatomScene({ name: 'play.latest', create: async () => stage })
    await wrap(scene.ready())
    const first = Promise.allSettled([scene.play('flat', 'ball', { stagger: 100 })])
    const second = scene.play('ball', 'flat', { duration: 500 })
    timers.advance(10_000)
    const report = await wrap(second)
    expect(report.completed).toBe(true)
    expect(starts).toEqual(['first', 'first', 'second', 'third'])
    expect((await wrap(first))[0].status).toBe('rejected')
    expect(scene.play.data()).toBe(report)
    expect(scene.play.error()).toBeUndefined()
    scene.dispose()
  }),
)

it(
  'caller signal still cancels active and delayed Direct plays',
  isolated(async () => {
    const { stage, timers, starts } = await wrap(grid())
    const scene = reatomScene({ name: 'play.caller', create: async () => stage })
    await wrap(scene.ready())
    const caller = new AbortController()
    const pending = scene.play('flat', 'ball', { stagger: 100, signal: caller.signal })
    caller.abort()
    timers.advance(10_000)
    const report = await wrap(pending)
    expect(report.completed).toBe(false)
    expect(starts).toEqual(['first'])
    expect(scene.play.data()).toBe(report)
    expect(scene.play.error()).toBeUndefined()
    scene.dispose()
  }),
)

it(
  'native scene play abort preserves a later raw stage-owned run',
  isolated(async () => {
    const { stage, timers } = await wrap(grid())
    const scene = reatomScene({ name: 'play.raw-successor', create: async () => stage })
    await wrap(scene.ready())
    const first = Promise.allSettled([scene.play('flat', 'ball', { stagger: 100 })])
    const successor = stage.play('ball', 'flat', { duration: 500 })
    scene.play.abort()
    timers.advance(10_000)
    expect((await wrap(successor)).completed).toBe(true)
    expect((await wrap(first))[0].status).toBe('rejected')
    scene.dispose()
  }),
)

it(
  'an already aborted caller signal prevents every Direct view start',
  isolated(async () => {
    const { stage, timers, starts } = await wrap(grid())
    const scene = reatomScene({ name: 'play.pre-aborted', create: async () => stage })
    await wrap(scene.ready())
    const caller = new AbortController()
    caller.abort()
    const pending = scene.play('flat', 'ball', { stagger: 100, signal: caller.signal })
    timers.advance(10_000)
    expect((await wrap(pending)).completed).toBe(false)
    expect(starts).toEqual([])
    scene.dispose()
  }),
)
