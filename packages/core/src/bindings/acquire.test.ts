import { expect, it, vi } from 'vitest'
import { ABORTED, SheetError } from '../index.js'
import type { Sprite } from '../index.js'
import { asBitmap, fakeBitmap } from '../testing/fake-source.js'
import { makeReactiveStage } from '../testing/reactive-stage.js'
import { createAcquisitions } from './acquire.js'
import { createRequestGate } from './request.js'

it('shares one acquisition per stage and key across independently acquired registries', async () => {
  const stage = await makeReactiveStage()
  const a = createAcquisitions(stage)
  const b = createAcquisitions(stage)
  let land!: (bitmap: ImageBitmap) => void
  const bitmapReady = new Promise<ImageBitmap>((resolve) => {
    land = resolve
  })
  const source = vi.fn(() => bitmapReady)
  const first = a.acquire('hero', source)
  const second = b.acquire('hero', source)
  expect(a.pending('hero')).toBeDefined()
  land(asBitmap(fakeBitmap()))
  expect(await first).toBe(await second)
  expect(source).toHaveBeenCalledTimes(1)
  expect(a.pending('hero')).toBeUndefined()
  expect(a).toBe(b)
  stage.dispose()
})

it('one consumer cancellation cannot cancel shared acquisition or the other consumer', async () => {
  const stage = await makeReactiveStage()
  const a = createAcquisitions(stage)
  const first = createRequestGate(() => true)
  const second = createRequestGate(() => true)
  let land!: (bitmap: ImageBitmap) => void
  const bitmapReady = new Promise<ImageBitmap>((resolve) => {
    land = resolve
  })
  const source = () => bitmapReady
  const p1 = a.acquire('hero', source, undefined, first.signal)
  const p2 = createAcquisitions(stage).acquire('hero', source, undefined, second.signal)
  first.cancel()
  expect(a.signal.aborted).toBe(false)
  land(asBitmap(fakeBitmap()))
  expect(await p1).toBe(ABORTED)
  expect(((await p2) as Sprite).key).toBe('hero')
  expect(first.current()).toBe(false)
  expect(second.current()).toBe(true)
  second.finish()
  stage.dispose()
})

it('raw stage disposal aborts shared work, clears pending entries, and stays terminal', async () => {
  const stage = await makeReactiveStage()
  const a = createAcquisitions(stage)
  let land!: (bitmap: ImageBitmap) => void
  const bitmapReady = new Promise<ImageBitmap>((resolve) => {
    land = resolve
  })
  const started = vi.fn(() => bitmapReady)
  const pending = a.acquire('hero', started)
  await Promise.resolve()
  await Promise.resolve()
  stage.dispose()
  expect(a.signal.aborted).toBe(true)
  expect(a.pending('hero')).toBeUndefined()
  const bitmap = fakeBitmap()
  land(asBitmap(bitmap))
  expect(await pending).toBe(ABORTED)
  expect(bitmap.closes).toBe(1)
  expect(createAcquisitions(stage)).toBe(a)
  expect(await a.acquire('later', 'later.png')).toBe(ABORTED)
})

it('a registry first requested after raw disposal is already aborted', async () => {
  const stage = await makeReactiveStage()
  stage.dispose()
  expect(createAcquisitions(stage).signal.aborted).toBe(true)
})

it('resident evicted sprites are prepared instead of returning a frontless sprite', async () => {
  const stage = await makeReactiveStage()
  const source = vi.fn(async () => asBitmap(fakeBitmap()))
  const sprite = await stage.add(source, { key: 'hero' })
  await stage.add('other.png', { key: 'other' }) // The LRU preserves its most recent front.
  stage.budget({ bytes: 0 })
  expect((sprite as Sprite).resident).toBe(false)
  stage.budget({ bytes: 1_000_000 })
  expect(await createAcquisitions(stage).acquire('hero', source)).toBe(sprite)
  expect((sprite as Sprite).resident).toBe(true)
  stage.dispose()
})

it('the raw reserved-add workaround preserves the original refusal when prepare cannot join', async () => {
  const stage = await makeReactiveStage()
  let land!: (bitmap: ImageBitmap) => void
  const winner = stage.add(
    () =>
      new Promise<ImageBitmap>((resolve) => {
        land = resolve
      }),
    { key: 'hero' },
  )
  const refusal = await createAcquisitions(stage).acquire('hero', 'hero.png')
  expect(refusal).toBeInstanceOf(SheetError)
  expect((refusal as Error).message).toContain("add() was called with the live key 'hero'")
  land(asBitmap(fakeBitmap()))
  await winner
  stage.dispose()
})
