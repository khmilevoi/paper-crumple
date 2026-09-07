import { describe, expect, it, vi } from 'vitest'
import { playPlan } from './dwell.js'
import { runSteps, systemTimers } from './stepper.js'
import { createFakeTimers } from './testing/fake-timers.js'

describe('runSteps', () => {
  it('fires the first step synchronously, inside the call', () => {
    const timers = createFakeTimers(1000)
    const seen: number[] = []
    runSteps({
      timers,
      steps: playPlan(0, 5).steps,
      onStep: (s) => seen.push(s.pose),
      onDone: () => {},
    })
    expect(seen).toEqual([0])
  })

  it('walks the whole plan on the authored cadence', () => {
    const timers = createFakeTimers(0)
    const seen: Array<{ pose: number; at: number }> = []
    runSteps({
      timers,
      steps: playPlan(0, 5).steps,
      onStep: (s) => seen.push({ pose: s.pose, at: timers.now() }),
      onDone: () => {},
    })
    timers.advance(1000)
    expect(seen).toEqual([
      { pose: 0, at: 0 },
      { pose: 1, at: 95 },
      { pose: 2, at: 165 },
      { pose: 3, at: 285 },
      { pose: 4, at: 360 },
      { pose: 5, at: 495 },
    ])
  })

  it('settles immediately after the last render, with no trailing dwell (§7.2)', () => {
    const timers = createFakeTimers(0)
    let doneAt = -1
    runSteps({
      timers,
      steps: playPlan(0, 5).steps,
      onStep: () => {},
      onDone: () => {
        doneAt = timers.now()
      },
    })
    timers.advance(1000)
    expect(doneAt).toBe(495)
    expect(timers.pending).toBe(0)
  })

  it('finishes a one-step plan synchronously — play(x, x) is one render, zero dwells', () => {
    const timers = createFakeTimers(0)
    const order: string[] = []
    runSteps({
      timers,
      steps: playPlan(3, 3).steps,
      onStep: () => order.push('step'),
      onDone: () => order.push('done'),
    })
    expect(order).toEqual(['step', 'done'])
    expect(timers.pending).toBe(0)
  })

  it('calls onDone synchronously for an empty plan rather than hanging', () => {
    const timers = createFakeTimers(0)
    const onDone = vi.fn()
    runSteps({ timers, steps: [], onStep: () => {}, onDone })
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('is absolute, not incremental: a slow render does not push the next deadline out', () => {
    const timers = createFakeTimers(0)
    const at: number[] = []
    runSteps({
      timers,
      steps: playPlan(0, 2).steps,
      onStep: () => {
        at.push(timers.now())
        // A render that blocks for 30 ms. `deadline += dwell` is unaffected by it.
        timers.freeze(30)
      },
      onDone: () => {},
    })
    timers.advance(1000)
    expect(at).toEqual([0, 95, 165])
  })

  it('overruns rather than skipping a pose when the blocking cost exceeds the gap', () => {
    const timers = createFakeTimers(0)
    const seen: number[] = []
    runSteps({
      timers,
      // `duration: 0` is the degenerate rescale: every gap is zero and the run costs whatever
      // the renders cost. §7.2: six hard steps *are* the effect, and no pose is skipped.
      steps: playPlan(0, 5, { duration: 0 }).steps,
      onStep: (s) => {
        seen.push(s.pose)
        timers.freeze(9)
      },
      onDone: () => {},
    })
    timers.advance(1000)
    expect(seen).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('caps the accumulated deficit at one gap, so a throttled tab does not fire everything at once', () => {
    const timers = createFakeTimers(0)
    const at: number[] = []
    runSteps({
      timers,
      steps: playPlan(0, 5).steps,
      onStep: () => at.push(timers.now()),
      onDone: () => {},
    })
    // The tab is backgrounded for a second during the first gap: the clock moves and no timer
    // fires. Without a cap, every remaining pose would fire back to back on return.
    timers.freeze(1000)
    timers.advance(0)
    // Step 1 is due immediately, and step 2 is at most one gap behind — after that the schedule
    // has re-based and the authored cadence resumes.
    expect(at.slice(0, 3)).toEqual([0, 1000, 1000])
    timers.advance(1000)
    // The schedule re-based by 835 − 70 = 765, so the remaining deadlines are the authored ones
    // shifted by 765 and nothing after step 2 is swallowed.
    expect(at).toEqual([0, 1000, 1000, 1050, 1125, 1260])
    expect(at[4] - at[3]).toBe(75)
    expect(at[5] - at[4]).toBe(135)
  })

  it('cancel() clears the armed timer and stops the walk', () => {
    const timers = createFakeTimers(0)
    const seen: number[] = []
    const handle = runSteps({
      timers,
      steps: playPlan(0, 5).steps,
      onStep: (s) => seen.push(s.pose),
      onDone: () => {},
    })
    handle.cancel()
    expect(timers.pending).toBe(0)
    timers.advance(1000)
    expect(seen).toEqual([0])
  })

  it('cancel() after the walk finished is a no-op, and finished says so', () => {
    const timers = createFakeTimers(0)
    const handle = runSteps({
      timers,
      steps: playPlan(3, 3).steps,
      onStep: () => {},
      onDone: () => {},
    })
    expect(handle.finished).toBe(true)
    expect(() => handle.cancel()).not.toThrow()
  })

  it('never calls onDone twice, even if cancel races the last step', () => {
    const timers = createFakeTimers(0)
    const onDone = vi.fn()
    const handle = runSteps({
      timers,
      steps: playPlan(0, 1).steps,
      onStep: () => {},
      onDone,
    })
    timers.advance(1000)
    handle.cancel()
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('accepts an explicit base, which is how the fall re-bases on leaving the ball', () => {
    const timers = createFakeTimers(500)
    const at: number[] = []
    runSteps({
      timers,
      // Deliberately *not* `timers.now()`. A base equal to the clock cannot tell honouring `base`
      // apart from ignoring it, and `base` is what keeps the swap's descent from carrying a stall
      // at the ball as debt. Here the run's clock began 100 ms before this call, so the second
      // step is due 35 ms from now rather than the authored 135.
      base: 400,
      steps: playPlan(4, 3).steps,
      onStep: () => at.push(timers.now()),
      onDone: () => {},
    })
    timers.advance(1000)
    expect(at).toEqual([500, 535])
  })
})

describe('systemTimers', () => {
  it('is the real clock, and its handle round-trips through clearTimeoutFn', () => {
    expect(typeof systemTimers.now()).toBe('number')
    const handle = systemTimers.setTimeoutFn(() => {}, 10_000)
    expect(() => systemTimers.clearTimeoutFn(handle)).not.toThrow()
  })

  it('is monotonic, which is what an absolute-deadline scheduler needs', () => {
    const a = systemTimers.now()
    const b = systemTimers.now()
    expect(b).toBeGreaterThanOrEqual(a)
  })
})

describe('createFakeTimers', () => {
  it('fires in due order, breaking ties by registration', () => {
    const timers = createFakeTimers(0)
    const seen: string[] = []
    timers.setTimeoutFn(() => seen.push('b'), 10)
    timers.setTimeoutFn(() => seen.push('a'), 5)
    timers.setTimeoutFn(() => seen.push('c'), 10)
    timers.advance(20)
    expect(seen).toEqual(['a', 'b', 'c'])
  })

  it('fires timers a callback schedules inside the same advance', () => {
    const timers = createFakeTimers(0)
    const seen: number[] = []
    timers.setTimeoutFn(() => {
      seen.push(timers.now())
      timers.setTimeoutFn(() => seen.push(timers.now()), 5)
    }, 5)
    timers.advance(20)
    expect(seen).toEqual([5, 10])
  })

  it('freeze moves the clock without firing anything — a throttled background tab', () => {
    const timers = createFakeTimers(0)
    const fired = vi.fn()
    timers.setTimeoutFn(fired, 5)
    timers.freeze(1000)
    expect(fired).not.toHaveBeenCalled()
    expect(timers.now()).toBe(1000)
    timers.advance(0)
    expect(fired).toHaveBeenCalledTimes(1)
  })

  it('clearTimeoutFn removes a pending timer', () => {
    const timers = createFakeTimers(0)
    const fired = vi.fn()
    const handle = timers.setTimeoutFn(fired, 5)
    timers.clearTimeoutFn(handle)
    timers.advance(20)
    expect(fired).not.toHaveBeenCalled()
    expect(timers.pending).toBe(0)
  })

  it('yield() counts the yield and leaves the clock alone', async () => {
    const timers = createFakeTimers(0)
    const fired = vi.fn()
    timers.setTimeoutFn(fired, 2)
    await timers.yield()
    expect(timers.yields).toBe(1)
    expect(timers.now()).toBe(0)
    expect(fired).not.toHaveBeenCalled()
  })

  it('yield({ delay }) advances the clock by delay — firing what falls due — and still counts', async () => {
    const timers = createFakeTimers(0)
    const fired = vi.fn()
    timers.setTimeoutFn(fired, 2)
    await timers.yield({ delay: 1 })
    expect(timers.now()).toBe(1)
    expect(fired).not.toHaveBeenCalled()
    await timers.yield({ delay: 1 })
    expect(timers.now()).toBe(2)
    expect(timers.yields).toBe(2)
    expect(fired).toHaveBeenCalledTimes(1)
  })
})
