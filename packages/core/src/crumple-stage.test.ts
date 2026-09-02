import { describe, expect, it } from 'vitest'
import { ABORTED, isAborted } from './abort.js'
import { AssetError, PoseError, SheetError } from './errors.js'
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

async function scene() {
  const timers = createFakeTimers()
  const sheet = fakeSheet()
  const motion = fakeMotion()
  const stage = await createStage(
    { sheet, motion, maxSize: 384, present: 'blit' },
    stageEnv({ timers }),
  )
  if (stage instanceof Error || isAborted(stage)) return expect.fail('stage refused')
  const a = await stage.add('/a.png', { key: 'a' })
  const b = await stage.add('/b.png', { key: 'b' })
  if (a instanceof Error || isAborted(a) || b instanceof Error || isAborted(b))
    return expect.fail('add refused')
  const view = stage.view({ canvas: destCanvas(), tag: 'tile' })
  if (view instanceof Error) return expect.fail('view refused')
  view.show(a)
  return { stage, sheet, motion, timers, a, b, view }
}

// `crumpleTo`'s target is always resolved through a real, native `Promise.resolve(target).then(…)`
// in `runner.ts` — even for an already-settled target — so `FakeTimers.advance()` (fully
// synchronous, and unlike a real `setTimeout` it never lets the microtask queue drain between the
// timers it fires) cannot observe that resolution mid-`advance()`. A real macrotask boundary is
// what a caller gets for free between two real `setTimeout`s and is what this buys back for a
// fake one: draining every microtask the target's settlement queued, deterministically, before the
// next `advance()` is asked to drive the poses that settlement unblocked.
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('view.play and view.crumpleTo', () => {
  it('releases the target hold when the swap is stopped before the ball (§4.5)', async () => {
    const s = await scene()
    const run = s.view.crumpleTo(s.b)
    // Well short of the first dwell: the run is live, rising, and nowhere near `adopt`.
    s.timers.advance(10)
    s.view.stop()
    expect(isAborted(await run)).toBe(true)
    await flushMicrotasks()
    // `a` is attached to the view and is the MRU, which the LRU never evicts; `b` is the only
    // candidate, and it is one only if the hold the crumpleTo took has been released.
    s.stage.budget({ bytes: 1 })
    expect(s.stage.usage().fronts).toBe(1)
    expect(s.stage.get('b')?.key).toBe('b')
    s.stage.dispose()
  })

  it('returns a Run and not a promise, and emits start before it returns', async () => {
    const s = await scene()
    const events: string[] = []
    s.view.on('start', () => events.push('start'))
    const run = s.view.play('flat', 'ball')
    // The whole point of amendment 22: `start` is already emitted, synchronously, which is what
    // lets `AudioContext.resume()` be called from inside the user gesture (§7.1).
    expect(events).toEqual(['start'])
    expect(typeof run.stop).toBe('function')
    expect(s.view.run).toBe(run)
    expect(s.view.state).toBe('playing')
    s.timers.advance(10_000)
    expect(await run).toBeUndefined()
    expect(s.view.run).toBeNull()
    expect(s.view.state).toBe('idle')
    s.stage.dispose()
  })

  it('draws every pose in the traversal and reports resolved indices', async () => {
    const s = await scene()
    const poses: number[] = []
    s.view.on('step', (e) => poses.push(e.pose))
    const run = s.view.play('flat', 'ball')
    s.timers.advance(10_000)
    await run
    expect(poses).toEqual([0, 1, 2, 3, 4, 5])
    expect(s.view.pose).toBe(5)
    s.stage.dispose()
  })

  it('play(x, x) is still legal — one render, zero dwells — and still emits a run', async () => {
    const s = await scene()
    const events: string[] = []
    s.view.on('start', () => events.push('start'))
    s.view.on('end', () => events.push('end'))
    const run = s.view.play(2, 2)
    s.timers.advance(10_000)
    await run
    expect(events).toEqual(['start', 'end'])
    s.stage.dispose()
  })

  it('a later view-scoped call supersedes the live run (§4.4)', async () => {
    const s = await scene()
    const first = s.view.play('flat', 'ball')
    const second = s.view.play('ball', 'flat')
    s.timers.advance(10_000)
    // A superseded run is cancelled (§7.1), and a cancelled run settles to the sentinel exactly
    // like `stop()`'s — `runner.test.ts`'s "settles the superseded run to the sentinel" pins the
    // same value at level 1, so `first` resolves to `ABORTED` rather than to `undefined`.
    expect(await first).toBe(ABORTED)
    await second
    expect(s.view.run).toBeNull()
    s.stage.dispose()
  })

  it('crumpleTo swaps between the pose-5 render and the pose-4 render', async () => {
    const s = await scene()
    const poses: number[] = []
    s.view.on('step', (e) => poses.push(e.pose))
    const run = s.view.crumpleTo(s.b)
    s.timers.advance(10_000)
    await flushMicrotasks()
    s.timers.advance(10_000)
    expect(await run).toBeUndefined()
    // One run, one start, one end, with `via: ball`; pose 5 is drawn once.
    expect(poses.filter((x) => x === 5)).toHaveLength(1)
    expect(s.view.sprite).toBe(s.b)
    expect(s.view.pose).toBe(0)
    s.stage.dispose()
  })

  it('emits one start carrying via: ball, and one end', async () => {
    const s = await scene()
    const starts: Array<{ from: number; to: number; via?: number }> = []
    let ends = 0
    s.view.on('start', (e) => starts.push(e))
    s.view.on('end', () => (ends += 1))
    const run = s.view.crumpleTo(s.b)
    s.timers.advance(10_000)
    await flushMicrotasks()
    s.timers.advance(10_000)
    await run
    expect(starts).toHaveLength(1)
    expect(starts[0]?.via).toBe(5)
    expect(ends).toBe(1)
    s.stage.dispose()
  })

  it('parks at the ball for an unresolved target and uncrumples into whatever arrives', async () => {
    const s = await scene()
    let settle: (v: unknown) => void = () => {}
    const pending = new Promise<never>((r) => (settle = r as never))
    const run = s.view.crumpleTo(pending as never)
    s.timers.advance(10_000)
    expect(s.view.state).toBe('crumpling.ball')
    settle(s.b)
    await flushMicrotasks()
    s.timers.advance(10_000)
    expect(await run).toBeUndefined()
    expect(s.view.sprite).toBe(s.b)
    s.stage.dispose()
  })

  it('rolls back 4 to 0 on the old sprite when the target fails, and resolves to that error', async () => {
    const s = await scene()
    const run = s.view.crumpleTo(Promise.resolve(new AssetError('404')) as never)
    s.timers.advance(10_000)
    await flushMicrotasks()
    s.timers.advance(10_000)
    const settled = await run
    expect(settled).toBeInstanceOf(AssetError)
    expect(s.view.sprite).toBe(s.a)
    expect(s.view.pose).toBe(0)
    s.stage.dispose()
  })

  it('crumpleTo on an empty view degenerates to show()', async () => {
    const s = await scene()
    const empty = s.stage.view({ canvas: destCanvas() })
    if (empty instanceof Error) return expect.fail('view refused')
    const run = empty.crumpleTo(s.b)
    s.timers.advance(10_000)
    expect(await run).toBeUndefined()
    expect(empty.sprite).toBe(s.b)
    expect(empty.pose).toBe(0)
    s.stage.dispose()
  })

  it('holds the pending target against eviction while the view is parked (§4.5)', async () => {
    const s = await scene()
    let settle: (v: unknown) => void = () => {}
    const pending = new Promise<never>((r) => (settle = r as never))
    s.view.crumpleTo(pending as never)
    s.timers.advance(10_000)
    s.stage.budget({ bytes: 1 })
    settle(s.b)
    await flushMicrotasks()
    // The incoming sprite's front survived the squeeze: a view parked at the ball for two seconds
    // must not have its incoming sprite evicted before the swap.
    expect(s.stage.get('b')?.frontSize.w).toBeGreaterThan(0)
    s.stage.dispose()
  })

  it('stop() freezes at the current pose and issues no draw', async () => {
    const s = await scene()
    const run = s.view.play('flat', 'ball')
    s.timers.advance(200)
    const drawsBefore = s.motion.calls.draw.length
    const poseBefore = s.view.pose
    s.view.stop()
    expect(s.motion.calls.draw).toHaveLength(drawsBefore)
    expect(s.view.pose).toBe(poseBefore)
    expect(s.view.state).toBe('idle')
    expect(s.view.run).toBeNull()
    await run
    s.stage.dispose()
  })

  it('stop() on an idle view emits nothing, or end would appear without a start', async () => {
    const s = await scene()
    let ends = 0
    s.view.on('end', () => (ends += 1))
    s.view.stop()
    expect(ends).toBe(0)
    s.stage.dispose()
  })

  it('an aborted signal settles the run to ABORTED and emits nothing on error', async () => {
    const s = await scene()
    const seen: unknown[] = []
    s.stage.on('error', (e) => seen.push(e))
    const controller = new AbortController()
    const run = s.view.play('flat', 'ball', { signal: controller.signal })
    controller.abort()
    s.timers.advance(10_000)
    expect(isAborted(await run)).toBe(true)
    expect(seen).toEqual([])
    s.stage.dispose()
  })

  it('dispose() ends a live run with completed: false and refuses everything after', async () => {
    const s = await scene()
    let ended: boolean | undefined
    s.view.on('end', (e) => (ended = e.completed))
    const run = s.view.play('flat', 'ball')
    s.view.dispose()
    expect(ended).toBe(false)
    expect(isAborted(await run) || (await run) === undefined).toBe(true)
    expect(s.view.state).toBe('disposed')
    expect(s.view.show(s.a)).toBeInstanceOf(SheetError)
    s.stage.dispose()
  })

  it('an out-of-range pose is a PoseError on the run, not a throw', async () => {
    const s = await scene()
    const run = s.view.play(0, 99)
    s.timers.advance(10_000)
    expect(await run).toBeInstanceOf(PoseError)
    s.stage.dispose()
  })
})
