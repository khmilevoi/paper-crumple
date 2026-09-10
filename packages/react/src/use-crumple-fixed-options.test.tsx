/**
 * @vitest-environment jsdom
 */
import { afterEach, expect, test, vi } from 'vitest'
import { createFakeStage } from './testing/fake-stage.js'
import { readyScene, renderCrumple } from './testing/crumple-probe.js'

afterEach(() => {
  vi.restoreAllMocks()
})

test('a changed fit warns once, in development, and changes nothing (§2.8)', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const fake = createFakeStage()
  const probe = await renderCrumple(
    { spriteKey: 'a', src: 'a.png', fit: 'contain' },
    { scene: readyScene(fake.stage) },
  )
  expect(warn).not.toHaveBeenCalled()
  const views = fake.views.length
  await probe.rerender({ options: { spriteKey: 'a', src: 'a.png', fit: 'stretch' } })
  expect(warn).toHaveBeenCalledTimes(1)
  expect(warn.mock.calls[0]?.[0]).toContain('paper-crumple')
  expect(warn.mock.calls[0]?.[0]).toContain('fit')
  // Recreating the view on change would replay the entrance, which is too heavy for a warning.
  expect(fake.views).toHaveLength(views)
  await probe.unmount()
})

test('a changed tag warns, and only once per view however many renders follow (§2.8)', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const fake = createFakeStage()
  const probe = await renderCrumple(
    { spriteKey: 'a', src: 'a.png', tag: 'first' },
    { scene: readyScene(fake.stage) },
  )
  await probe.rerender({ options: { spriteKey: 'a', src: 'a.png', tag: 'second' } })
  await probe.rerender({ options: { spriteKey: 'a', src: 'a.png', tag: 'third' } })
  expect(warn).toHaveBeenCalledTimes(1)
  expect(warn.mock.calls[0]?.[0]).toContain('tag')
  await probe.unmount()
})

test('unchanged fit and tag never warn, however many renders (§2.8)', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const fake = createFakeStage()
  const probe = await renderCrumple(
    { spriteKey: 'a', src: 'a.png', fit: 'contain', tag: 'hero' },
    { scene: readyScene(fake.stage) },
  )
  await probe.rerender({ options: { spriteKey: 'a', src: 'a.png', fit: 'contain', tag: 'hero' } })
  await probe.rerender({ options: { spriteKey: 'b', src: 'b.png', fit: 'contain', tag: 'hero' } })
  expect(warn).not.toHaveBeenCalled()
  await probe.unmount()
})
