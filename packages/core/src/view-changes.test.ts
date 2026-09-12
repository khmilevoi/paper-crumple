import { expect, it } from 'vitest'
import { isAborted } from './abort.js'
import { makeReactiveStage, makeReactiveCanvas } from './testing/reactive-stage.js'
import { createStage } from './stage.js'
import { fakeSheet, fakeMotion, stageEnv } from './testing/fake-slots.js'
import { createFakeTimers } from './testing/fake-timers.js'

it('controller replacement cannot publish terminal view state when the next play is refused', async () => {
  const stage = await makeReactiveStage()
  const view = stage.view({ canvas: makeReactiveCanvas() })
  if (view instanceof Error) return expect.fail('view refused')
  await view.play(0, 0).done // Install the one-pose empty-view controller.
  const sprite = await stage.add('/a.png', { key: 'a' })
  if (sprite instanceof Error || isAborted(sprite)) return expect.fail('add refused')
  view.show(sprite)
  let cached = view.state
  const seen: string[] = []
  view.changes.subscribe('state', () => {
    cached = view.state
    seen.push(view.state)
  })
  const before = view.changes.revision('state')
  expect(await view.play(99, 0).done).toBeInstanceOf(Error)
  expect(cached).toBe('idle')
  expect(seen).not.toContain('disposed')
  expect(view.changes.revision('state')).toBe(before)
  expect(stage.views).toContain(view)
  stage.dispose()
})

it.each(['timer', 'run.stop', 'abort'] as const)(
  '%s settlement delivers legacy end before an idle observer disposes the view',
  async (operation) => {
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
    const gate = new AbortController()
    const run = view.play(0, 5, { duration: 100, signal: gate.signal })
    const events: string[] = []
    view.on('end', () => events.push('end'))
    view.changes.subscribe('state', () => {
      if (view.state === 'idle') {
        events.push('idle')
        view.dispose()
      }
    })
    if (operation === 'timer') timers.advance(1000)
    else if (operation === 'run.stop') run.stop()
    else gate.abort()
    await run.done
    expect(events).toEqual(['end', 'idle'])
    expect(timers.pending).toBe(0)
    stage.dispose()
  },
)

it.each(['stop', 'dispose'] as const)(
  'a ball observer can %s without a timer being installed afterward',
  async (operation) => {
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
    let parked = false
    view.changes.subscribe('state', () => {
      if (view.state === 'crumpling.ball') {
        parked = true
        view[operation]()
      }
    })
    const run = view.crumpleTo(new Promise(() => {}), { duration: 100 })
    for (let elapsed = 0; !parked && elapsed < 1000; elapsed += 1) timers.advance(1)
    expect(parked).toBe(true)
    expect(timers.pending).toBe(0)
    expect(isAborted(await run.done)).toBe(true)
    stage.dispose()
  },
)

it.each(['draw', 'refresh', 'step'] as const)(
  'dirty %s completes pixels and legacy delivery before resource callbacks',
  async (operation) => {
    const timers = createFakeTimers()
    const motion = fakeMotion()
    const stage = await createStage(
      { sheet: fakeSheet(), motion, maxSize: 384 },
      stageEnv({ timers }),
    )
    if (stage instanceof Error || isAborted(stage)) return expect.fail('stage refused')
    const sprite = await stage.add('/a.png', { key: 'a' })
    const view = stage.view({ canvas: makeReactiveCanvas() })
    if (sprite instanceof Error || isAborted(sprite) || view instanceof Error)
      return expect.fail('setup refused')
    view.show(sprite)
    view.play(0, 5, { duration: 500 })
    const drawn = motion.calls.draw.length
    let steps = 0
    view.on('step', () => {
      steps += 1
    })
    sprite.set({ sheetEdge: 0.8 } as never)
    const seen: unknown[] = []
    const off = sprite.changes.subscribe('resources', () => {
      off()
      seen.push([motion.calls.draw.length > drawn, steps])
      view.dispose()
    })
    expect(() => {
      if (operation === 'draw') view.draw(2)
      else if (operation === 'refresh') view.refresh()
      else timers.advance(200)
    }).not.toThrow()
    expect(seen).toEqual([[true, operation === 'step' ? 1 : 0]])
    expect(view.state).toBe('disposed')
    stage.dispose()
  },
)

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
