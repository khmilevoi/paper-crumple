/**
 * # A swap onto a sprite whose front the byte budget evicted (§4.5, §5.3, §8.5, §8.8)
 *
 * The playground reproduces this with `budgetMb=8`: five samples are prefetched, the budget drops
 * every front that is not attached, and the reader then clicks "swap" onto one of them.
 * `swapTo` takes §5.3's cache-hit branch — the KEY is resident, so no `add()` runs — and hands
 * `crumpleTo` a bare `Sprite` whose FRONT is not resident. The rebuild `crumpleTo` runs at the
 * ball is synchronous only; §8.5's single artwork slot belongs to whichever sprite was sourced
 * last, so the rebuild answers `SourceExpiredError` and schedules an asynchronous re-source, and
 * the very next render draws a record whose `front` is still `null` —
 * `the front is not resident; prepare() it first`.
 */
import { describe, expect, it } from 'vitest'
import { isAborted } from './abort.js'
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

/**
 * The fake bitmap is 40x30 and `maxSize` is above it, so every front is 40x30x4 = 4800 bytes.
 * A budget of 9000 holds one front and not two: the LRU overshoots for the MRU and for an
 * attached sprite (§4.5), and drops everything else.
 */
const FRONT_BYTES = 40 * 30 * 4

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** Rise, park at the ball while the target settles, descend. */
async function settle(timers: ReturnType<typeof createFakeTimers>): Promise<void> {
  timers.advance(10_000)
  await flushMicrotasks()
  timers.advance(10_000)
  await flushMicrotasks()
  timers.advance(10_000)
  await flushMicrotasks()
}

async function stageOf() {
  const timers = createFakeTimers()
  const sheet = fakeSheet()
  const stage = await createStage(
    {
      sheet,
      motion: fakeMotion(),
      maxSize: 384,
      present: 'blit',
      budget: FRONT_BYTES * 2 - 1,
    },
    stageEnv({ timers }),
  )
  if (stage instanceof Error || isAborted(stage)) return expect.fail('stage refused')
  return { stage, timers, sheet }
}

describe('swapTo onto a resident key whose front was evicted', () => {
  it('rebuilds the front instead of drawing a null one', async () => {
    const { stage, timers } = await stageOf()
    const errors: Error[] = []
    stage.on('error', (e) => errors.push(e.error))

    const view = await stage.mount({ key: 'a', src: '/a.png', canvas: destCanvas() })
    if (view instanceof Error || isAborted(view)) return expect.fail('mount refused')

    // The playground's idle prefetch: two more samples the reader might swap to. The second one
    // takes §8.5's single artwork slot, and the budget drops the first one's front.
    const b = await stage.add('/b.png', { key: 'b' })
    if (b instanceof Error || isAborted(b)) return expect.fail('add b refused')
    const c = await stage.add('/c.png', { key: 'c' })
    if (c instanceof Error || isAborted(c)) return expect.fail('add c refused')

    // Preconditions: 'b' is still a sprite, its front is gone, and its artwork slot is 'c''s —
    // so no synchronous rebuild of 'b' can succeed.
    expect(stage.get('b')).toBeDefined()
    expect(stage.usage().fronts).toBe(2)

    const run = view.swapTo('/b.png', { key: 'b' })
    await settle(timers)

    expect(await run).toBeUndefined()
    expect(errors.map((e) => e.message)).toEqual([])
    expect(view.sprite?.key).toBe('b')
    expect(view.frame).not.toBeNull()
  })
})

/**
 * The other half of the same defect. An eviction DELETES the LRU's slot, and `attach`, `pin` and
 * `hold` are all no-ops for a key the LRU does not hold — so the `attach()` a view makes while
 * the front is gone lands nowhere, and the `insert()` the rebuild ends in creates a fresh slot
 * with `attachCount: 0`. §4.5's "an attached sprite is unevictable" is then false for exactly the
 * sprite a view is showing. `replace()` has always restored the pin and the attachments after its
 * own insert (`stage.ts`'s tail); `rebuildFront` did not.
 */
describe('a front rebuilt after its slot was evicted', () => {
  it('is attached again, so the sprite a view shows cannot be evicted', async () => {
    const { stage, timers } = await stageOf()
    const view = await stage.mount({ key: 'a', src: '/a.png', canvas: destCanvas() })
    if (view instanceof Error || isAborted(view)) return expect.fail('mount refused')
    // Errors are subscribed but not asserted here: `show()` on a front the stage must re-source
    // is the caller's to `prepare()`, and that refusal is not what this case is about.
    stage.on('error', () => {})

    const b = await stage.add('/b.png', { key: 'b' })
    if (b instanceof Error || isAborted(b)) return expect.fail('add b refused')
    const c = await stage.add('/c.png', { key: 'c' })
    if (c instanceof Error || isAborted(c)) return expect.fail('add c refused')

    // 'b''s front is gone and its slot with it. Showing it attaches a sprite the LRU has never
    // heard of, and the rebuild that follows is the insert that must restore the attachment.
    const second = stage.view({ canvas: destCanvas() })
    if (second instanceof Error) return expect.fail('view refused')
    second.show(b)
    timers.advance(10_000)
    await flushMicrotasks()
    timers.advance(10_000)
    await flushMicrotasks()

    expect(second.frame).not.toBeNull()

    // `stage.usage().attached` counts RECORDS, not slots, so it cannot see this: the proof is the
    // evictor itself. One more front to build, and a slot that still reads `attachCount: 0` hands
    // the sprite a view is showing straight to it.
    const d = await stage.add('/d.png', { key: 'd' })
    if (d instanceof Error || isAborted(d)) return expect.fail('add d refused')
    expect(second.frame).not.toBeNull()
  })
})
