/**
 * Which baked sheet a sprite gets, and how it is stretched onto the paper's bounding box
 * (spec 5.3, 9.3).
 *
 * The three buckets are fixed at bake time and the nearest one is chosen in log-aspect, so 0.8 is
 * as far from 1 as 1.25 is. Inside the clamp the sheet is stretched non-uniformly onto the bbox.
 * Past it there is no better bucket — the nearest one is already the nearest — so the stretch is
 * clamped and the sheet is then scaled up **uniformly until it covers** the bbox: a sheet
 * narrower than the paper would cut the sprite, a sheet wider than it only adds transparent
 * margin. `clamped` is reported so a caller can say the creases are the other bucket's.
 *
 * The boundaries sit at sqrt(2/3) = 0.81650 and sqrt(1.5) = 1.22474, and the stretch a boundary
 * demands is 0.81650 / 0.66667 = 1.22474 — which **exceeds** the 1.2 clamp rather than nearly
 * reaching it. The uniform cover-scale is what absorbs that residual.
 */
import { MotionError } from '@paper-crumple/core'

/** One baked aspect. */
export interface Bucket {
  readonly id: string
  readonly aspect: number
}

/** The three aspect buckets spec 9.3 bakes in. One export subpath of this package per entry. */
export const BUCKETS: readonly Bucket[] = Object.freeze([
  Object.freeze({ id: '2x3', aspect: 2 / 3 }),
  Object.freeze({ id: '1x1', aspect: 1 }),
  Object.freeze({ id: '3x2', aspect: 3 / 2 }),
])

/**
 * The non-uniform stretch limit. The reciprocal is always written `1 / MAX_STRETCH`: spelling it
 * `0.8` gives a visibly different fit near the 2x3 boundary (spec 9.3).
 */
export const MAX_STRETCH = 1.2

/**
 * A tolerance and not `!==`: at the boundary `raw` equals `MAX_STRETCH` only up to float error —
 * `0.8 / (2 / 3)` is `1.2000000000000002` — which would otherwise read as clamped when it is exact.
 */
export const STRETCH_TOLERANCE = 1e-9

/** The nearest bucket in log-aspect. */
export function pickBucket(aspect: number): InstanceType<typeof MotionError> | Bucket {
  if (!Number.isFinite(aspect) || aspect <= 0) {
    return new MotionError(`pickBucket: aspect ${String(aspect)} is not a positive finite ratio`)
  }
  let best = BUCKETS[0]!
  let bestD = Infinity
  for (const b of BUCKETS) {
    const d = Math.abs(Math.log(aspect / b.aspect))
    if (d < bestD) {
      best = b
      bestD = d
    }
  }
  return best
}

/** The geometry of a fit. P11 composes a `MotionFit` out of it. */
export interface SheetFit {
  readonly bucket: string
  /** The bbox aspect, `w / h`. Not the bucket's. */
  readonly aspect: number
  readonly stretch: number
  readonly clamped: boolean
  readonly sheetW: number
  readonly sheetH: number
}

/**
 * @param bboxW paper bbox width, in px
 * @param bboxH paper bbox height, in px
 * @param override a bucket id to use instead of the nearest one
 */
export function fitSheet(
  bboxW: number,
  bboxH: number,
  override: string | null = null,
): InstanceType<typeof MotionError> | SheetFit {
  if (!(bboxW > 0) || !(bboxH > 0) || !Number.isFinite(bboxW) || !Number.isFinite(bboxH)) {
    return new MotionError(`fitSheet: degenerate bbox ${String(bboxW)}x${String(bboxH)}`)
  }
  const aspect = bboxW / bboxH
  let bucket: Bucket
  if (override === null) {
    const picked = pickBucket(aspect)
    if (MotionError.is(picked)) return picked
    bucket = picked
  } else {
    const found = BUCKETS.find((b) => b.id === override)
    if (found === undefined) {
      const known = BUCKETS.map((b) => b.id).join(', ')
      return new MotionError(`fitSheet: unknown bucket "${override}"; this family bakes ${known}`)
    }
    bucket = found
  }
  const raw = aspect / bucket.aspect
  const stretch = Math.min(MAX_STRETCH, Math.max(1 / MAX_STRETCH, raw))
  const clamped = Math.abs(stretch - raw) > STRETCH_TOLERANCE
  let sheetH = bboxH
  let sheetW = bboxH * bucket.aspect * stretch
  if (sheetW < bboxW) {
    // The uniform cover-scale: it absorbs whatever the clamp refused to stretch.
    const k = bboxW / sheetW
    sheetW = bboxW
    sheetH *= k
  }
  return { bucket: bucket.id, aspect, stretch, clamped, sheetW, sheetH }
}
