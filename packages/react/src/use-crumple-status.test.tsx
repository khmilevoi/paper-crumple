/**
 * @vitest-environment jsdom
 */
import { SheetError } from '@paper-crumple/core'
import { afterEach, expect, test, vi } from 'vitest'
import { createFakeStage } from './testing/fake-stage.js'
import { readyScene, renderCrumple } from './testing/crumple-probe.js'
import { flush } from './testing/render.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

function stubReducedMotion(matches: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({ matches, media: query }) as unknown as MediaQueryList),
  )
}

test('status walks detached to acquiring to shown across a mount (§2.5)', async () => {
  const detached = await renderCrumple({ spriteKey: 'a', src: 'a.png' }, { scene: null })
  expect(detached.current.status).toBe('detached')
  await detached.unmount()

  const fake = createFakeStage({ add: () => new Promise(() => undefined) })
  const held = await renderCrumple(
    { spriteKey: 'a', src: 'a.png' },
    { scene: readyScene(fake.stage) },
  )
  expect(held.current.status).toBe('acquiring')
  await held.unmount()

  const settled = await renderCrumple(
    { spriteKey: 'a', src: 'a.png' },
    { scene: readyScene(createFakeStage().stage) },
  )
  expect(settled.current.status).toBe('shown')
  await settled.unmount()
})

test('an animated swap reads swapping until it settles (§2.5)', async () => {
  stubReducedMotion(false)
  const fake = createFakeStage({ sprites: ['a'] })
  const probe = await renderCrumple(
    { spriteKey: 'a', src: 'a.png' },
    { scene: readyScene(fake.stage) },
  )
  await probe.rerender({ options: { spriteKey: 'b', src: 'b.png' } })
  expect(probe.current.status).toBe('swapping')
  fake.views[0]?.settleRun(undefined)
  await flush()
  expect(probe.current.status).toBe('shown')
  await probe.unmount()
})

test('a failed swap reads rolled-back, which is the sampleId branch USAGE §6 hand-derives (§2.5)', async () => {
  stubReducedMotion(false)
  const fake = createFakeStage({ sprites: ['a'] })
  const probe = await renderCrumple(
    { spriteKey: 'a', src: 'a.png' },
    { scene: readyScene(fake.stage) },
  )
  await probe.rerender({ options: { spriteKey: 'b', src: 'b.png' } })
  fake.views[0]?.settleRun(new SheetError('the target never arrived'))
  await flush()
  expect(probe.current.status).toBe('rolled-back')
  const sampleId =
    probe.current.status === 'rolled-back' ? probe.current.shown : probe.current.requested
  expect(sampleId).toBe('a')
  await probe.unmount()
})
