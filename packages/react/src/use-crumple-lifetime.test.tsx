/**
 * @vitest-environment jsdom
 */
import type { ReactNode } from 'react'
import { createElement } from 'react'
import { expect, test } from 'vitest'
import { SheetError, type Sprite } from '@paper-crumple/core'
import { PaperScene } from './scene-context.js'
import { useCrumple } from './use-crumple.js'
import { createFakeStage } from './testing/fake-stage.js'
import { readyScene, renderCrumple } from './testing/crumple-probe.js'
import { flush, render } from './testing/render.js'

test('no view exists until the scene is ready and a canvas is attached (§5.2)', async () => {
  const fake = createFakeStage()
  const probe = await renderCrumple({ spriteKey: 'hero', src: 'hero.png' }, { scene: null })
  expect(probe.current.state).toBe('detached')
  expect(probe.current.view).toBeNull()
  expect(fake.calls.filter((c) => c.method === 'view')).toHaveLength(0)
  await probe.unmount()
})

test('the pair completing creates exactly one view', async () => {
  const fake = createFakeStage()
  const probe = await renderCrumple(
    { spriteKey: 'hero', src: 'hero.png' },
    { scene: readyScene(fake.stage) },
  )
  expect(fake.calls.filter((c) => c.method === 'view')).toHaveLength(1)
  expect(probe.current.view).not.toBeNull()
  expect(probe.current.state).toBe('idle')
  await probe.unmount()
})

test('the view is created with size managed, and with fit and tag from the options', async () => {
  const fake = createFakeStage()
  const probe = await renderCrumple(
    { spriteKey: 'hero', src: 'hero.png', fit: 'contain', tag: 'hero-tile' },
    { scene: readyScene(fake.stage) },
  )
  const target = fake.views[0]?.target
  expect(target?.size).toBe('managed')
  expect(target?.fit).toBe('contain')
  expect(target?.tag).toBe('hero-tile')
  await probe.unmount()
})

test('unmount disposes the view, and the instance reads detached again', async () => {
  const fake = createFakeStage()
  const probe = await renderCrumple(
    { spriteKey: 'hero', src: 'hero.png' },
    { scene: readyScene(fake.stage) },
  )
  await probe.unmount()
  expect(fake.views[0]?.disposed).toBe(true)
})

test('raw View disposal publishes detached without waiting for a hook method', async () => {
  const fake = createFakeStage()
  const probe = await renderCrumple(
    { spriteKey: 'hero', src: 'hero.png' },
    { scene: readyScene(fake.stage) },
  )
  await probe.run(() => probe.current.view?.dispose())
  expect(probe.current.view).toBeNull()
  expect(probe.current.status).toBe('detached')
  await probe.unmount()
})

test('requested and error survive detachment and clear when a replacement stage succeeds', async () => {
  const failure = new SheetError('the first scene could not acquire the source')
  const first = createFakeStage({ add: async () => failure })
  let finish!: (sprite: Sprite) => void
  const pending = new Promise<Sprite>((resolve) => {
    finish = resolve
  })
  const second = createFakeStage({ add: () => pending })
  const probe = await renderCrumple(
    { spriteKey: 'hero', src: 'hero.png' },
    { scene: readyScene(first.stage) },
  )
  await probe.rerender({ scene: null })
  expect(probe.current.requested).toBe('hero')
  expect(probe.current.error).toBe(failure)
  await probe.rerender({ scene: readyScene(second.stage, { generation: 2 }) })
  expect(probe.current.error).toBe(failure)
  await probe.run(() => finish(second.addSprite('hero')))
  expect(probe.current.shown).toBe('hero')
  expect(probe.current.error).toBeNull()
  await probe.unmount()
})

test('raw stage loss clears the View even for an externally supplied Scene snapshot', async () => {
  const fake = createFakeStage()
  const probe = await renderCrumple(
    { spriteKey: 'hero', src: 'hero.png' },
    { scene: readyScene(fake.stage) },
  )
  await probe.run(() => fake.lose())
  expect(probe.current.view).toBeNull()
  expect(probe.current.status).toBe('detached')
  await probe.unmount()
})

test('StrictMode leaves exactly one view and raises no claimed-canvas ViewError (§9)', async () => {
  const fake = createFakeStage()
  const probe = await renderCrumple(
    { spriteKey: 'hero', src: 'hero.png' },
    { scene: readyScene(fake.stage), strict: true },
  )
  expect(fake.views.filter((v) => !v.disposed)).toHaveLength(1)
  expect(probe.current.error).toBeNull()
  await probe.unmount()
  expect(fake.views.filter((v) => !v.disposed)).toHaveLength(0)
})

test('a scene leaving ready disposes the view; a new stage builds a new one (§5.2)', async () => {
  const first = createFakeStage()
  const second = createFakeStage()
  const probe = await renderCrumple(
    { spriteKey: 'hero', src: 'hero.png' },
    { scene: readyScene(first.stage) },
  )
  await probe.rerender({ scene: readyScene(second.stage, { generation: 2 }) })
  expect(first.views[0]?.disposed).toBe(true)
  expect(second.calls.filter((c) => c.method === 'view')).toHaveLength(1)
  await probe.unmount()
})

test('a scene that leaves ready detaches the crumple, so the placeholder comes back (§5.5)', async () => {
  const fake = createFakeStage()
  const probe = await renderCrumple(
    { spriteKey: 'hero', src: 'hero.png' },
    { scene: readyScene(fake.stage) },
  )
  // What a lost context does one level up: the scene fails, and a failed scene has no stage.
  await probe.rerender({ scene: null })
  expect(fake.views[0]?.disposed).toBe(true)
  expect(probe.current.state).toBe('detached')
  expect(probe.current.shown).toBeNull()
  await probe.unmount()
})

test('cleanup order: a stage disposed under a live crumple leaves unmount a no-op (§4.6, §9)', async () => {
  const fake = createFakeStage()
  const probe = await renderCrumple(
    { spriteKey: 'hero', src: 'hero.png' },
    { scene: readyScene(fake.stage) },
  )
  // React runs cleanups child-first and a concurrent route change can invert that order, so a
  // Crumple may outlive or predecease its PaperScene in either direction. `dispose()` is
  // idempotent, which is what makes both directions pass.
  fake.stage.dispose()
  await probe.unmount()
  expect(fake.views[0]?.disposed).toBe(true)
})

test('cleanup order: a crumple unmounted before its stage disposes leaves the later disposal a no-op (§4.6, §9)', async () => {
  const fake = createFakeStage()
  const probe = await renderCrumple(
    { spriteKey: 'hero', src: 'hero.png' },
    { scene: readyScene(fake.stage) },
  )
  // The other direction from the test above (§9's "in both orders"): here the Crumple unmounts
  // — and disposes its own view — while the stage is still alive, and the stage disposal (what a
  // PaperScene unmounting later would trigger) happens only afterward. `dispose()`'s idempotence
  // is what keeps the later call a no-op rather than a double-dispose error.
  await probe.unmount()
  expect(fake.views[0]?.disposed).toBe(true)
  expect(fake.calls.filter((c) => c.method === 'view.dispose')).toHaveLength(1)
  fake.stage.dispose()
  expect(fake.views[0]?.disposed).toBe(true)
  expect(fake.calls.filter((c) => c.method === 'view.dispose')).toHaveLength(1)
  expect(probe.current.error).toBeNull()
})

test('a ViewError from stage.view is reported, never thrown (§7)', async () => {
  const fake = createFakeStage()
  // A scene literal still saying `ready` over a stage that is gone: `view()` refuses, and the
  // binding must report the Error rather than throw it or ignore it.
  const scene = readyScene(fake.stage)
  fake.stage.dispose()
  const probe = await renderCrumple({ spriteKey: 'hero', src: 'hero.png' }, { scene })
  expect(probe.current.error).toBeInstanceOf(Error)
  expect(probe.current.view).toBeNull()
  await probe.unmount()
})

test('ref, play, stop and refresh keep their identity across a render that changes every option', async () => {
  const fake = createFakeStage()
  const probe = await renderCrumple(
    { spriteKey: 'hero', src: 'hero.png', duration: 400, frameTo: 192, tag: 'a' },
    { scene: readyScene(fake.stage) },
  )
  const before = probe.current
  await probe.rerender({
    options: { spriteKey: 'hero', src: 'hero.png', duration: 900, frameTo: 240, tag: 'b' },
  })
  const after = probe.current
  expect(after.ref).toBe(before.ref)
  expect(after.play).toBe(before.play)
  expect(after.stop).toBe(before.stop)
  expect(after.refresh).toBe(before.refresh)
  // A re-render alone creates no view and disposes none — the whole-view-churn failure.
  expect(fake.calls.filter((c) => c.method === 'view')).toHaveLength(1)
  expect(fake.calls.filter((c) => c.method === 'view.dispose')).toHaveLength(0)
  await probe.unmount()
})

test('play, stop and refresh reach the view, and play hands back the raw Run', async () => {
  const fake = createFakeStage()
  const probe = await renderCrumple(
    { spriteKey: 'hero', src: 'hero.png', duration: 400 },
    { scene: readyScene(fake.stage) },
  )
  let run: unknown = null
  await probe.run(() => {
    run = probe.current.play('flat', 'ball')
  })
  expect(run).not.toBeNull()
  expect(fake.calls.find((c) => c.method === 'view.play')?.args[2]).toEqual({ duration: 400 })
  await probe.run(() => probe.current.stop())
  await probe.run(() => probe.current.refresh())
  expect(fake.calls.map((c) => c.method)).toContain('view.stop')
  expect(fake.calls.map((c) => c.method)).toContain('view.refresh')
  await probe.unmount()
})

test('play returns null while detached, rather than throwing (§5.1)', async () => {
  const probe = await renderCrumple({ spriteKey: 'hero', src: 'hero.png' }, { scene: null })
  expect(probe.current.play('flat', 'ball')).toBeNull()
  await probe.run(() => probe.current.stop())
  await probe.run(() => probe.current.refresh())
  await probe.unmount()
})

test('with no scene option the hook reads the provider (§4.2)', async () => {
  const fake = createFakeStage()
  const scene = readyScene(fake.stage)
  function Tile(): ReactNode {
    const crumple = useCrumple({ spriteKey: 'hero', src: 'hero.png' })
    return createElement('canvas', { ref: crumple.ref })
  }
  const harness = await render(createElement(PaperScene, { value: scene }, createElement(Tile)))
  await flush()
  expect(fake.calls.filter((c) => c.method === 'view')).toHaveLength(1)
  await harness.unmount()
})

test('outside a provider the hook is permanently detached and does not throw (§4.2, §7)', async () => {
  const probe = await renderCrumple({ spriteKey: 'hero', src: 'hero.png' }, { scene: 'context' })
  expect(probe.current.state).toBe('detached')
  await probe.unmount()
})
