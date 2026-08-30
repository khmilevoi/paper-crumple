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
