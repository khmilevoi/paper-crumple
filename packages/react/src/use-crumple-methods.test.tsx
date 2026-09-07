/**
 * @vitest-environment jsdom
 */
import { expect, test } from 'vitest'
import { createFakeStage } from './testing/fake-stage.js'
import { readyScene, renderCrumple } from './testing/crumple-probe.js'

test('draw(pose) draws once and publishes it, with no redraw of its own (§2.2)', async () => {
  const fake = createFakeStage({ sprites: ['a'] })
  const probe = await renderCrumple(
    { spriteKey: 'a', src: 'a.png' },
    { scene: readyScene(fake.stage) },
  )
  const before = fake.calls.length
  await probe.run(() => {
    probe.current.draw(3)
  })
  // Exactly one call, and it is the draw: `refresh()` forces a SECOND blit, which is the "one draw
  // more than this needs" the playground was paying (§2.2).
  expect(fake.calls.slice(before).map((c) => c.method)).toEqual(['view.draw'])
  expect(fake.calls.at(-1)?.args[0]).toBe(3)
  expect(probe.current.pose).toBe(3)
  await probe.unmount()
})

test('draw is a no-op while detached, so no consumer needs a view === null guard (§2.2)', async () => {
  const probe = await renderCrumple({ spriteKey: 'a', src: 'a.png' }, { scene: null })
  expect(probe.current.view).toBeNull()
  await probe.run(() => {
    probe.current.draw('ball')
  })
  expect(probe.current.pose).toBe(0)
  await probe.unmount()
})

test('sync() bumps and calls nothing on the view — the generic re-read escape (§2.2)', async () => {
  const fake = createFakeStage({ sprites: ['a'] })
  const probe = await renderCrumple(
    { spriteKey: 'a', src: 'a.png' },
    { scene: readyScene(fake.stage) },
  )
  const view = fake.views[0]
  expect(view).toBeDefined()
  if (view === undefined) return
  const before = fake.calls.length
  // A raw-view call the binding has no method for: the consumer makes it, then re-reads.
  view.setState('playing')
  await probe.run(() => {
    probe.current.sync()
  })
  expect(fake.calls).toHaveLength(before)
  expect(probe.current.state).toBe('playing')
  await probe.unmount()
})

test('draw and sync are identity-stable across renders (§2.1)', async () => {
  const fake = createFakeStage({ sprites: ['a'] })
  const probe = await renderCrumple(
    { spriteKey: 'a', src: 'a.png' },
    { scene: readyScene(fake.stage) },
  )
  const { draw, sync } = probe.current
  await probe.rerender({ options: { spriteKey: 'a', src: 'a.png' } })
  expect(probe.current.draw).toBe(draw)
  expect(probe.current.sync).toBe(sync)
  await probe.unmount()
})
