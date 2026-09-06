/**
 * # `swapTo`'s caller-supplied key (spec §5.3)
 *
 * Two branches. Here: a key that is NOT resident — `swapTo` mints nothing and runs its `add()`
 * under the key it was handed, so the fold preset (`presetForImageId(key)`) is stable per picture
 * instead of drifting with a monotonic counter. The resident branch is in this file too.
 */
import { describe, expect, it } from 'vitest'
import { isAborted } from './abort.js'
import { presetForImageId } from './preset.js'
import { createStage } from './stage.js'
import { createFakeTimers } from './testing/fake-timers.js'
import { fakeMotion, fakeSheet, stageEnv } from './testing/fake-slots.js'

function destCanvas() {
  return {
    width: 64,
    height: 64,
    getContext: () => ({ clearRect: () => {}, drawImage: () => {} }),
    getBoundingClientRect: () => ({ width: 32, height: 32 }),
  } as unknown as HTMLCanvasElement
}

async function stageOf() {
  const timers = createFakeTimers()
  const sheet = fakeSheet()
  const stage = await createStage(
    { sheet, motion: fakeMotion(), maxSize: 384, present: 'blit' },
    stageEnv({ timers }),
  )
  if (stage instanceof Error || isAborted(stage)) return expect.fail('stage refused')
  return { stage, timers, sheet }
}

/**
 * A real macrotask boundary. `crumpleTo`'s target is resolved through a native
 * `Promise.resolve(target).then(…)` even when it is already settled, which a fully synchronous
 * `FakeTimers.advance()` cannot observe mid-call. This drains it, as `mount.test.ts` does.
 */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** Rise, park at the ball while the target settles, descend. */
async function settle(timers: ReturnType<typeof createFakeTimers>): Promise<void> {
  timers.advance(10_000)
  await flushMicrotasks()
  timers.advance(10_000)
}

describe('view.swapTo with a key that is not resident', () => {
  it('adds under the key it was given and mints nothing', async () => {
    const { stage, timers } = await stageOf()
    const view = await stage.mount({ key: 'a', src: '/a.png', canvas: destCanvas() })
    if (view instanceof Error || isAborted(view)) return expect.fail('mount refused')

    const run = view.swapTo('/b.png', { key: 'b' })
    await settle(timers)

    expect(await run).toBeUndefined()
    expect(view.sprite?.key).toBe('b')
    expect(stage.get('b')).toBe(view.sprite)
    // Nothing was minted: the key today's code would have used does not exist.
    expect(stage.get(`swap:${presetForImageId('/b.png')}:0`)).toBeUndefined()
    expect(stage.usage().handles).toBe(2)
    stage.dispose()
  })

  it('still mints its own key when none is given', async () => {
    const { stage, timers } = await stageOf()
    const view = await stage.mount({ key: 'a', src: '/a.png', canvas: destCanvas() })
    if (view instanceof Error || isAborted(view)) return expect.fail('mount refused')

    const run = view.swapTo('/b.png')
    await settle(timers)

    expect(await run).toBeUndefined()
    expect(view.sprite?.key).toBe(`swap:${presetForImageId('/b.png')}:0`)
    stage.dispose()
  })

  it('emits start synchronously with a key, exactly as it does without one', async () => {
    const { stage, timers } = await stageOf()
    const view = await stage.mount({ key: 'a', src: '/a.png', canvas: destCanvas() })
    if (view instanceof Error || isAborted(view)) return expect.fail('mount refused')
    const events: string[] = []
    view.on('start', () => events.push('start'))

    const run = view.swapTo('/b.png', { key: 'b' })
    // The guarantee `AudioContext.resume()` depends on, preserved through the composition.
    expect(events).toEqual(['start'])

    await settle(timers)
    await run
    stage.dispose()
  })
})

describe('view.swapTo with a key that IS resident', () => {
  it('adopts the resident sprite without an add — src is never read', async () => {
    const { stage, timers, sheet } = await stageOf()
    const view = await stage.mount({ key: 'a', src: '/a.png', canvas: destCanvas() })
    if (view instanceof Error || isAborted(view)) return expect.fail('mount refused')
    const b = await stage.add('/b.png', { key: 'b' })
    if (b instanceof Error || isAborted(b)) return expect.fail('add refused')
    const handles = stage.usage().handles
    const builds = sheet.calls.build.length

    // `42` is a source `add()` answers an `AssetError` for — `mount.test.ts` uses it for exactly
    // that. Reading it at all would settle an error here instead of `undefined`.
    const run = view.swapTo(42 as never, { key: 'b' })
    await settle(timers)

    expect(await run).toBeUndefined()
    expect(view.sprite).toBe(b) // the resident sprite itself, same identity
    expect(stage.usage().handles).toBe(handles)
    expect(sheet.calls.build).toHaveLength(builds)
    stage.dispose()
  })

  it('keeps start synchronous on the resident branch too', async () => {
    const { stage, timers } = await stageOf()
    const view = await stage.mount({ key: 'a', src: '/a.png', canvas: destCanvas() })
    if (view instanceof Error || isAborted(view)) return expect.fail('mount refused')
    const b = await stage.add('/b.png', { key: 'b' })
    if (b instanceof Error || isAborted(b)) return expect.fail('add refused')
    const events: string[] = []
    view.on('start', () => events.push('start'))

    const run = view.swapTo('/b.png', { key: 'b' })
    expect(events).toEqual(['start'])
    expect(typeof run.stop).toBe('function')

    await settle(timers)
    await run
    stage.dispose()
  })

  it('is still the full crumple, not a show() — it parks at the ball and lands at pose 0', async () => {
    const { stage, timers } = await stageOf()
    const view = await stage.mount({ key: 'a', src: '/a.png', canvas: destCanvas() })
    if (view instanceof Error || isAborted(view)) return expect.fail('mount refused')
    const b = await stage.add('/b.png', { key: 'b' })
    if (b instanceof Error || isAborted(b)) return expect.fail('add refused')

    const run = view.swapTo('/b.png', { key: 'b' })
    // A `show()` would have landed instantly at pose 0 with no run to wait on. A crumple has not
    // settled before the timers are advanced, and the view is still on the OLD sprite: the swap
    // adopts the target at the ball, not at the call.
    expect(view.sprite?.key).toBe('a')
    expect(await Promise.race([run.done, Promise.resolve('pending')])).toBe('pending')

    await settle(timers)
    expect(view.sprite?.key).toBe('b')
    expect(await run).toBeUndefined()
    expect(view.pose).toBe(0)
    stage.dispose()
  })

  it('swaps back to a picture already seen — the A -> B -> A that add() refuses', async () => {
    const { stage, timers, sheet } = await stageOf()
    const view = await stage.mount({ key: 'a', src: '/a.png', canvas: destCanvas() })
    if (view instanceof Error || isAborted(view)) return expect.fail('mount refused')

    const toB = view.swapTo('/b.png', { key: 'b' })
    await settle(timers)
    expect(await toB).toBeUndefined()
    const builds = sheet.calls.build.length

    const toA = view.swapTo('/a.png', { key: 'a' })
    await settle(timers)

    // Without the early return this is a SheetError: `a` is still resident and `add()` refuses it.
    expect(await toA).toBeUndefined()
    expect(view.sprite?.key).toBe('a')
    expect(stage.get('a')).toBe(view.sprite)
    expect(sheet.calls.build).toHaveLength(builds) // no second ingest of `a`
    stage.dispose()
  })
})
