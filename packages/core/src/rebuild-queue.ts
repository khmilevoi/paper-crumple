import type { Timers } from './stepper.js'

/**
 * §8.8's five demands. "Triggered by demand, not by a clock" needed a definition, and this is it:
 *
 * 1. `show` — `view.show(sprite)` where that sprite's front is not resident;
 * 2. `step` — the top of a step callback whose next render needs a dirty or non-resident front;
 * 3. `front-set` — a front-class `set()` on a sprite with `attachCount > 0`;
 * 4. `prepare` — `stage.prepare(key)`;
 * 5. `target-settled` — settlement of a `crumpleTo` target while the view is rising or parked;
 *    the park is free time and the ideal moment to build the incoming front.
 */
export type RebuildDemand = 'show' | 'step' | 'front-set' | 'prepare' | 'target-settled'

/** The drain's budget, in milliseconds. The absolute-deadline scheduler absorbs an overrun. */
export const REBUILD_BUDGET_MS = 4

export interface RebuildQueue {
  /**
   * Mark a front dirty. **Does not rebuild.** A front-class `set()` on a running view marks and
   * returns: a slider dragged at 60 Hz would otherwise fire sixty rebuilds inside one dwell for
   * one visible result. The rebuild lands at the top of the next step, at most one dwell
   * (70–135 ms) later, and until it lands the view draws the last front it drew successfully, at
   * the new pose — never a blank frame, never a skipped step.
   */
  mark(key: string): void
  dirty(key: string): boolean
  /**
   * Drain synchronously, on the calling turn. Completes `mandatory` first and **whatever it
   * costs**, then as much of the queue as fits in `REBUILD_BUDGET_MS`. Returns the keys it built,
   * in the order it built them.
   */
  drain(o: { demand: RebuildDemand; mandatory?: string }): readonly string[]
  /** Drop a key without building it — a removed sprite, or one whose `add()` aborted. */
  forget(key: string): void
  readonly size: number
}

export function createRebuildQueue(o: {
  timers: Timers
  rebuild: (key: string) => void
}): RebuildQueue {
  // A Set preserves insertion order, which is the queue's order and needs no second structure.
  const pending = new Set<string>()
  let draining = false

  return {
    mark(key) {
      pending.add(key)
    },
    dirty(key) {
      return pending.has(key)
    },
    forget(key) {
      pending.delete(key)
    },
    get size() {
      return pending.size
    },
    drain(opts) {
      // Re-entrancy: a rebuild that marks another key must not extend the drain that is running,
      // or one slider drag could hold the main thread for the whole of a dwell.
      if (draining) return []
      draining = true
      const built: string[] = []
      const started = o.timers.now()

      if (opts.mandatory !== undefined) {
        pending.delete(opts.mandatory)
        built.push(opts.mandatory)
        o.rebuild(opts.mandatory)
      }

      // Snapshot: a rebuild that marks a key must not be drained by this same pass.
      for (const key of [...pending]) {
        if (o.timers.now() - started >= REBUILD_BUDGET_MS) break
        pending.delete(key)
        built.push(key)
        o.rebuild(key)
      }

      draining = false
      return built
    },
  }
}
