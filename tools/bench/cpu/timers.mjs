/**
 * A `Timers` implementation for the stage scenarios: a virtual clock whose queue is kept sorted
 * on insert, so `advance()` pops in O(1) per timer. `packages/core/src/testing/fake-timers.ts`
 * scans its whole map on every fire, which is fine for a test and would put an O(n^2) fixture
 * cost inside a 64-view tick measurement.
 */
export function createBenchTimers(start = 0) {
  let clock = start
  let seq = 0
  /** Sorted by `at`, then by `seq`; the next timer to fire is at index 0. */
  const queue = []

  return {
    now: () => clock,
    setTimeoutFn(fn, ms) {
      seq += 1
      const entry = { at: clock + Math.max(0, ms), seq, fn }
      let lo = 0
      let hi = queue.length
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        const q = queue[mid]
        if (q.at < entry.at || (q.at === entry.at && q.seq < entry.seq)) lo = mid + 1
        else hi = mid
      }
      queue.splice(lo, 0, entry)
      return entry
    },
    clearTimeoutFn(handle) {
      const at = queue.indexOf(handle)
      if (at >= 0) queue.splice(at, 1)
    },
    advance(ms) {
      const target = clock + ms
      while (queue.length > 0 && queue[0].at <= target) {
        const entry = queue.shift()
        clock = Math.max(clock, entry.at)
        entry.fn()
      }
      clock = Math.max(clock, target)
    },
    get pending() {
      return queue.length
    },
    // The lane's yield (spec 8.10): a microtask here, as in the test fake, so a scenario measures
    // the lane's own cost and never a task boundary.
    yield: () => Promise.resolve(),
  }
}
