import { expect, it } from 'vitest'
import { isAborted } from './abort.js'
import { makeReactiveStage, makeReactiveCanvas } from './testing/reactive-stage.js'
import { createStage } from './stage.js'
import { fakeSheet, fakeMotion, stageEnv } from './testing/fake-slots.js'
import { createFakeTimers } from './testing/fake-timers.js'

it('run state observes a live handle, parked and recovery transitions without per-step bumps', async () => {
  const timers = createFakeTimers()
  const stage = await createStage(
    { sheet: fakeSheet(), motion: fakeMotion(), maxSize: 384 },
    stageEnv({ timers }),
  )
  if (stage instanceof Error || isAborted(stage)) return expect.fail('stage refused')
  const sprite = await stage.add('/a.png', { key: 'a' })
  const view = stage.view({ canvas: makeReactiveCanvas() })
  if (sprite instanceof Error || isAborted(sprite) || view instanceof Error)
    return expect.fail('setup refused')
  view.show(sprite)
  const seen: unknown[] = []
  view.changes.subscribe('state', () => seen.push([view.state, view.run !== null]))
  let steps = 0
  view.on('step', () => {
    steps += 1
  })
  view.play(0, 5, { duration: 500 })
  expect(seen).toEqual([['playing', true]])
  timers.advance(250)
  expect(steps).toBeGreaterThan(1)
  expect(seen).toHaveLength(1)
  view.stop()
  expect(seen.at(-1)).toEqual(['idle', false])
  let settle: (value: Error) => void = () => {}
  view.crumpleTo(
    new Promise((resolve) => {
      settle = resolve
    }),
    { duration: 100 },
  )
  timers.advance(1000)
  expect(seen.at(-1)).toEqual(['crumpling.ball', true])
  settle(new Error('target failed'))
  await Promise.resolve()
  await Promise.resolve()
  expect(seen.at(-1)).toEqual(['crumpling.recover', true])
  timers.advance(1000)
  expect(seen.at(-1)).toEqual(['idle', false])
  stage.dispose()
})

it('raw view disposal invalidates the same live view after registry and attachment cleanup', async () => {
  const stage = await makeReactiveStage()
  const view = stage.view({ canvas: makeReactiveCanvas() })
  if (view instanceof Error) return expect.fail('view refused')
  const seen: unknown[] = []
  view.changes.subscribe('lifecycle', () => seen.push([view.state, stage.views.includes(view)]))
  view.dispose()
  expect(seen).toEqual([['disposed', false]])
  stage.dispose()
})

it('show ends a raw run and publishes idle with the fully adopted sprite', async () => {
  const stage = await makeReactiveStage()
  const sprite = await stage.add('/a.png', { key: 'a' })
  const view = stage.view({ canvas: makeReactiveCanvas() })
  if (sprite instanceof Error || isAborted(sprite) || view instanceof Error)
    return expect.fail('setup refused')
  view.show(sprite)
  const run = view.play(0, 5)
  const seen: unknown[] = []
  view.changes.subscribe('state', () => seen.push([view.state, view.run, view.sprite, view.pose]))
  view.show(null)
  expect(seen).toEqual([['idle', null, null, 0]])
  expect(isAborted(await run.done)).toBe(true)
  stage.dispose()
})

it('show cannot reattach a view disposed by its outgoing run end listener', async () => {
  const stage = await makeReactiveStage()
  const sprite = await stage.add('/a.png', { key: 'a' })
  const view = stage.view({ canvas: makeReactiveCanvas() })
  if (sprite instanceof Error || isAborted(sprite) || view instanceof Error)
    return expect.fail('setup refused')
  view.show(sprite)
  view.play(0, 5)
  view.on('end', () => view.dispose())
  view.show(sprite)
  expect(view.state).toBe('disposed')
  expect(view.sprite).toBeNull()
  expect(sprite.attachCount).toBe(0)
  stage.dispose()
})

it('show preserves a new run started by its outgoing end listener', async () => {
  const stage = await makeReactiveStage()
  const sprite = await stage.add('/a.png', { key: 'a' })
  const view = stage.view({ canvas: makeReactiveCanvas() })
  if (sprite instanceof Error || isAborted(sprite) || view instanceof Error)
    return expect.fail('setup refused')
  view.show(sprite)
  view.play(0, 5)
  view.once('end', () => view.play(0, 4))
  view.show(null)
  expect(view.state).toBe('playing')
  expect(view.run).not.toBeNull()
  expect(view.sprite).toBe(sprite)
  stage.dispose()
})

it('raw show publishes only after both sprite counts and view content are consistent', async () => {
  const stage = await makeReactiveStage()
  const a = await stage.add('/a.png', { key: 'a' })
  const b = await stage.add('/b.png', { key: 'b' })
  const view = stage.view({ canvas: makeReactiveCanvas() })
  if (
    a instanceof Error ||
    b instanceof Error ||
    isAborted(a) ||
    isAborted(b) ||
    view instanceof Error
  )
    return expect.fail('setup refused')
  view.show(a)
  view.draw(3)
  const seen: unknown[] = []
  const read = () => seen.push([view.sprite, view.pose, a.attachCount, b.attachCount])
  a.changes.subscribe('resources', read)
  b.changes.subscribe('resources', read)
  view.changes.subscribe('content', read)
  view.show(b)
  expect(seen).toHaveLength(3)
  for (const row of seen) expect(row).toEqual([b, 0, 0, 1])
  const geometry = view.changes.revision('geometry')
  view.draw(2)
  view.refresh()
  expect(view.changes.revision('geometry')).toBe(geometry)
  stage.dispose()
})
