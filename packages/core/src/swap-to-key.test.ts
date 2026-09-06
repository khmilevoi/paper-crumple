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
