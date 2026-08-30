import { ABORTED, type Aborted } from './abort.js'
import { decideCollision, decideStop } from './collisions.js'
import { DWELL_MS, playPlan, resolvePose, type Step } from './dwell.js'
import type { Events } from './events.js'
import type { PoseRef } from './pose.js'
import type { AddError, PlayResult } from './results.js'
import { createRun, settledRun, type Run, type RunOwner } from './run.js'
import { runSteps, type StepperHandle, type TimerHandle, type Timers } from './stepper.js'
import type { ViewState } from './view-state.js'

/**
 * # The run controller (§7.1, §7.2, §4.4, §4.5)
 *
 * One controller drives at most one live run for one host. Every ordering rule §7.1 states is a
 * sequence of synchronous calls in this file, and every one of them is asserted at level 1 — no
 * GL, no DOM, no stage. The host is four methods and a clock wide, and P9 supplies it.
 */

/** Everything the runner needs from whoever owns the pixels. P9 implements this on a `View`. */
export interface RunHost {
  /** Emits on the host's own bus, synchronously. `error` is deliberately absent — see below. */
  emit<E extends 'start' | 'step' | 'end'>(event: E, payload: Events[E]): void
  /**
   * §10.6's policy is **P9's**, not this file's: the runner hands over an error and P9 decides
   * `observed`, adds `view` and emits it. A returned `ABORTED` is never passed here at all —
   * cancellation is not a failure (§10.5).
   */
  reportError(error: Error): void
  /** Draws one pose. Returns an Error to report a dropped frame; `undefined` on success. */
  render(pose: number): Error | undefined
  /** Pose index to stored-frame index, which is `MotionClip.keyFrames[pose]` on a real host. */
  frameFor(pose: number): number
  setState(state: ViewState): void
  readonly timers: Timers
}

export interface PlayOptions {
  /** One multiplier over the traversed dwells (§7.2). Clamped at zero; never negative. */
  duration?: number
  signal?: AbortSignal
}

/**
 * `stage.play`'s options. `duration` is **per view** — it must mean the same thing here as on
 * `view.play`, and a sound clip matches one traversal — so the wave's wall time is
 * `duration + (n − 1) × stagger`. P9 owns the staggering itself; this type is declared beside
 * `PlayOptions` so the two cannot drift.
 */
export interface StagePlayOptions extends PlayOptions {
  stagger?: number
}

export interface RunControllerConfig {
  /**
   * The pack's pose count, which `'ball'` resolves against. **Precondition:
   * `poseCount === (dwells ?? DWELL_MS).length`** — the schedule and the pack must agree, or
   * `'ball'` and the swap's ball index name different poses. P9 reads it from
   * `MotionClip.keyFrames.length` and re-creates the controller when the pack changes.
   */
  readonly poseCount: number
  /** Defaults to `DWELL_MS` (§7.2). */
  readonly dwells?: readonly number[]
}

/** What a live run can settle to. Every member is in both `PlayResult` and `SwapResult`. */
type LiveSettleValue = undefined | Aborted | AddError

interface LiveRun {
  readonly owner: RunOwner
  readonly from: number
  readonly to: number
  readonly startedAt: number
  readonly settle: (value: LiveSettleValue) => void
  stepper: StepperHandle | null
  parkTimer: TimerHandle | null
  detachSignal: (() => void) | null
  errored: boolean
  reachedTo: boolean
  cancelled: boolean
  settleValue: LiveSettleValue
}

export interface RunController {
  /** The live run's owner, or `null` when the host is idle. §4.4 compares against this. */
  readonly owner: RunOwner | null
  readonly live: boolean
  play(from: PoseRef, to: PoseRef, o?: PlayOptions & { owner?: RunOwner }): Run<PlayResult>
  /** §4.5: freezes at the current pose, issues no draw, tears down to `idle`. */
  stop(o?: { owner?: RunOwner; all?: boolean }): void
  /** §4.6: ends a live run with `completed: false`; every later call is refused. */
  dispose(): void
}

export function createRunController(host: RunHost, config: RunControllerConfig): RunController {
  const dwells = config.dwells ?? DWELL_MS
  const { poseCount } = config
  let current: LiveRun | null = null
  let disposed = false

  function detach(r: LiveRun): void {
    if (r.stepper !== null) {
      r.stepper.cancel()
      r.stepper = null
    }
    if (r.parkTimer !== null) {
      host.timers.clearTimeoutFn(r.parkTimer)
      r.parkTimer = null
    }
    if (r.detachSignal !== null) {
      r.detachSignal()
      r.detachSignal = null
    }
  }

  /**
   * §7.1: "a run tears itself down to `idle` — timer cleared, `run` set to `null` — **before** it
   * emits `end`. This is what lets a `play()` issued from an `end` handler run against a clean
   * view." The settle follows the `end`, so a `.then` continuation always lands after it.
   */
  function finish(r: LiveRun): void {
    if (current !== r) return
    const completed = r.reachedTo && !r.errored && !r.cancelled
    detach(r)
    current = null
    host.setState('idle')
    host.emit('end', { from: r.from, to: r.to, completed })
    r.settle(r.settleValue)
  }

  function cancel(r: LiveRun): void {
    if (current !== r) return
    r.cancelled = true
    r.settleValue = ABORTED
    finish(r)
  }

  /**
   * Inside the superseding call, in this order (§7.1): cancel the outgoing timer, tear down, emit
   * `end { completed: false }`, release any pending target, emit the new `start`. The superseded
   * run's settle is a resolved promise, so its continuation runs on a microtask after this whole
   * synchronous block — which is what makes "it always lands after the new `start`" true without
   * any explicit deferral.
   */
  function supersede(): void {
    // A loop rather than a single cancel. The `end` emitted below reaches the host's listeners
    // synchronously, and a listener is explicitly allowed to call `play()` from it — that call
    // installs its own run and leaves `current` pointing at it. A single cancel would return
    // here with that run still live, and the caller's `current = r` would then orphan it: its
    // timer would go on firing, its `finish` would no-op forever because `current` no longer
    // points at it, and an `await` on its `Run` would never settle. Cancelling until nothing is
    // live gives every such run the `end` and the `ABORTED` settle it is owed.
    //
    // It cannot spin: `cancel` is only ever passed `current` itself, and `finish` always clears
    // `current` before returning. In the assembled library it runs at most once, because P9
    // wires §7.1's single-slot deferral box between a handler and this controller.
    while (current !== null) cancel(current)
  }

  function attachSignal(r: LiveRun, signal: AbortSignal | undefined): void {
    if (signal === undefined) return
    const onAbort = (): void => {
      cancel(r)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    r.detachSignal = () => {
      signal.removeEventListener('abort', onAbort)
    }
  }

  /**
   * `step` is emitted for every scheduled render, a failed one included, and the error follows it
   * rather than replacing it. §7.1's "`start` is always immediately followed by `step { pose:
   * from }`" is unconditional, so nothing may come between them — and a failure is reported on
   * its own channel, where a consumer counting steps is not the audience for it.
   */
  function stepOnce(r: LiveRun, step: Step): void {
    const failure = host.render(step.pose)
    host.emit('step', {
      pose: step.pose,
      frame: host.frameFor(step.pose),
      ms: host.timers.now() - r.startedAt,
    })
    if (failure !== undefined) {
      r.errored = true
      host.reportError(failure)
    }
  }

  function startPayload(
    from: number,
    to: number,
    duration?: number,
    via?: number,
  ): Events['start'] {
    return {
      from,
      to,
      ...(duration === undefined ? {} : { duration }),
      ...(via === undefined ? {} : { via }),
    }
  }

  function play(
    fromRef: PoseRef,
    toRef: PoseRef,
    o: PlayOptions & { owner?: RunOwner } = {},
  ): Run<PlayResult> {
    if (disposed) return settledRun<PlayResult>(ABORTED)
    const owner = o.owner ?? 'view'
    const from = resolvePose(fromRef, poseCount)
    if (from instanceof Error) return settledRun<PlayResult>(from)
    const to = resolvePose(toRef, poseCount)
    if (to instanceof Error) return settledRun<PlayResult>(to)
    // A stage-scoped call losing to a view-owned run does nothing and emits nothing. P9's
    // `stage.play` decides this with `planStagePlay` first, so the skip reaches the report; the
    // check here is what keeps a direct call honest.
    if (decideCollision(owner, current?.owner ?? null) === 'skip') {
      return settledRun<PlayResult>(ABORTED)
    }
    if (o.signal?.aborted === true) return settledRun<PlayResult>(ABORTED)

    supersede()

    const plan = playPlan(from, to, { duration: o.duration, dwells })
    let record: LiveRun | null = null
    const handle = createRun<PlayResult>(() => {
      if (record !== null) cancel(record)
    })
    const r: LiveRun = {
      owner,
      from,
      to,
      startedAt: host.timers.now(),
      // A live `play` settles to `undefined` or to the sentinel: a `PoseError` is only ever a
      // refused call, which never becomes a live run, and a dropped frame goes out on `error`
      // rather than becoming a return value. So this narrowing is a check, not a cast.
      settle: (value) => {
        handle.settle(value === ABORTED ? ABORTED : undefined)
      },
      stepper: null,
      parkTimer: null,
      detachSignal: null,
      errored: false,
      reachedTo: false,
      cancelled: false,
      settleValue: undefined,
    }
    record = r
    current = r
    attachSignal(r, o.signal)
    host.setState('playing')
    host.emit('start', startPayload(from, to, o.duration))
    // `runSteps` fires step 0 synchronously, which is what puts `step { pose: from }` in the same
    // synchronous block as `start`. A one-step plan also finishes synchronously, before this
    // assignment — harmless, because a finished stepper has no armed timer for `detach` to clear.
    r.stepper = runSteps({
      timers: host.timers,
      base: r.startedAt,
      steps: plan.steps,
      onStep: (step) => {
        stepOnce(r, step)
      },
      onDone: () => {
        r.reachedTo = true
        finish(r)
      },
    })
    return handle.run
  }

  function stop(o: { owner?: RunOwner; all?: boolean } = {}): void {
    if (disposed) return
    const r = current
    // §4.5: `stop()` on an `idle` view emits nothing, or `end` would appear without a `start`.
    if (r === null) return
    if (!decideStop(o.owner ?? 'view', r.owner, o.all)) return
    cancel(r)
  }

  function dispose(): void {
    if (disposed) return
    // The `end` is emitted at `idle`, under the same teardown-before-`end` rule as every other
    // ending, and the view is marked `disposed` after it.
    // Loop for the same reason as `supersede`: a run a handler starts during this teardown would
    // otherwise still be live when the controller is marked disposed, and its eventual completion
    // would call `setState('idle')` and un-dispose the view.
    while (current !== null) cancel(current)
    disposed = true
    host.setState('disposed')
  }

  return {
    get owner() {
      return current?.owner ?? null
    },
    get live() {
      return current !== null
    },
    play,
    stop,
    dispose,
  }
}
