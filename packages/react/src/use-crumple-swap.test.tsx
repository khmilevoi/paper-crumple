/**
 * @vitest-environment jsdom
 */
import { ABORTED, SheetError } from '@paper-crumple/core'
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

test('a spriteKey change fires exactly one swapTo, under the caller s key (§5.3)', async () => {
  const fake = createFakeStage()
  const probe = await renderCrumple(
    { spriteKey: 'a', src: 'a.png', duration: 800 },
    { scene: readyScene(fake.stage) },
  )
  await probe.rerender({ options: { spriteKey: 'b', src: 'b.png', duration: 800 } })
  const swaps = fake.calls.filter((c) => c.method === 'view.swapTo')
  expect(swaps).toHaveLength(1)
  expect(swaps[0]?.args[0]).toBe('b.png')
  expect(swaps[0]?.args[1]).toMatchObject({ key: 'b', duration: 800 })
  expect(probe.current.requested).toBe('b')
  await probe.unmount()
})

test('a spriteKey change reaches swapTo in the commit that observed it (§5.3)', async () => {
  const fake = createFakeStage()
  const probe = await renderCrumple(
    { spriteKey: 'a', src: 'a.png' },
    { scene: readyScene(fake.stage) },
  )
  const before = fake.calls.length
  await probe.rerender({ options: { spriteKey: 'b', src: 'b.png' } })
  // The driver is not an `async` function and settles in a `.then`: no `await` may ever sit above
  // the `swapTo` call, because `start` is emitted synchronously inside it and an
  // `AudioContext.resume()` in a start handler only runs inside the gesture because of that. This
  // asserts the call happened in the same commit; the guarantee itself is structural, so read the
  // driver before changing it.
  expect(fake.calls.slice(before).map((c) => c.method)).toContain('view.swapTo')
  await probe.unmount()
})

test('a second change supersedes the first and aborts its signal (§5.3, §9)', async () => {
  const fake = createFakeStage()
  const probe = await renderCrumple(
    { spriteKey: 'a', src: 'a.png' },
    { scene: readyScene(fake.stage) },
  )
  await probe.rerender({ options: { spriteKey: 'b', src: 'b.png' } })
  const firstSignal = (
    fake.calls.find((c) => c.method === 'view.swapTo')?.args[1] as { signal?: AbortSignal }
  ).signal
  await probe.rerender({ options: { spriteKey: 'c', src: 'c.png' } })
  expect(firstSignal?.aborted).toBe(true)
  expect(fake.calls.filter((c) => c.method === 'view.swapTo')).toHaveLength(2)
  await probe.unmount()
})

test('a rollback leaves requested !== shown with a non-null error (§5.1, §9)', async () => {
  const fake = createFakeStage({ sprites: ['a'] })
  const probe = await renderCrumple(
    { spriteKey: 'a', src: 'a.png' },
    { scene: readyScene(fake.stage) },
  )
  expect(probe.current.shown).toBe('a')
  await probe.rerender({ options: { spriteKey: 'b', src: 'b.png' } })
  const failed = new SheetError('the target never arrived')
  fake.views[0]?.settleRun(failed)
  await flush()
  expect(probe.current.requested).toBe('b')
  expect(probe.current.shown).toBe('a')
  expect(probe.current.error).toBe(failed)
  await probe.unmount()
})

test('a rolled-back swap reaches onError as well as crumple.error (ruling 2)', async () => {
  const fake = createFakeStage({ sprites: ['a'] })
  const onError = vi.fn()
  const probe = await renderCrumple(
    { spriteKey: 'a', src: 'a.png', onError },
    { scene: readyScene(fake.stage) },
  )
  await probe.rerender({ options: { spriteKey: 'b', src: 'b.png', onError } })
  const failed = new SheetError('the target never arrived')
  fake.views[0]?.settleRun(failed)
  await flush()
  expect(probe.current.error).toBe(failed)
  expect(onError).toHaveBeenCalledTimes(1)
  expect(onError).toHaveBeenCalledWith(expect.objectContaining({ error: failed, observed: true }))
  await probe.unmount()
})

test('a stopped swap settles ABORTED and is not an error the instance reports (§7)', async () => {
  const fake = createFakeStage({ sprites: ['a'] })
  const probe = await renderCrumple(
    { spriteKey: 'a', src: 'a.png' },
    { scene: readyScene(fake.stage) },
  )
  await probe.rerender({ options: { spriteKey: 'b', src: 'b.png' } })
  fake.views[0]?.settleRun(ABORTED)
  await flush()
  expect(probe.current.error).toBeNull()
  await probe.unmount()
})

test('src changed without spriteKey reports an Error and makes no library call (§5.3, §9)', async () => {
  const fake = createFakeStage()
  const onError = vi.fn()
  const probe = await renderCrumple(
    { spriteKey: 'a', src: 'url1', onError },
    { scene: readyScene(fake.stage) },
  )
  const before = fake.calls.length
  await probe.rerender({ options: { spriteKey: 'a', src: 'url2', onError } })
  expect(fake.calls).toHaveLength(before)
  expect(probe.current.error).toBeInstanceOf(Error)
  expect(probe.current.error?.message).toContain('replace')
  expect(onError).toHaveBeenCalledTimes(1)
  await probe.unmount()
})

test('a, b, then a again with a new src is still caught — the map, not the last pair', async () => {
  const fake = createFakeStage()
  const probe = await renderCrumple(
    { spriteKey: 'a', src: 'url1' },
    { scene: readyScene(fake.stage) },
  )
  await probe.rerender({ options: { spriteKey: 'b', src: 'urlB' } })
  const before = fake.calls.length
  await probe.rerender({ options: { spriteKey: 'a', src: 'url2' } })
  expect(fake.calls).toHaveLength(before)
  expect(probe.current.error).toBeInstanceOf(Error)
  await probe.unmount()
})

test('a resident key swaps with no add of the binding s own (§5.3, §9)', async () => {
  const fake = createFakeStage({ sprites: ['a', 'b'] })
  const probe = await renderCrumple(
    { spriteKey: 'a', src: 'a.png' },
    { scene: readyScene(fake.stage) },
  )
  const before = fake.calls.filter((c) => c.method === 'add').length
  await probe.rerender({ options: { spriteKey: 'b', src: 'b.png' } })
  expect(fake.calls.filter((c) => c.method === 'add')).toHaveLength(before)
  expect(fake.calls.filter((c) => c.method === 'view.swapTo')).toHaveLength(1)
  await probe.unmount()
})

test('a key whose acquisition is in flight is joined with crumpleTo, not swapTo (§5.3)', async () => {
  const gate = deferred<Sprite>()
  const fake = createFakeStage({ sprites: ['a'], add: () => gate.promise })
  const scene = readyScene(fake.stage)
  const first = await renderCrumple({ spriteKey: 'a', src: 'a.png' }, { scene })
  // A second component starts the acquisition of `b` and holds it open.
  const second = await renderCrumple({ spriteKey: 'b', src: 'b.png' }, { scene })
  await first.rerender({ options: { spriteKey: 'b', src: 'b.png' } })
  expect(fake.calls.filter((c) => c.method === 'view.crumpleTo')).toHaveLength(1)
  expect(fake.calls.filter((c) => c.method === 'view.swapTo')).toHaveLength(0)
  expect(fake.calls.filter((c) => c.method === 'add')).toHaveLength(1)
  gate.resolve({ key: 'b' } as Sprite)
  await flush()
  await first.unmount()
  await second.unmount()
})

test('under reduce the swap is show(), and the query is read at the swap not at mount (§5.3, §9)', async () => {
  stubReducedMotion(false)
  const fake = createFakeStage({ sprites: ['a', 'b'] })
  const probe = await renderCrumple(
    { spriteKey: 'a', src: 'a.png' },
    { scene: readyScene(fake.stage) },
  )
  // The user turns the OS setting on after mounting.
  stubReducedMotion(true)
  await probe.rerender({ options: { spriteKey: 'b', src: 'b.png' } })
  await flush()
  expect(fake.calls.filter((c) => c.method === 'view.swapTo')).toHaveLength(0)
  expect(fake.calls.filter((c) => c.method === 'view.show')).toHaveLength(2)
  expect(probe.current.shown).toBe('b')
  await probe.unmount()
})

test('a refused degraded swap reaches crumple.error and onError (ruling 1)', async () => {
  stubReducedMotion(true)
  const refused = new SheetError('this view already shows a sprite pinned elsewhere')
  const fake = createFakeStage({ sprites: ['a', 'b'] })
  const onError = vi.fn()
  const probe = await renderCrumple(
    { spriteKey: 'a', src: 'a.png', onError },
    { scene: readyScene(fake.stage) },
  )
  const view = fake.views[0]?.view
  expect(view).toBeDefined()
  if (view === undefined) return
  const originalShow = view.show.bind(view)
  view.show = (next) => {
    originalShow(next)
    return refused
  }
  await probe.rerender({ options: { spriteKey: 'b', src: 'b.png', onError } })
  await flush()
  expect(probe.current.error).toBe(refused)
  expect(onError).toHaveBeenCalledTimes(1)
  await probe.unmount()
})
