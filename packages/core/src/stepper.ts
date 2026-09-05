import type { Step } from './dwell.js'
import { nextTurn } from './next-turn.js'

/**
 * # The absolute-deadline stepper (§7.2)
 *
 * `deadline += dwell; delay = max(0, deadline − now())`. Absolute and not incremental, so a slow
 * render is absorbed by the next gap instead of pushing the whole schedule out — which is what
 * makes a run take `max(duration, Σ blocking)` while still reporting `completed: true`, and what
 * makes "the run overruns and no pose is skipped" fall out for free rather than needing a rule.
 *
 * One refinement over the spike: **the accumulated deficit is capped at one gap**, so a
 * backgrounded tab whose timers were throttled to a second does not fire every remaining pose
 * back to back on return. The cap is the gap that was just waited, which is the authored dwell
 * when no `duration` was given and the rescaled one when it was — the deadline is expressed in
 * the run's own time base, so the cap has to be too.
 */

/**
 * Opaque: the stepper only ever hands back what `setTimeoutFn` returned. It is `unknown` rather
 * than `ReturnType<typeof setTimeout>` because both `lib.dom` and `@types/node` are in scope and
 * that alias resolves to whichever wins, which is not something an injected clock should inherit.
 */
export type TimerHandle = unknown

/**
 * §11: "the scheduler's timer injection needs an API the original never exposed; the spike has
 * `setTimeoutFn` / `clearTimeoutFn` and it must survive the port." This is that API, plus the
 * clock, because an absolute-deadline scheduler that cannot be told what time it is cannot be
 * driven deterministically.
 */
export interface Timers {
  now(): number
  setTimeoutFn(fn: () => void, ms: number): TimerHandle
  clearTimeoutFn(handle: TimerHandle): void
  /**
   * §8.10 — the platform yield the ingest lane takes between two phases once a turn has spent
   * its budget: resolves in a later macrotask so the browser can paint and dispatch input in
   * between. `nextTurn()` on the system clock; a microtask on the test clock (§11), because every
   * lane guarantee holds by construction of the queue and none by a task boundary.
   */
  yield(): Promise<void>
}

/** The real clock. `performance.now()` and not `Date.now()`: deadlines want a monotonic clock. */
export const systemTimers: Timers = {
  now: () => performance.now(),
  setTimeoutFn: (fn, ms) => setTimeout(fn, ms),
  clearTimeoutFn: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  },
  yield: nextTurn,
}

export interface StepperOptions {
  readonly timers: Timers
  readonly steps: readonly Step[]
  /** Called once per step, in order. **Step 0 fires synchronously inside `runSteps`.** */
  readonly onStep: (step: Step, index: number) => void
  /** Called synchronously after the last `onStep` returns. No trailing dwell (§7.2). */
  readonly onDone: () => void
  /**
   * The absolute time `steps[i].offset` is measured from. Defaults to `timers.now()`. The swap's
   * fall passes the moment the ball was left, which is what "the deadline is re-based on leaving
   * the ball so a stall does not become debt the descent tries to catch up on" means.
   */
  readonly base?: number
}

export interface StepperHandle {
  /** Clears the armed timer. Idempotent, and a no-op once the walk has finished. */
  cancel(): void
  readonly finished: boolean
}

export function runSteps(o: StepperOptions): StepperHandle {
  const { timers, steps, onStep, onDone } = o
  let base = o.base ?? timers.now()
  let armed: TimerHandle = null
  let finished = false
  let cancelled = false

  const handle: StepperHandle = {
    cancel() {
      if (finished || cancelled) return
      cancelled = true
      if (armed !== null) {
        timers.clearTimeoutFn(armed)
        armed = null
      }
    },
    get finished() {
      return finished
    },
  }

  function fire(index: number): void {
    if (cancelled) return
    onStep(steps[index], index)
    schedule(index + 1)
  }

  function schedule(index: number): void {
    if (cancelled) return
    if (index >= steps.length) {
      finished = true
      onDone()
      return
    }
    const now = timers.now()
    let delay = base + steps[index].offset - now
    if (delay < 0) {
      // We are late. The deficit is capped at the gap we were waiting on, so at most one dwell of
      // catch-up happens and the remaining schedule re-bases rather than collapsing.
      const cap = steps[index].offset - steps[index - 1].offset
      const deficit = -delay
      if (deficit > cap) base += deficit - cap
      delay = 0
    }
    armed = timers.setTimeoutFn(() => {
      armed = null
      fire(index)
    }, delay)
  }

  if (steps.length === 0) {
    finished = true
    onDone()
    return handle
  }
  fire(0)
  return handle
}
