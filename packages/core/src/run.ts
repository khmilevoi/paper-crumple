import type { PlayResult } from './results.js'

/**
 * # The `Run` object (§4.2, amendment 22)
 *
 * `view.play`, `view.crumpleTo` and `view.swapTo` return a `Run`. **`stage.play` does not** — it
 * keeps §4.4's `{ started, skipped, failed, completed }` report, because "skipping is never
 * silent" rests on that report and one settled value cannot say that view 7 was busy while view
 * 12 had no sprite. The scope qualifier is load-bearing and the two shapes must not be collapsed.
 */

/**
 * §4.4: every run carries an owner, and every collision compares the caller's scope to it. A
 * `view.*` call is view-scoped — the caller named this view. A `stage.*` call is stage-scoped — a
 * bulk convenience over a set the caller did not individually name.
 */
export type RunOwner = 'view' | 'stage'

/**
 * A thenable, so `await view.play('flat', 'ball')` reads exactly as it did. But the returned
 * value stops **being** a promise, and that is the entire point: §4.2 warns that refactoring
 * `crumpleTo` to `async` silently breaks iOS audio, because `start` must be emitted synchronously
 * before the call returns, and a prose warning cannot prevent that edit. A non-promise return
 * type turns it into a type error at every call site, because an `async` method cannot return a
 * `Run`.
 *
 * Generic in its payload and defaulting to `PlayResult`: `crumpleTo` and `swapTo` resolve to the
 * *target's* error when a pending sprite fails and the view rolls back, and a plain `play` between
 * two poses of one sprite cannot. One fixed settle type would have deleted that case, which is a
 * real return value and not a scheduling outcome.
 *
 * **`done` never rejects.** A failing run resolves to an Error (§10.8) and a cancelled one
 * resolves to `ABORTED`, so an unawaited `Run` can never become an unhandled rejection.
 */
export interface Run<R = PlayResult> extends PromiseLike<R> {
  readonly done: Promise<R>
  /** Stops this one run without touching the others. */
  stop(): void
}

/** The writable side of a `Run`, held by whoever drives it. Never handed to a consumer. */
export interface RunHandle<R> {
  readonly run: Run<R>
  readonly settled: boolean
  /** First call wins; every later call is ignored, which is what "exactly one `end`" needs. */
  settle(value: R): void
}

export function createRun<R>(stop: () => void): RunHandle<R> {
  let settled = false
  let resolve: (value: R) => void = () => {}
  const done = new Promise<R>((r) => {
    resolve = r
  })
  const run: Run<R> = {
    done,
    stop,
    then<T1 = R, T2 = never>(
      onfulfilled?: ((value: R) => T1 | PromiseLike<T1>) | null,
      onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
    ): PromiseLike<T1 | T2> {
      return done.then(onfulfilled, onrejected)
    },
  }
  return {
    run,
    get settled() {
      return settled
    },
    settle(value) {
      if (settled) return
      settled = true
      resolve(value)
    },
  }
}

/**
 * A run that never started: already settled, and stopping it does nothing. This is what a refused
 * call returns — a disposed view, an argument error, a pre-aborted signal, or a stage-scoped call
 * that lost to a view-owned run. §7.1: "a run that never started emits neither" `start` nor `end`.
 */
export function settledRun<R>(value: R): Run<R> {
  const handle = createRun<R>(() => {})
  handle.settle(value)
  return handle.run
}
