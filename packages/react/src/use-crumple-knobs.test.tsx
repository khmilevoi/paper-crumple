/**
 * @vitest-environment jsdom
 */
import { SheetError } from '@paper-crumple/core'
import type { Sprite, ViewFrame } from '@paper-crumple/core'
import { expect, test, vi } from 'vitest'
import type { Scene } from './scene-types.js'
import { createFakeStage } from './testing/fake-stage.js'
import { readyScene, renderCrumple } from './testing/crumple-probe.js'
import { deferred } from './testing/deferred.js'
import { flush } from './testing/render.js'

const FRAME: ViewFrame = { box: { w: 240, h: 240 }, artwork: { x: 20, y: 20, w: 200, h: 200 } }
const MOVED: ViewFrame = { box: { w: 260, h: 260 }, artwork: { x: 30, y: 30, w: 200, h: 200 } }

test('frame and frameStyle are reported from the view, scaled by frameTo (§5.1, §6)', async () => {
  const fake = createFakeStage()
  const probe = await renderCrumple(
    { spriteKey: 'hero', src: 'hero.png', frameTo: 192 },
    { scene: readyScene(fake.stage) },
  )
  fake.views[0]?.setFrame(FRAME)
  await probe.run(() => probe.current.refresh())
  expect(probe.current.frame).toBe(FRAME)
  expect(probe.current.frameStyle).toEqual({
    width: '230.4px',
    height: '230.4px',
    left: '-19.2px',
    top: '-19.2px',
  })
  await probe.unmount()
})

test('with no frameTo the hook reports frame and applies nothing (§5.1)', async () => {
  const fake = createFakeStage()
  const probe = await renderCrumple(
    { spriteKey: 'hero', src: 'hero.png' },
    { scene: readyScene(fake.stage) },
  )
  fake.views[0]?.setFrame(FRAME)
  await probe.run(() => probe.current.refresh())
  expect(probe.current.frame).toBe(FRAME)
  expect(probe.current.frameStyle).toBeNull()
  await probe.unmount()
})

test('a changed frameTo re-derives frameStyle without touching the view', async () => {
  const fake = createFakeStage()
  const probe = await renderCrumple(
    { spriteKey: 'hero', src: 'hero.png', frameTo: 192 },
    { scene: readyScene(fake.stage) },
  )
  fake.views[0]?.setFrame(FRAME)
  await probe.run(() => probe.current.refresh())
  const calls = fake.calls.length
  await probe.rerender({ options: { spriteKey: 'hero', src: 'hero.png', frameTo: 100 } })
  expect(probe.current.frameStyle?.width).toBe('120px')
  expect(fake.calls).toHaveLength(calls)
  await probe.unmount()
})

test('a knobEpoch bump joins prepare for this sprite, then refreshes and re-frames (§4.3)', async () => {
  const fake = createFakeStage()
  const scene = readyScene(fake.stage)
  const probe = await renderCrumple({ spriteKey: 'hero', src: 'hero.png', frameTo: 192 }, { scene })
  fake.views[0]?.setFrame(FRAME)
  const before = fake.calls.filter((c) => c.method === 'prepare').length
  await probe.rerender({ scene: readyScene(fake.stage, { knobEpoch: 1 }) })
  await flush()
  const prepares = fake.calls.filter((c) => c.method === 'prepare')
  expect(prepares).toHaveLength(before + 1)
  expect(prepares.at(-1)?.args[0]).toBe('hero')
  // The re-frame happens after the join has landed, not before it.
  expect(fake.calls.map((c) => c.method)).toContain('view.refresh')
  await probe.unmount()
})

test('the re-frame reads the frame the sprite moved TO, not the one it is leaving (§4.3)', async () => {
  const gate = deferred<Sprite>()
  const fake = createFakeStage({ prepare: () => gate.promise })
  const probe = await renderCrumple(
    { spriteKey: 'hero', src: 'hero.png', frameTo: 192 },
    { scene: readyScene(fake.stage) },
  )
  fake.views[0]?.setFrame(FRAME)
  await probe.rerender({ scene: readyScene(fake.stage, { knobEpoch: 1 }) })
  // The knob join is gated on `prepare`, and `setFrame` alone bumps nothing — force a re-read so
  // the cached snapshot picks up the frame the view already carries before asserting it stands.
  await probe.run(() => probe.current.refresh())
  // While the re-source is in flight the old frame still stands.
  expect(probe.current.frame).toBe(FRAME)
  fake.views[0]?.setFrame(MOVED)
  gate.resolve({ key: 'hero' } as Sprite)
  await flush()
  expect(probe.current.frame).toBe(MOVED)
  expect(probe.current.frameStyle?.left).toBe('-28.8px')
  await probe.unmount()
})

test('a crumple with no sprite yet skips the join entirely (§4.3)', async () => {
  const gate = deferred<Sprite>()
  const fake = createFakeStage({ add: () => gate.promise })
  const probe = await renderCrumple(
    { spriteKey: 'hero', src: 'hero.png' },
    { scene: readyScene(fake.stage) },
  )
  const before = fake.calls.filter((c) => c.method === 'prepare').length
  await probe.rerender({ scene: readyScene(fake.stage, { knobEpoch: 1 }) })
  await flush()
  // `prepare` on a key that is merely reserved returns a SheetError for a perfectly ordinary
  // sequence — moving a knob while a tile is still mounting. Nothing is lost by skipping: that
  // acquisition is already building at the live knob values.
  expect(fake.calls.filter((c) => c.method === 'prepare')).toHaveLength(before)
  expect(probe.current.error).toBeNull()
  gate.resolve({ key: 'hero' } as Sprite)
  await flush()
  await probe.unmount()
})

test('a detached crumple joins nothing', async () => {
  const fake = createFakeStage()
  const probe = await renderCrumple({ spriteKey: 'hero', src: 'hero.png' }, { scene: null })
  await probe.rerender({ scene: null })
  expect(fake.calls.filter((c) => c.method === 'prepare')).toHaveLength(0)
  await probe.unmount()
})

test('a join that settles after a detach with no epoch move reports nothing (§4.3)', async () => {
  const gate = deferred<Sprite | InstanceType<typeof SheetError>>()
  const fake = createFakeStage({ prepare: () => gate.promise })
  const onError = vi.fn()
  const probe = await renderCrumple(
    { spriteKey: 'hero', src: 'hero.png', onError },
    { scene: readyScene(fake.stage) },
  )
  // Bump the epoch once so the join actually calls `prepare` on the now-resident sprite, and gate
  // it open so the continuation is still pending when the detach below happens.
  await probe.rerender({ scene: readyScene(fake.stage, { knobEpoch: 1 }) })
  // The scene leaves 'ready' — the view is disposed by the OTHER effect, the one keyed on `stage`
  // — while `knobEpoch` stays exactly 1, so the knobEpoch effect's cleanup never runs.
  const detached: Scene = {
    status: 'building',
    stage: null,
    error: null,
    warnings: [],
    lost: false,
    generation: 1,
    knobEpoch: 1,
    play: async () => ({ started: [], skipped: [], failed: [], completed: false }),
    stop: () => {},
  }
  await probe.rerender({ scene: detached })
  expect(probe.current.state).toBe('detached')
  gate.resolve(new SheetError('no record for sprite hero'))
  await flush()
  expect(probe.current.error).toBeNull()
  expect(onError).not.toHaveBeenCalled()
  await probe.unmount()
})

test('a failed join is reported and does not refresh (§7)', async () => {
  const boom = new SheetError('no record for sprite hero')
  const fake = createFakeStage({ prepare: async () => boom })
  const probe = await renderCrumple(
    { spriteKey: 'hero', src: 'hero.png' },
    { scene: readyScene(fake.stage) },
  )
  const refreshes = fake.calls.filter((c) => c.method === 'view.refresh').length
  await probe.rerender({ scene: readyScene(fake.stage, { knobEpoch: 1 }) })
  await flush()
  expect(probe.current.error).toBe(boom)
  expect(fake.calls.filter((c) => c.method === 'view.refresh')).toHaveLength(refreshes)
  await probe.unmount()
})
