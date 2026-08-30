import { PoseError } from './errors.js'
import type { PoseRef } from './pose.js'

/**
 * # The dwell arithmetic (§7.2)
 *
 * The scheduler renders pose *i*, waits `DWELL_MS[i]`, renders the next, and **never waits after
 * the last pose**: N poses, N−1 gaps.
 *
 * **The trap this file exists to prevent is not an off-by-one index window.** `[1..5]` against
 * `[0..4]` is 490 against 495, a 1 % error. It is *including the trailing dwell*: computing a
 * traversal as `sum(DWELL_MS) = 585` when only 495 is spent, which is 15.4 % and reads as audio
 * drift. The rule that prevents it, and the reason every function here excludes `to`: the rescale
 * basis is the sum over the traversed poses.
 *
 * Everything below works in **resolved integer indices**. `PoseRef` is an input type (amendment
 * 21) and `resolvePose` is the single boundary where it stops being one.
 */

/** The authored cadence. Sum 585; a traversal never spends all of it. */
export const DWELL_MS: readonly number[] = Object.freeze([95, 70, 120, 75, 135, 90])

/** `'flat'` is pose 0 in every pack. */
export const FLAT_POSE = 0

/**
 * `'ball'` is the last pose of the pack in hand. It is `5` for the built-in packs and something
 * in the middle of an eight-pose custom one, which is exactly why amendment 21 makes the named
 * form canonical and demotes raw indices to a documented escape hatch stated next to `poseCount`.
 */
export function ballPose(poseCount: number): number {
  return poseCount - 1
}

/**
 * The one boundary where a `PoseRef` becomes an index (amendment 21). Everything downstream — the
 * plans, the stepper, `start.from` / `start.to` / `start.via`, `step.pose`, `end.from` / `end.to`
 * and P9's `view.pose` — is a `number`, because a handler forced to switch on
 * `'flat' | 'ball' | number` is worse off than one reading an index.
 *
 * Raw indices are the escape hatch for custom packs, and §10.1 calls them the likeliest runtime
 * error in the API — so this returns a `PoseError` rather than clamping. A non-integer is refused
 * for a second reason: a traversal steps by ±1 and would never reach a fractional `to`.
 */
export function resolvePose(
  ref: PoseRef,
  poseCount: number,
): number | InstanceType<typeof PoseError> {
  if (!Number.isInteger(poseCount) || poseCount < 1) {
    return new PoseError(`a pack with ${String(poseCount)} poses has no pose to resolve against`)
  }
  if (ref === 'flat') return FLAT_POSE
  if (ref === 'ball') return ballPose(poseCount)
  if (!Number.isInteger(ref)) {
    return new PoseError(
      `pose ${String(ref)} is not an integer; poses are 'flat', 'ball', or an index 0 … ${poseCount - 1}`,
    )
  }
  if (ref < 0 || ref >= poseCount) {
    return new PoseError(
      `pose ${ref} is out of range for a ${poseCount}-pose pack: 0 … ${poseCount - 1}`,
    )
  }
  return ref
}

/**
 * The poses a run renders, inclusive of both ends. Both arguments are resolved indices; the
 * integer guard is a cheap defence against a caller that skipped `resolvePose`, since a
 * fractional bound would otherwise loop forever.
 */
export function traversal(from: number, to: number): readonly number[] {
  if (!Number.isInteger(from) || !Number.isInteger(to)) return [from]
  const direction = to >= from ? 1 : -1
  const poses: number[] = []
  for (let p = from; ; p += direction) {
    poses.push(p)
    if (p === to) break
  }
  return poses
}

/**
 * The authored wall time of a traversal: the dwell of every traversed pose **excluding `to`**.
 * This is the rescale basis, and excluding `to` is the whole of the 15 % rule.
 */
export function authoredTotal(
  from: number,
  to: number,
  dwells: readonly number[] = DWELL_MS,
): number {
  const poses = traversal(from, to)
  let total = 0
  for (let i = 0; i < poses.length - 1; i += 1) total += dwells[poses[i]]
  return total
}

/** One scheduled render, and the gap that follows it. */
export interface Step {
  readonly pose: number
  /** The scaled gap that follows this render, in ms. `0` on the last step: no trailing dwell. */
  readonly gap: number
  /** This render's offset from the leg's base, in ms. `steps[0].offset` is always `0`. */
  readonly offset: number
}

export interface Plan {
  readonly steps: readonly Step[]
  /** `steps[last].offset` — what the leg costs when nothing has to be waited for. */
  readonly total: number
}

export interface PlanOptions {
  /**
   * One multiplier over the whole run, `duration / authoredTotal(from, to)`, applied to the
   * traversed entries only, so the hand-made uneven cadence survives exactly. A `duration`
   * shorter than the blocking GPU cost is legal: §7.2 says the run overruns and no pose is
   * skipped, which the absolute-deadline stepper gives for free.
   */
  duration?: number
  /** Defaults to `DWELL_MS`. A custom pack supplies its own table; `poseCount` is its length. */
  dwells?: readonly number[]
}

/**
 * Offsets are computed as `(duration * cumulative) / authored` rather than as
 * `(duration / authored) * cumulative`. The two are the same in exact arithmetic and only the
 * first is exact in IEEE for integer inputs: §11's named assertion that
 * `play('flat', 'ball', { duration: 585 })` finishes at t=585 rather than t=495 is an equality,
 * and `(585 * 495) / 495` is exactly 585 where `(585 / 495) * 495` is not guaranteed to be.
 */
export function playPlan(from: number, to: number, o: PlanOptions = {}): Plan {
  const dwells = o.dwells ?? DWELL_MS
  const poses = traversal(from, to)
  const cumulative: number[] = [0]
  for (let i = 0; i < poses.length - 1; i += 1) {
    cumulative.push(cumulative[i] + dwells[poses[i]])
  }
  const authored = cumulative[cumulative.length - 1]
  const duration = o.duration === undefined ? undefined : Math.max(0, o.duration)
  const offsets =
    duration === undefined || authored === 0
      ? cumulative
      : cumulative.map((c) => (duration * c) / authored)
  const steps: Step[] = poses.map((pose, i) => ({
    pose,
    offset: offsets[i],
    gap: i === poses.length - 1 ? 0 : offsets[i + 1] - offsets[i],
  }))
  return { steps, total: offsets[offsets.length - 1] }
}

/**
 * The rescale basis for a swap: the rise's gaps, plus the ball's own dwell as the hold, plus the
 * fall's gaps. Ten gaps from pose 0.
 */
export function authoredSwapTotal(from: number, dwells: readonly number[] = DWELL_MS): number {
  const ball = dwells.length - 1
  const start = Math.min(Math.max(Math.trunc(from), 0), ball)
  const rise = authoredTotal(start, ball, dwells)
  const fall = ball >= 1 ? authoredTotal(ball - 1, 0, dwells) : 0
  return rise + dwells[ball] + fall
}

/**
 * The swap, from pose *p*: `DWELL_MS[p..4]`, then `DWELL_MS[5]` as the ball hold, then
 * `DWELL_MS[4..1]` — ten gaps across eleven renders from pose 0.
 *
 * Three legs rather than one plan, because the middle one is not a gap the stepper walks. **Park
 * time is never rescaled**: the actual park is `max(hold, timeUntilSettled)`, the excess sits
 * entirely at the ball, and the deadline is re-based on leaving the ball so a stall does not
 * become debt the descent tries to catch up on. `fall.steps[0].offset` is therefore `0`: the
 * fall's offsets are relative to the moment the ball is left, not to the run's start.
 *
 * Pose 5 is rendered exactly once, by the outgoing sprite — the sprite, fit and bucket are
 * swapped *between* the pose-5 render and the pose-4 render (§4.2), which is what makes a bucket
 * change across a swap invisible rather than merely well hidden. From the ball there is no rise:
 * §7.1's "a run always renders its `from` pose" gives the single pose-5 render, and §7.2's "no
 * extra pose-5 render" is the rule that there is not a second one.
 */
export interface SwapPlan {
  /** Renders `from … ball`. Its last gap is `0`; the hold is separate. */
  readonly rise: Plan
  /** The scaled ball dwell — the **floor** of the park, not the park. */
  readonly hold: number
  /** Renders `ball−1 … 0`, offsets re-based on leaving the ball. */
  readonly fall: Plan
  /** `rise.total + hold + fall.total` — what the swap costs when nothing has to be waited for. */
  readonly total: number
}

export function swapPlan(from: number, o: PlanOptions = {}): SwapPlan {
  const dwells = o.dwells ?? DWELL_MS
  const ball = dwells.length - 1
  const start = Math.min(Math.max(Math.trunc(from), 0), ball)
  const authored = authoredSwapTotal(start, dwells)
  const duration = o.duration === undefined ? undefined : Math.max(0, o.duration)
  // One multiplier over all ten gaps, the ball dwell included. Each leg is then re-planned with
  // its own share of the duration, which keeps `playPlan`'s exact-offset arithmetic intact
  // per leg rather than re-deriving it here.
  const share = (legAuthored: number): number | undefined =>
    duration === undefined || authored === 0 ? undefined : (duration * legAuthored) / authored

  const riseAuthored = authoredTotal(start, ball, dwells)
  const rise = playPlan(start, ball, { dwells, duration: share(riseAuthored) })

  const fallAuthored = ball >= 1 ? authoredTotal(ball - 1, 0, dwells) : 0
  const fall =
    ball >= 1
      ? playPlan(ball - 1, 0, { dwells, duration: share(fallAuthored) })
      : { steps: [{ pose: 0, gap: 0, offset: 0 }], total: 0 }

  const scaledHold = share(dwells[ball]) ?? dwells[ball]
  // `total` is `duration` verbatim when one was given, rather than the sum of three separately
  // rounded legs. It is a documentation figure — the stepper never reads it — and stating it
  // exactly is what makes `swapPlan(0, { duration: 985 }).total === 985` an equality.
  return {
    rise,
    hold: scaledHold,
    fall,
    total: duration ?? rise.total + scaledHold + fall.total,
  }
}
