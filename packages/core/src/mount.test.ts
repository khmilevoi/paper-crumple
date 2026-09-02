import { describe, expect, it } from 'vitest'
import { isAborted } from './abort.js'
import { AssetError, SheetError, ViewError } from './errors.js'
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
  const stage = await createStage(
    { sheet: fakeSheet(), motion: fakeMotion(), maxSize: 384, present: 'blit' },
    stageEnv({ timers }),
  )
  if (stage instanceof Error || isAborted(stage)) return expect.fail('stage refused')
  return { stage, timers }
}

// `crumpleTo`'s target is always resolved through a real, native `Promise.resolve(target).then(…)`
// in `runner.ts` — even for an already-settled target — so `FakeTimers.advance()` (fully
// synchronous, and unlike a real `setTimeout` it never lets the microtask queue drain between the
// timers it fires) cannot observe that resolution mid-`advance()`. A real macrotask boundary is
// what a caller gets for free between two real `setTimeout`s and is what this buys back for a
// fake one: draining every microtask the target's settlement queued, deterministically, before the
// next `advance()` is asked to drive the poses that settlement unblocked. See
// `crumple-stage.test.ts`'s own `flushMicrotasks()`.
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('stage.mount', () => {
  it('is add + view + show("flat") in one call, and loses nothing the three-call form had', async () => {
    const { stage } = await stageOf()
    const view = await stage.mount({
      key: 'k',
      src: '/a.png',
      canvas: destCanvas(),
      tag: 'tile-0',
    })
    if (view instanceof Error || isAborted(view)) return expect.fail('mount refused')
    expect(view.tag).toBe('tile-0')
    expect(view.pose).toBe(0)
    // `View.sprite` (amendment 14) is what lets the composed form lose nothing.
    expect(view.sprite?.key).toBe('k')
    expect(stage.get('k')).toBe(view.sprite)
    expect(stage.views).toEqual([view])
    stage.dispose()
  })

  it('returns the AddError and creates no view when add fails', async () => {
    const { stage } = await stageOf()
    await stage.add('/a.png', { key: 'k' })
    const out = await stage.mount({ key: 'k', src: '/b.png', canvas: destCanvas() })
    expect(out).toBeInstanceOf(SheetError)
    expect(stage.views).toEqual([])
    stage.dispose()
  })

  it('returns the ViewError and removes the sprite it just added when view fails', async () => {
    const { stage } = await stageOf()
    const el = destCanvas()
    stage.view({ canvas: el })
    const out = await stage.mount({ key: 'k', src: '/a.png', canvas: el })
    expect(out).toBeInstanceOf(ViewError)
    // "The return value is the complete account": a sprite nobody can reach is not kept.
    expect(stage.get('k')).toBeUndefined()
    stage.dispose()
  })

  it('honours pin: true and fit', async () => {
    const { stage } = await stageOf()
    const view = await stage.mount({
      key: 'k',
      src: '/a.png',
      canvas: destCanvas(),
      fit: 'contain',
      pin: true,
    })
    if (view instanceof Error || isAborted(view)) return expect.fail('mount refused')
    expect(view.sprite?.pinned).toBe(true)
    stage.dispose()
  })

  it('returns ABORTED and keeps nothing when the signal fires', async () => {
    const { stage } = await stageOf()
    const controller = new AbortController()
    controller.abort()
    const out = await stage.mount(
      { key: 'k', src: '/a.png', canvas: destCanvas() },
      { signal: controller.signal },
    )
    expect(isAborted(out)).toBe(true)
    expect(stage.get('k')).toBeUndefined()
    stage.dispose()
  })
})

describe('view.swapTo', () => {
  it('is not async: start is emitted synchronously before it returns', async () => {
    const { stage, timers } = await stageOf()
    const view = await stage.mount({ key: 'a', src: '/a.png', canvas: destCanvas() })
    if (view instanceof Error || isAborted(view)) return expect.fail('mount refused')
    const events: string[] = []
    view.on('start', () => events.push('start'))
    const run = view.swapTo('/b.png')
    // The guarantee `AudioContext.resume()` depends on, preserved through the composition.
    expect(events).toEqual(['start'])
    expect(typeof run.stop).toBe('function')
    timers.advance(10_000)
    await flushMicrotasks()
    timers.advance(10_000)
    await run
    stage.dispose()
  })

  it('parks at the ball while the add resolves, then uncrumples into it', async () => {
    const { stage, timers } = await stageOf()
    const view = await stage.mount({ key: 'a', src: '/a.png', canvas: destCanvas() })
    if (view instanceof Error || isAborted(view)) return expect.fail('mount refused')
    const run = view.swapTo('/b.png')
    timers.advance(10_000)
    await flushMicrotasks()
    timers.advance(10_000)
    expect(await run).toBeUndefined()
    expect(view.sprite?.key).not.toBe('a')
    expect(view.pose).toBe(0)
    stage.dispose()
  })

  it("rolls back to the old sprite and settles to the target's error when the add fails", async () => {
    const { stage, timers } = await stageOf()
    const view = await stage.mount({ key: 'a', src: '/a.png', canvas: destCanvas() })
    if (view instanceof Error || isAborted(view)) return expect.fail('mount refused')
    const run = view.swapTo(42 as never)
    timers.advance(10_000)
    await flushMicrotasks()
    timers.advance(10_000)
    expect(await run).toBeInstanceOf(AssetError)
    expect(view.sprite?.key).toBe('a')
    stage.dispose()
  })
})

describe('remove(key, { detach: true })', () => {
  it('disposes the views the stage knows about, so the caller does not have to find them', async () => {
    const { stage } = await stageOf()
    const view = await stage.mount({ key: 'k', src: '/a.png', canvas: destCanvas() })
    if (view instanceof Error || isAborted(view)) return expect.fail('mount refused')
    expect(stage.remove('k')).toBeInstanceOf(SheetError)
    expect(stage.remove('k', { detach: true })).toBeUndefined()
    expect(view.state).toBe('disposed')
    expect(stage.get('k')).toBeUndefined()
    stage.dispose()
  })
})
