import type { TimerHandle, Timers } from '../stepper.js'

/**
 * A manual clock for level-1 tests of the scheduler.
 *
 * **Test-only source.** It is reachable from neither `index.ts` nor `unstable.ts`, so `tsdown`
 * bundles none of it and it ships in no tarball. It is a plain `.ts` file rather than a
 * `.test.ts` one so that other suites can import it without Vitest collecting it as a suite of
 * its own.
 *
 * `advance` and `freeze` are two different things and the distinction is the point: `advance`
 * moves the clock *and* fires what falls due, which is an ordinary passage of time; `freeze`
 * moves the clock and fires nothing, which is a backgrounded tab whose timers were throttled.
 * The deficit cap can only be tested with the second.
 */
export interface FakeTimers extends Timers {
  /** Move the clock by `ms`, firing every timer that falls due, in due order. */
  advance(ms: number): void
  /** Move the clock by `ms` without firing anything. */
  freeze(ms: number): void
  readonly pending: number
  /**
   * How many times `yield()` was awaited. The fake's yield is a **microtask**, not a task: every
   * lane guarantee (§8.10) holds by construction of its queue, so no fake-timer test has to drive
   * a task boundary, and a budget test reads this count instead.
   */
  readonly yields: number
}

interface Scheduled {
  readonly at: number
  readonly seq: number
  readonly fn: () => void
}

export function createFakeTimers(start = 0): FakeTimers {
  let clock = start
  let seq = 0
  let yields = 0
  const queue = new Map<number, Scheduled>()

  function due(limit: number): number | null {
    let chosenId: number | null = null
    let chosen: Scheduled | null = null
    for (const [id, entry] of queue) {
      if (entry.at > limit) continue
      const earlier =
        chosen === null ||
        entry.at < chosen.at ||
        (entry.at === chosen.at && entry.seq < chosen.seq)
      if (earlier) {
        chosenId = id
        chosen = entry
      }
    }
    return chosenId
  }

  return {
    now: () => clock,
    setTimeoutFn(fn, ms) {
      seq += 1
      queue.set(seq, { at: clock + Math.max(0, ms), seq, fn })
      return seq
    },
    clearTimeoutFn(handle: TimerHandle) {
      if (typeof handle === 'number') queue.delete(handle)
    },
    advance(ms) {
      const target = clock + ms
      for (;;) {
        const id = due(target)
        if (id === null) break
        const entry = queue.get(id)
        if (entry === undefined) break
        queue.delete(id)
        clock = Math.max(clock, entry.at)
        entry.fn()
      }
      clock = Math.max(clock, target)
    },
    freeze(ms) {
      clock += ms
    },
    get pending() {
      return queue.size
    },
    yield() {
      yields += 1
      return Promise.resolve()
    },
    get yields() {
      return yields
    },
  }
}
