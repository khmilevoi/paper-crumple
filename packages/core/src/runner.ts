import { ABORTED, isAborted, type Aborted } from './abort.js'
import { decideCollision, decideStop } from './collisions.js'
import { AssetError } from './errors.js'
import {
  ballPose,
  DWELL_MS,
  playPlan,
  resolvePose,
  swapPlan,
  type Step,
  type SwapPlan,
} from './dwell.js'
import type { Events } from './events.js'
import type { PoseRef } from './pose.js'
import type { AddError, PlayResult, SwapResult } from './results.js'
import { createRun, settledRun, type Run, type RunOwner } from './run.js'
import { runSteps, type StepperHandle, type TimerHandle, type Timers } from './stepper.js'
import type { ViewState } from './view-state.js'

/**
 * # The run controller (§7.1, §7.2, §4.4, §4.5)
 *
 * One controller drives at most one live run for one host. Every ordering rule §7.1 states is a
 * sequence of synchronous calls in this file, and every one of them is asserted at level 1 — no
 * GL, no DOM, no stage. The host is five methods and a clock wide, and P9 supplies it.
 */

/** `'flat'` is pose 0 in every pack, and every crumple ends there. */
const FLAT_POSE_INDEX = 0

/** Everything the runner needs from whoever owns the pixels. P9 implements this on a `View`. */
export interface RunHost {
  /** Optional semantic transaction, separate from the synchronous legacy event bus. */
  batch?<T>(operation: () => T): T
  /** A dirty render may publish resources; ordinary frames avoid a transaction closure. */
  needsRenderBatch?(): boolean
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
  /** Wall time in **milliseconds** for the whole traversal, not a multiplier: the authored dwell
   *  cadence is rescaled into it, so `play('flat', 'ball', { duration: 585 })` finishes at t = 585
   *  (§7.2). Clamped at zero; never negative. A `duration` shorter than the blocking GPU cost is
   *  legal — the run overruns and no pose is skipped. */
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

/**
 * What `crumpleTo` is handed: the incoming payload, or a promise of it. §4.2's loading indicator
 * passes an unresolved `stage.add()` straight through, so the promise arm is the ordinary case
 * and not the exotic one — the view crumples, parks at the ball for as long as the work takes,
 * and uncrumples into whatever arrives.
 *
 * The runner never inspects the payload. `T` is `Sprite` on a real host and the controller is
 * generic in it so P9 does not have to cast in `adopt`.
 *
 * The Error arm is `AddError` and not `Error`: this is exactly what `stage.add()` returns, and
 * naming it here is what lets the run settle to a legal `SwapResult` without a cast at the point
 * of settlement.
 */
export type CrumpleTarget<T> = T | AddError | Aborted | PromiseLike<T | AddError | Aborted>

export interface CrumpleOptions<T> extends PlayOptions {
  /**
   * Called once, at the ball, with the settled non-Error target, **between the pose-5 render and
   * the pose-4 render** (§4.2). That is where the sprite, fit and bucket are exchanged, which is
   * what makes a bucket change across a swap invisible rather than merely well hidden.
   *
   * Returning an Error is treated exactly as a failed target: `error` is emitted at the ball and
   * the run descends on the old sprite. That is not an extra mechanism — it is the same rollback,
   * reached because the exchange itself is the thing that failed.
   */
  adopt?: (value: T) => AddError | undefined
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
  readonly run: Run<PlayResult | SwapResult>
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

export interface RunController<T = unknown> {
  readonly run: Run<PlayResult | SwapResult> | null
  /** The live run's owner, or `null` when the host is idle. §4.4 compares against this. */
  readonly owner: RunOwner | null
  readonly live: boolean
  play(from: PoseRef, to: PoseRef, o?: PlayOptions & { owner?: RunOwner }): Run<PlayResult>
  /**
   * §4.2's `crumpleTo`, and the `swapTo` composed from it. One run: one `start` carrying
   * `via: ball`, one `end`. `from` is the view's current pose, which the view owns and passes.
   */
  crumple(
    from: PoseRef,
    target: CrumpleTarget<T>,
    o?: CrumpleOptions<T> & { owner?: RunOwner },
  ): Run<SwapResult>
  /** §4.5: freezes at the current pose, issues no draw, tears down to `idle`. */
  stop(o?: { owner?: RunOwner; all?: boolean }): void
  /** §4.6: ends a live run with `completed: false`; every later call is refused. */
  dispose(): void
}

export function createRunController<T = unknown>(
  host: RunHost,
  config: RunControllerConfig,
): RunController<T> {
  const dwells = config.dwells ?? DWELL_MS
  const { poseCount } = config
  let current: LiveRun | null = null
  const batch = host.batch ?? (<R>(operation: () => R): R => operation())
  let disposed = false
  /** Up for the whole of `supersede`; `play` and `crumple` refuse to install a run while it is. */
  let superseding = false

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
    batch(() => finishNow(r))
  }

  function finishNow(r: LiveRun): void {
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
    // The sentinel wins over any value the run had already decided on — including the `AddError`
    // a failed `crumpleTo` target parks in `settleValue` before it descends through
    // `crumpling.recover`. §10.5 and amendment 1 make cancellation a *return* and not a failure,
    // and it is the last thing that happened to this run: a caller who called `stop()` should not
    // be handed an Error for the run they themselves cancelled. The target's failure is not lost —
    // it was already reported on the `error` channel at the ball.
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
    // The `end` emitted below reaches the host's listeners synchronously, and a listener may call
    // `play()` from it. On the *completion* path that is the documented looping indicator, and
    // it is safe because `finish` nulls `current` before it emits: the handler's call finds an
    // idle controller and simply installs its run. Here the same call would install a run
    // between this cancel and the caller's own `current = r`, and one of two things has to give.
    // Leave it, and the caller orphans it — its timer ticking, its `finish` a no-op, its `Run`
    // never settling. Cancel it and loop, and a handler that re-plays on every `end` — the
    // looping indicator written without its `completed` check — answers each iteration with a
    // fresh run for the next to cancel: a synchronous loop that never exits. Nothing sits between
    // a handler and this controller to bound that; the bus is synchronous.
    //
    // So the flag goes up before the cancel, exactly as `dispose` raises `disposed` before its
    // own, and `play` / `crumple` refuse the call outright while it is up: `ABORTED` returned,
    // nothing emitted, nothing rendered, and the superseding call wins — the same winner the
    // cancel-and-loop shape produced, minus the run that lived for zero ticks. With no way to
    // install a run from inside it, the loop below is provably single-iteration; it stays a loop
    // so that it can never orphan one.
    superseding = true
    try {
      while (current !== null) cancel(current)
    } finally {
      superseding = false
    }
  }

  // A function, not the inlined `o.signal?.aborted === true` it wraps: `aborted` can flip between
  // two reads of the same option object — that is the whole point of re-checking it after
  // `supersede()` — but TS's narrowing does not know that and, having seen one `=== true` check
  // rule the property out, treats a second textually-identical check on the same reference as
  // unreachable (TS2367). A fresh call each time is a fresh expression, so nothing narrows across
  // calls.
  function signalAborted(signal: AbortSignal | undefined): boolean {
    return signal !== undefined && signal.aborted
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
    if (host.needsRenderBatch?.() === true) batch(() => stepOnceNow(r, step))
    else stepOnceNow(r, step)
  }

  function stepOnceNow(r: LiveRun, step: Step): void {
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
    if (disposed || superseding) return settledRun<PlayResult>(ABORTED)
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
    if (signalAborted(o.signal)) return settledRun<PlayResult>(ABORTED)

    supersede()
    // Both were read on entry, and `supersede` has since emitted `end` synchronously — a handler
    // may have disposed the view or aborted the signal from it. Re-read them: a run installed on
    // a disposed controller can never be torn down again, because `stop` and `dispose` both
    // return at their `disposed` guard, and a signal aborted before `attachSignal` runs would
    // never fire its listener.
    if (disposed || signalAborted(o.signal)) return settledRun<PlayResult>(ABORTED)

    const plan = playPlan(from, to, { duration: o.duration, dwells })
    let record: LiveRun | null = null
    const handle = createRun<PlayResult>(() => {
      if (record !== null) cancel(record)
    })
    const r: LiveRun = {
      run: handle.run,
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
    // `runSteps` fires step 0 synchronously, before it returns the handle — so for the whole of
    // that first step `r.stepper` is still `null` and `detach` has nothing to cancel. A handler
    // that stops or disposes the view from `start` or from that first `step` would otherwise
    // leave the walk running: every remaining pose would render and emit `step` after this run's
    // own `end`, and neither `stop()` nor `dispose()` could reach it again. The guard covers the
    // window; the cancel below closes the timer `fire(0)` armed on its way out.
    const stepper = runSteps({
      timers: host.timers,
      base: r.startedAt,
      steps: plan.steps,
      onStep: (step) => {
        if (current === r) stepOnce(r, step)
      },
      onDone: () => {
        r.reachedTo = true
        finish(r)
      },
    })
    if (current === r) r.stepper = stepper
    else stepper.cancel()
    return handle.run
  }

  function crumple(
    fromRef: PoseRef,
    target: CrumpleTarget<T>,
    o: CrumpleOptions<T> & { owner?: RunOwner } = {},
  ): Run<SwapResult> {
    if (disposed || superseding) return settledRun<SwapResult>(ABORTED)
    const owner = o.owner ?? 'view'
    const from = resolvePose(fromRef, poseCount)
    if (from instanceof Error) return settledRun<SwapResult>(from)
    if (decideCollision(owner, current?.owner ?? null) === 'skip') {
      return settledRun<SwapResult>(ABORTED)
    }
    if (signalAborted(o.signal)) return settledRun<SwapResult>(ABORTED)

    supersede()
    // Both were read on entry, and `supersede` has since emitted `end` synchronously — a handler
    // may have disposed the view or aborted the signal from it. See `play`.
    if (disposed || signalAborted(o.signal)) return settledRun<SwapResult>(ABORTED)

    const ball = ballPose(poseCount)
    const plan = swapPlan(from, { duration: o.duration, dwells })
    let record: LiveRun | null = null
    const handle = createRun<SwapResult>(() => {
      if (record !== null) cancel(record)
    })
    const r: LiveRun = {
      run: handle.run,
      owner,
      from,
      // Every crumple ends flat: `to` is 0 and `via` marks the ball it rose through.
      to: FLAT_POSE_INDEX,
      startedAt: host.timers.now(),
      settle: (value) => {
        handle.settle(value)
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

    // The target is attached now rather than at the ball, so a rejection during the rise is not
    // lost, and so a target that settles early is simply already settled when the hold elapses.
    // A one-member box rather than a value plus a flag: a `const` copy of it inside
    // `leaveBallIfReady` narrows cleanly, where a captured `let` does not.
    let outcome: { readonly value: T | AddError | Aborted } | null = null
    const onTargetSettled = (value: T | AddError | Aborted): void => {
      outcome = { value }
      leaveBallIfReady(r, plan)
    }
    Promise.resolve<T | AddError | Aborted>(target).then(onTargetSettled, (reason: unknown) => {
      // §10.8: a failing promise resolves to an Error rather than rejecting, so a rejection is a
      // contract violation by whoever supplied the target. `AssetError` is the member of
      // `AddError` that says "the thing you asked me to load did not arrive", and the original is
      // kept as the cause.
      onTargetSettled(
        new AssetError({
          message: 'the crumpleTo target rejected; a paper-crumple promise resolves to an Error',
          cause: reason,
        }),
      )
    })

    let leftBall = false
    let holdElapsed = false

    function leaveBallIfReady(run: LiveRun, swap: SwapPlan): void {
      batch(() => leaveBall(run, swap))
    }

    function leaveBall(run: LiveRun, swap: SwapPlan): void {
      const settled = outcome
      if (current !== run || leftBall || !holdElapsed || settled === null) return
      leftBall = true
      if (run.parkTimer !== null) {
        host.timers.clearTimeoutFn(run.parkTimer)
        run.parkTimer = null
      }
      const { value } = settled
      if (isAborted(value)) {
        // Cancellation is not a failure: nothing is emitted on `error`, and §4.5's "a cancel path
        // must not render" means the view freezes at the ball rather than descending.
        cancel(run)
        return
      }
      // Two casts, both forced by `T` being unconstrained: `instanceof Error` cannot narrow to
      // `AddError` through it, and the residue after the two guards cannot be narrowed to `T`.
      // The declared `CrumpleTarget<T>` is what makes both sound.
      const failure: AddError | undefined =
        value instanceof Error ? (value as AddError) : o.adopt?.(value as T)
      if (failure !== undefined) {
        run.errored = true
        run.settleValue = failure
        host.reportError(failure)
        host.setState('crumpling.recover')
      } else {
        host.setState('crumpling.fall')
      }
      // The deadline is re-based on leaving the ball, so a stall does not become debt the descent
      // tries to catch up on (§7.2).
      const fallStepper = runSteps({
        timers: host.timers,
        base: host.timers.now(),
        steps: swap.fall.steps,
        onStep: (step) => {
          if (current === run) stepOnce(run, step)
        },
        onDone: () => {
          run.reachedTo = true
          finish(run)
        },
      })
      if (current === run) run.stepper = fallStepper
      else fallStepper.cancel()
    }

    host.setState(plan.rise.steps.length > 1 ? 'crumpling.rise' : 'crumpling.ball')
    host.emit('start', startPayload(from, FLAT_POSE_INDEX, o.duration, ball))
    // Mirrors `play`'s guard: `runSteps` fires step 0 synchronously, before `r.stepper` would be
    // assigned, so a handler tearing the run down from that first step must be caught here too.
    const riseStepper = runSteps({
      timers: host.timers,
      base: r.startedAt,
      steps: plan.rise.steps,
      onStep: (step) => {
        if (current === r) stepOnce(r, step)
      },
      onDone: () => {
        batch(() => {
          if (current !== r) return
          // A run that began at the ball entered `crumpling.ball` before its `start`, so it is
          // already there; re-announcing it would make an observer see the state twice.
          if (plan.rise.steps.length > 1) host.setState('crumpling.ball')
          // **Park time is never rescaled**: the hold is `max(scaledBallDwell, timeUntilSettled)`,
          // and the excess sits entirely at the ball. There is no built-in park timeout; a caller
          // who needs one passes `signal`.
          r.parkTimer = host.timers.setTimeoutFn(() => {
            r.parkTimer = null
            holdElapsed = true
            leaveBallIfReady(r, plan)
          }, plan.hold)
        })
      },
    })
    if (current === r) r.stepper = riseStepper
    else riseStepper.cancel()
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
    // Set before the teardown, not after. `dispose()` re-entered from the `end` emitted below
    // must find the controller already disposed and return at the guard above, or the state is
    // announced twice; and a `play()` from that same handler is refused rather than installed
    // and then immediately cancelled. That also makes the loop below provably single-iteration.
    disposed = true
    // The `end` is emitted at `idle`, under the same teardown-before-`end` rule as every other
    // ending, and the view is marked `disposed` after it. The loop mirrors `supersede`'s.
    while (current !== null) cancel(current)
    host.setState('disposed')
  }

  return {
    get run() {
      return current?.run ?? null
    },
    get owner() {
      return current?.owner ?? null
    },
    get live() {
      return current !== null
    },
    play: (from, to, o) => batch(() => play(from, to, o)),
    crumple: (from, target, o) => batch(() => crumple(from, target, o)),
    stop: (o) => batch(() => stop(o)),
    dispose: () => batch(dispose),
  }
}
