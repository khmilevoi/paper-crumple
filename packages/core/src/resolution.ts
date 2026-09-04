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

/**
 * The cap on a front's long side, in texels — and therefore on the owned surface's side. 2048 is
 * WebGL2's guaranteed `MAX_TEXTURE_SIZE` floor, so no `caps` check is needed for a front the
 * stage derives; a consumer passing `maxSize` above it must consult `stage.caps.maxTextureSize`.
 * This is NOT a cap on CSS pixels: `sizeForDisplay` applies it after `cssPx x dpr`.
 */
export const FRONT_LONG_SIDE_CAP = 2048

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

export interface FrontCapRequest {
  /** The artwork's wanted long side, in texels — `ceil(artworkCssPx x dpr)`. */
  readonly artworkLongSide: number
  /** The sheet's reserve, `SheetRenderer.overscan`: a front's long side is at most
   *  `artworkLongSide + 2 x ceil(overscan x artworkLongSide)` for every aspect. */
  readonly overscan: number
  readonly cap: number
}

/**
 * The front cap — the owned surface's side — that lets every sprite carry `artworkLongSide`
 * artwork texels: `artworkLongSide + 2 x ceil(overscan x artworkLongSide)`, matching the sheet's
 * own per-axis margin (`frontForArtwork` in `paper/src/handle.ts`) texel for texel, rounded up to
 * a multiple of 64 and clamped to `cap`, through `sizeForDisplay` at `dpr` 1 so the two share one
 * quantisation. A non-finite `overscan` (a sheet whose reserve could not be derived; its
 * `mount()` refuses) is read as "reserve everything" and lands on `cap`, never on the floor.
 */
export function frontCapFor(o: FrontCapRequest): number {
  const p = Number.isFinite(o.overscan) ? Math.max(0, o.overscan) : Number.POSITIVE_INFINITY
  const a = Math.max(0, o.artworkLongSide)
  // Not `ceil(A * (1 + 2p))`: the sheet's own margin is `ceil(p * A)` texels on EACH side
  // (`frontForArtwork` in `paper/src/handle.ts`), so the front it actually needs is
  // `A + 2 * ceil(p * A)`. `2 * ceil(x) - ceil(2x)` can be 1, and rounding up to a multiple of
  // 64 does not always absorb that texel, so the closed form under-requests by one texel for
  // roughly 1% of `A` values (e.g. `p = 105/790`, `A = 151`: 192 vs the needed 193 -> 256).
  const wanted = a + 2 * Math.ceil(p * a)
  return sizeForDisplay({ cssPx: wanted, dpr: 1, cap: o.cap })
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
