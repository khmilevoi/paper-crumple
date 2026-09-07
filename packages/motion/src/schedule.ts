/**
 * A pose schedule a consumer edits at runtime (§7.2, §9.1): which stored frame each pose shows,
 * and how long a run dwells on it. The manifest bakes one in; `bakedMotion().setPoses` plays
 * another without a re-bake. The rules are the parser's own — `setKeyFrames` validates the key
 * frames here exactly as it does at parse time — plus one the manifest never needed: a dwell per
 * pose, so `RunControllerConfig`'s precondition (`poseCount === dwells.length`) holds by
 * construction rather than by convention.
 */
import { DWELL_MS, PackError } from '@paper-crumple/core'

import { setKeyFrames } from './pack.js'

/** A resolved schedule: what `bakedMotion().poses` reports and what every clip then plays. */
export interface PoseSchedule {
  /** Pose index to **stored-slot** index; pose 0 is slot 0 and the list never decreases. */
  readonly keyFrames: readonly number[]
  /** One dwell per pose, `keyFrames.length` long (§7.2). The last entry is the ball hold. */
  readonly dwells: readonly number[]
}

/** What `setPoses` and `resolveSchedule` take. */
export interface PoseScheduleInput {
  readonly keyFrames: readonly number[]
  /** Defaults to `dwellsFor(keyFrames.length)`. */
  readonly dwells?: readonly number[]
}

const AUTHORED_POSES = DWELL_MS.length

function positiveInteger(name: string, value: number): InstanceType<typeof PackError> | undefined {
  if (!Number.isInteger(value) || value < 1) {
    return new PackError(`${name}: expected a positive integer, got ${String(value)}`)
  }
  return undefined
}

/**
 * A dwell table for `poseCount` poses. Six poses is the authored cadence itself — the very
 * `DWELL_MS` array, so a six-pose schedule runs exactly as a built-in pack does. Any other count
 * resamples the cadence linearly over the pose axis: the first entry stays the flat pose's 95 ms
 * and the last stays the ball's 90 ms hold, and the uneven stop-motion rhythm between them keeps
 * its shape rather than collapsing to a flat average. A single pose is all ball: its one entry is
 * the hold. A consumer with a real table passes it to `resolveSchedule` instead.
 */
export function dwellsFor(poseCount: number): InstanceType<typeof PackError> | readonly number[] {
  const refused = positiveInteger('dwells: pose count', poseCount)
  if (refused !== undefined) return refused
  if (poseCount === AUTHORED_POSES) return DWELL_MS
  const last = AUTHORED_POSES - 1
  if (poseCount === 1) return Object.freeze([DWELL_MS[last]])
  const out: number[] = []
  for (let i = 0; i < poseCount; i++) {
    const x = (i * last) / (poseCount - 1)
    const lo = Math.min(Math.floor(x), last)
    const hi = Math.min(lo + 1, last)
    out.push(Math.round(DWELL_MS[lo] + (DWELL_MS[hi] - DWELL_MS[lo]) * (x - lo)))
  }
  return Object.freeze(out)
}

/**
 * Key frames spread evenly over the stored frames: pose *i* of `poseCount` shows slot
 * `round(i × (frameCount − 1) / (poseCount − 1))`, so pose 0 is slot 0, the last pose is the last
 * slot, and the list never decreases — valid under `setKeyFrames` by construction, for any pair
 * of counts. One pose is just the flat sheet; more poses than frames repeat slots.
 */
export function evenKeyFrames(
  poseCount: number,
  frameCount: number,
): InstanceType<typeof PackError> | readonly number[] {
  const badPoses = positiveInteger('keyFrames: pose count', poseCount)
  if (badPoses !== undefined) return badPoses
  const badFrames = positiveInteger('keyFrames: frame count', frameCount)
  if (badFrames !== undefined) return badFrames
  if (poseCount === 1) return Object.freeze([0])
  const out: number[] = []
  for (let i = 0; i < poseCount; i++) {
    out.push(Math.round((i * (frameCount - 1)) / (poseCount - 1)))
  }
  return Object.freeze(out)
}

function checkDwells(
  list: readonly number[],
  poseCount: number,
): InstanceType<typeof PackError> | readonly number[] {
  if (list.length !== poseCount) {
    return new PackError(
      `dwells: ${list.length} entries for ${poseCount} poses; the schedule and the key frames must agree`,
    )
  }
  for (const [i, d] of list.entries()) {
    if (typeof d !== 'number' || !Number.isFinite(d) || d < 0) {
      return new PackError(
        `dwells: entry ${i} is ${String(d)}, not a non-negative number of milliseconds`,
      )
    }
  }
  return Object.freeze(list.slice())
}

/**
 * Validates an input against a pack of `frameCount` stored frames and fills in the dwells. Pure,
 * and frozen on the way out: the schedule is shared by every clip that reads it.
 */
export function resolveSchedule(
  input: PoseScheduleInput,
  frameCount: number,
): InstanceType<typeof PackError> | PoseSchedule {
  const keyFrames = setKeyFrames(input.keyFrames, frameCount)
  if (PackError.is(keyFrames)) return keyFrames
  const dwells =
    input.dwells === undefined
      ? dwellsFor(keyFrames.length)
      : checkDwells(input.dwells, keyFrames.length)
  if (PackError.is(dwells)) return dwells
  return Object.freeze({ keyFrames, dwells })
}
