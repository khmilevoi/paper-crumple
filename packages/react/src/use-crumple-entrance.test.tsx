/**
 * @vitest-environment jsdom
 */
import { SheetError } from '@paper-crumple/core'
import type { Sprite } from '@paper-crumple/core'
import { afterEach, expect, test, vi } from 'vitest'
import { createFakeStage } from './testing/fake-stage.js'
import { readyScene, renderCrumple } from './testing/crumple-probe.js'
import { deferred } from './testing/deferred.js'
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

test('the default entrance shows the sprite and lifts the placeholder with no event at all (§5.5)', async () => {
  const fake = createFakeStage()
  const probe = await renderCrumple(
    { spriteKey: 'hero', src: 'hero.png' },
    { scene: readyScene(fake.stage) },
  )
  expect(fake.calls.map((c) => c.method)).toContain('view.show')
  expect(fake.calls.map((c) => c.method)).not.toContain('view.draw')
  expect(probe.current.shown).toBe('hero')
  expect(probe.current.requested).toBe('hero')
  await probe.unmount()
})

test('uncrumple is show, then draw the ball, then play out of it — in that order (§5.4)', async () => {
  stubReducedMotion(false)
  const fake = createFakeStage()
  const probe = await renderCrumple(
    { spriteKey: 'hero', src: 'hero.png', entrance: 'uncrumple', duration: 700 },
    { scene: readyScene(fake.stage) },
  )
  const order = fake.calls
    .map((c) => c.method)
    .filter((m) => m === 'view.show' || m === 'view.draw' || m === 'view.play')
  // `draw` resolves a PoseRef against the SHOWN sprite's clip, so a draw before show resolves
  // against a pose count of 1 and silently draws the flat sheet.
  expect(order).toEqual(['view.show', 'view.draw', 'view.play'])
  const draw = fake.calls.find((c) => c.method === 'view.draw')
  expect(draw?.args[0]).toBe('ball')
  const play = fake.calls.find((c) => c.method === 'view.play')
  expect(play?.args[0]).toBe('ball')
  expect(play?.args[1]).toBe('flat')
  expect((play?.args[2] as { duration?: number }).duration).toBe(700)
  await probe.unmount()
})

test('under reduce, uncrumple is flat: one show, no draw, no run (§5.3)', async () => {
  stubReducedMotion(true)
  const fake = createFakeStage()
  const probe = await renderCrumple(
    { spriteKey: 'hero', src: 'hero.png', entrance: 'uncrumple' },
    { scene: readyScene(fake.stage) },
  )
  expect(fake.calls.map((c) => c.method)).toContain('view.show')
  expect(fake.calls.map((c) => c.method)).not.toContain('view.draw')
  expect(fake.calls.map((c) => c.method)).not.toContain('view.play')
  expect(probe.current.shown).toBe('hero')
  await probe.unmount()
})

test('reducedMotion off ignores the query entirely', async () => {
  stubReducedMotion(true)
  const fake = createFakeStage()
  const probe = await renderCrumple(
    { spriteKey: 'hero', src: 'hero.png', entrance: 'uncrumple', reducedMotion: 'off' },
    { scene: readyScene(fake.stage) },
  )
  expect(fake.calls.map((c) => c.method)).toContain('view.draw')
  await probe.unmount()
})

test('the first sprite goes through acquire — stage.mount is never called (§5.4)', async () => {
  const fake = createFakeStage()
  const probe = await renderCrumple(
    { spriteKey: 'hero', src: 'hero.png' },
    { scene: readyScene(fake.stage) },
  )
  expect(fake.calls.map((c) => c.method)).not.toContain('mount')
  expect(fake.calls.map((c) => c.method)).toContain('add')
  await probe.unmount()
})

test('two Crumples sharing a spriteKey in one commit produce exactly one add (§5.3, §9)', async () => {
  const gate = deferred<Sprite>()
  const fake = createFakeStage({ add: () => gate.promise })
  const scene = readyScene(fake.stage)
  const probe = await renderCrumple({ spriteKey: 'hero', src: 'hero.png' }, { scene })
  const second = await renderCrumple({ spriteKey: 'hero', src: 'hero.png' }, { scene })
  gate.resolve({ key: 'hero' } as Sprite)
  await flush()
  expect(fake.calls.filter((c) => c.method === 'add')).toHaveLength(1)
  expect(probe.current.shown).toBe('hero')
  expect(second.current.shown).toBe('hero')
  await probe.unmount()
  await second.unmount()
})

test('a resident key with an evicted front waits on prepare rather than lifting the placeholder', async () => {
  const gate = deferred<Sprite>()
  const fake = createFakeStage({ sprites: ['hero'], prepare: () => gate.promise })
  const probe = await renderCrumple(
    { spriteKey: 'hero', src: 'hero.png' },
    { scene: readyScene(fake.stage) },
  )
  expect(fake.calls.map((c) => c.method)).toContain('prepare')
  expect(fake.calls.map((c) => c.method)).not.toContain('view.show')
  expect(probe.current.shown).toBeNull()
  gate.resolve({ key: 'hero' } as Sprite)
  await flush()
  expect(probe.current.shown).toBe('hero')
  await probe.unmount()
})

test('a failed acquisition is reported on error and shows nothing (§7)', async () => {
  const boom = new SheetError('the source decoded to nothing')
  const fake = createFakeStage({ add: async () => boom })
  const onError = vi.fn()
  const probe = await renderCrumple(
    { spriteKey: 'hero', src: 'hero.png', onError },
    { scene: readyScene(fake.stage) },
  )
  expect(probe.current.error).toBe(boom)
  expect(probe.current.shown).toBeNull()
  expect(probe.current.requested).toBe('hero')
  expect(onError).toHaveBeenCalledTimes(1)
  await probe.unmount()
})

test('an unmount mid-acquisition shows nothing and reports nothing (§7)', async () => {
  const gate = deferred<Sprite>()
  const fake = createFakeStage({ add: () => gate.promise })
  const probe = await renderCrumple(
    { spriteKey: 'hero', src: 'hero.png' },
    { scene: readyScene(fake.stage) },
  )
  await probe.unmount()
  gate.resolve({ key: 'hero' } as Sprite)
  await flush()
  expect(fake.calls.map((c) => c.method)).not.toContain('view.show')
})

test('a scene rebuild re-acquires and replays the entrance (§5.2)', async () => {
  const first = createFakeStage()
  const second = createFakeStage()
  const probe = await renderCrumple(
    { spriteKey: 'hero', src: 'hero.png' },
    { scene: readyScene(first.stage) },
  )
  await probe.rerender({ scene: readyScene(second.stage, { generation: 2 }) })
  expect(second.calls.filter((c) => c.method === 'add')).toHaveLength(1)
  expect(second.calls.filter((c) => c.method === 'view.show')).toHaveLength(1)
  expect(probe.current.shown).toBe('hero')
  await probe.unmount()
})

// Rescoped by ruling (P3 task 8, 2026-09-06): this test used to reach the refusal by rerendering
// an already-shown view with a new key, which was a second-key-on-a-shown-view rerender — that
// is a swap since Task 8, not a re-entrance, so it no longer reaches `enter()`'s `view.show` at
// all. The refusal it asserts is specifically the ENTRANCE's own `view.show` handling, so it is
// rewritten to exercise that refusal on the first mount, while `view.sprite` is still `null`: the
// acquisition is gated open so the view exists (created by `ensure()`) before its sprite is
// resolved, `view.show` is stubbed to refuse, and only then is the acquisition allowed to settle.
test('a show refusal is reported on error, reaches onError, and starts no run', async () => {
  stubReducedMotion(false)
  const gate = deferred<Sprite>()
  const refused = new SheetError('this view already shows a sprite pinned elsewhere')
  const fake = createFakeStage({ add: () => gate.promise })
  const onError = vi.fn()
  const probe = await renderCrumple(
    { spriteKey: 'hero', src: 'hero.png', onError },
    { scene: readyScene(fake.stage) },
  )
  const view = fake.views[0]?.view
  expect(view).toBeDefined()
  if (view === undefined) return
  expect(view.sprite).toBeNull()
  view.show = () => refused
  gate.resolve({ key: 'hero' } as Sprite)
  await flush()
  expect(probe.current.error).toBe(refused)
  expect(onError).toHaveBeenCalledTimes(1)
  expect(fake.calls.map((c) => c.method)).not.toContain('view.draw')
  expect(fake.calls.map((c) => c.method)).not.toContain('view.play')
  await probe.unmount()
})
