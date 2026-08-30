/** Resolution arithmetic (spec 7.4 and 7.4.3). Pure integer, no GL, no allocation. */

/**
 * Every *bucket* front size and every `sdfRes` is a multiple of this; the `exact` front (§7.4.3)
 * is not.
 */
export const SIZE_QUANTUM = 64

/** Floor of `sdfResFor` (spec 7.4.3). */
export const SDF_RES_MIN = 128

/** Ceiling of `sdfResFor` (spec 7.4.3). */
export const SDF_RES_MAX = 512

export interface DisplaySizeRequest {
  /** The sprite's CSS-pixel footprint on the long side. */
  readonly cssPx: number
  /**
   * The device pixel ratio to render for. Explicit rather than read from `devicePixelRatio`,
   * because the consumer may be rendering for a different screen than the one it is running on.
   */
  readonly dpr: number
  /** The upper bound on the front's long side — the stage's or the sprite's `maxSize`. */
  readonly cap: number
}

/**
 * The front's long side for a given display footprint (spec 7.4): `cssPx x dpr` rounded up to the
 * next multiple of 64, clamped to `cap`.
 *
 * The result is always a multiple of 64 and never below 64. Spec 8.6's buckets and spec 7.4.3's
 * `sdfRes` both assume a multiple of 64, so a `cap` that is not one is rounded **down** — a cap
 * is a ceiling, and rounding it up would raise it. A zero-texel front is not allocatable. A
 * non-finite `cssPx` or `dpr` falls back to the floor rather than propagating as `NaN`.
 */
export function sizeForDisplay(o: DisplaySizeRequest): number {
  const capped = Math.max(SIZE_QUANTUM, Math.floor((o.cap || 0) / SIZE_QUANTUM) * SIZE_QUANTUM)
  const wanted = SIZE_QUANTUM * Math.ceil((Math.max(0, o.cssPx * o.dpr) || 0) / SIZE_QUANTUM)
  return Math.min(capped, Math.max(SIZE_QUANTUM, wanted))
}

/**
 * The jump-flood field resolution (spec 7.4.3), measured on the **front's long side** rather than
 * on `maxSize`, and always a multiple of 64:
 *
 * ```
 * sdfRes = clamp(64 · ceil(L / 128), 128, 512)
 * ```
 *
 * The original's `clamp(maxSize / 2, 128, 512)` is deleted. This form reproduces the old values at
 * every grid size and gives the spike's validated 998 -> 512 pair under `exact: true`, which the
 * old formula computed as 499 while leaving `exact` undefined entirely. A non-finite
 * `frontLongSide` falls back to the floor rather than propagating as `NaN`.
 */
export function sdfResFor(frontLongSide: number): number {
  const raw = SIZE_QUANTUM * Math.ceil((Math.max(0, frontLongSide) || 0) / 128)
  return Math.min(SDF_RES_MAX, Math.max(SDF_RES_MIN, raw))
}
