/**
 * @vitest-environment jsdom
 */
import { GlError } from '@paper-crumple/core'
import type { Events } from '@paper-crumple/core'
import { expect, test, vi } from 'vitest'
import { createFakeStage } from './testing/fake-stage.js'
import { readyScene, renderCrumple } from './testing/crumple-probe.js'
import { flush } from './testing/render.js'

test('a swap start, a step at the via and an end move parked through its whole life (§5.5)', async () => {
  const fake = createFakeStage()
  const probe = await renderCrumple(
    { spriteKey: 'hero', src: 'hero.png' },
    { scene: readyScene(fake.stage) },
  )
  const view = fake.views[0]
  view?.emit('start', { from: 0, to: 0, via: 5 })
  await flush()
  expect(probe.current.parked).toBe(false)
  view?.emit('step', { pose: 5, frame: 5, ms: 300 })
  await flush()
  expect(probe.current.parked).toBe(true)
  view?.emit('end', { from: 0, to: 0, completed: true })
  await flush()
  expect(probe.current.parked).toBe(false)
  await probe.unmount()
})

test('the first step past the ball clears parked (§0.2)', async () => {
  const fake = createFakeStage()
  const probe = await renderCrumple(
    { spriteKey: 'hero', src: 'hero.png' },
    { scene: readyScene(fake.stage) },
  )
  const view = fake.views[0]
  view?.emit('start', { from: 0, to: 0, via: 5 })
  await flush()
  view?.emit('step', { pose: 5, frame: 5, ms: 300 })
  await flush()
  expect(probe.current.parked).toBe(true)
  // The descent's first step. `end` is not what clears the park — the next step is (§5.5).
  view?.emit('step', { pose: 6, frame: 6, ms: 60 })
  await flush()
  expect(probe.current.parked).toBe(false)
  await probe.unmount()
})

test('the pose the store reports follows the steps', async () => {
  const fake = createFakeStage()
  const probe = await renderCrumple(
    { spriteKey: 'hero', src: 'hero.png' },
    { scene: readyScene(fake.stage) },
  )
  fake.views[0]?.setState('playing')
  fake.views[0]?.emit('step', { pose: 2, frame: 2, ms: 60 })
  await flush()
  expect(probe.current.state).toBe('playing')
  await probe.unmount()
})

test('a stage error naming this view lands on error and reaches onError (§5.5, §7)', async () => {
  const fake = createFakeStage()
  const onError = vi.fn()
  const probe = await renderCrumple(
    { spriteKey: 'hero', src: 'hero.png', onError },
    { scene: readyScene(fake.stage) },
  )
  const view = fake.views[0]?.view ?? null
  const boom = new GlError('the draw failed')
  fake.emit('error', { error: boom, observed: false, view })
  await flush()
  expect(probe.current.error).toBe(boom)
  expect(onError).toHaveBeenCalledTimes(1)
  await probe.unmount()
})

test('a stage error for another view is not this crumple s (§5.5)', async () => {
  const fake = createFakeStage()
  const onError = vi.fn()
  const probe = await renderCrumple(
    { spriteKey: 'hero', src: 'hero.png', onError },
    { scene: readyScene(fake.stage) },
  )
  fake.emit('error', { error: new GlError('someone else'), observed: false, view: null })
  await flush()
  expect(probe.current.error).toBeNull()
  expect(onError).not.toHaveBeenCalled()
  await probe.unmount()
})

test('start clears the error, so a rollback notice goes at the next interaction (§5.1)', async () => {
  const fake = createFakeStage()
  const probe = await renderCrumple(
    { spriteKey: 'hero', src: 'hero.png' },
    { scene: readyScene(fake.stage) },
  )
  fake.emit('error', {
    error: new GlError('x'),
    observed: false,
    view: fake.views[0]?.view ?? null,
  })
  await flush()
  expect(probe.current.error).not.toBeNull()
  fake.views[0]?.emit('start', { from: 0, to: 5 })
  await flush()
  expect(probe.current.error).toBeNull()
  await probe.unmount()
})

test('onStart and onEnd are dispatched from the binding s own subscriptions (§5.5)', async () => {
  const fake = createFakeStage()
  const onStart = vi.fn()
  const onEnd = vi.fn()
  const probe = await renderCrumple(
    { spriteKey: 'hero', src: 'hero.png', onStart, onEnd },
    { scene: readyScene(fake.stage) },
  )
  const start: Events['start'] = { from: 0, to: 5 }
  fake.views[0]?.emit('start', start)
  fake.views[0]?.emit('end', { from: 0, to: 5, completed: true })
  await flush()
  expect(onStart).toHaveBeenCalledWith(start)
  expect(onEnd).toHaveBeenCalledTimes(1)
  await probe.unmount()
})

test('a stale callback is never invoked — the newest onEnd runs for an older run (§9)', async () => {
  const fake = createFakeStage()
  const first = vi.fn()
  const second = vi.fn()
  const probe = await renderCrumple(
    { spriteKey: 'hero', src: 'hero.png', onEnd: first },
    { scene: readyScene(fake.stage) },
  )
  fake.views[0]?.emit('start', { from: 0, to: 5 })
  await probe.rerender({ options: { spriteKey: 'hero', src: 'hero.png', onEnd: second } })
  fake.views[0]?.emit('end', { from: 0, to: 5, completed: true })
  await flush()
  expect(first).not.toHaveBeenCalled()
  expect(second).toHaveBeenCalledTimes(1)
  await probe.unmount()
})

test('the subscriptions go with the view — nothing fires after unmount', async () => {
  const fake = createFakeStage()
  const onEnd = vi.fn()
  const probe = await renderCrumple(
    { spriteKey: 'hero', src: 'hero.png', onEnd },
    { scene: readyScene(fake.stage) },
  )
  const view = fake.views[0]
  await probe.unmount()
  view?.emit('end', { from: 0, to: 5, completed: true })
  expect(onEnd).not.toHaveBeenCalled()
})
