/**
 * @vitest-environment jsdom
 */
import { expect, test } from 'vitest'
import { SheetError } from '@paper-crumple/core'
import { createFakeStage } from './testing/fake-stage.js'
import { readyScene, renderCrumple } from './testing/crumple-probe.js'
import { flush } from './testing/render.js'

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

test('retry re-requests a rolled-back key the synced check would refuse forever (§2.6)', async () => {
  const fake = createFakeStage({ sprites: ['a'] })
  const probe = await renderCrumple(
    { spriteKey: 'a', src: 'a.png' },
    { scene: readyScene(fake.stage) },
  )
  await probe.rerender({ options: { spriteKey: 'b', src: 'b.png' } })
  fake.views[0]?.settleRun(new SheetError('the target never arrived'))
  await flush()
  const swaps = fake.calls.filter((c) => c.method === 'view.swapTo').length
  // `synced` is written BEFORE the swap and is never reset on failure, so without `retry` the
  // only escape is key-away-and-back, which plays a full fold to a sprite already shown.
  await probe.run(() => {
    probe.current.retry()
  })
  expect(fake.calls.filter((c) => c.method === 'view.swapTo')).toHaveLength(swaps + 1)
  expect(probe.current.requested).toBe('b')
  await probe.unmount()
})

test('retry opens a fresh request, so pending reopens (§2.1, §2.6)', async () => {
  const fake = createFakeStage({ sprites: ['a'] })
  const probe = await renderCrumple(
    { spriteKey: 'a', src: 'a.png' },
    { scene: readyScene(fake.stage) },
  )
  await probe.rerender({ options: { spriteKey: 'b', src: 'b.png' } })
  fake.views[0]?.settleRun(new SheetError('the target never arrived'))
  await flush()
  expect(probe.current.pending).toBeNull()
  await probe.run(() => {
    probe.current.retry()
  })
  expect(probe.current.pending).toMatchObject({ key: 'b' })
  await probe.unmount()
})

test('retry is a no-op while detached, and is identity-stable (§2.6)', async () => {
  const probe = await renderCrumple({ spriteKey: 'a', src: 'a.png' }, { scene: null })
  const { retry } = probe.current
  await probe.run(() => {
    probe.current.retry()
  })
  expect(probe.current.requested).toBeNull()
  await probe.rerender({ options: { spriteKey: 'a', src: 'a.png' } })
  expect(probe.current.retry).toBe(retry)
  await probe.unmount()
})
