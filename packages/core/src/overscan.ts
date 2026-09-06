/**
 * Derived overscan and the guard-band check (spec 8.6).
 *
 * The spikes hard-code `PAD_FRACTION = 0.28` in two places, sized for a configuration this library
 * does not build: `torn` with all folds and the drop shadow enabled. The library's front is pose 0,
 * no folds, shadow off, and its default edge mode is `hull`, which needs no tear, no teeth and no
 * fibre - only `maxDist`. The three largest consumers of that margin do not exist in the front
 * texture at all, so the constant becomes this one derivation instead.
 */
import { KnobError, SheetError } from './errors.js'
import type { Rect, Size } from './geometry.js'
import { KNOB_REFERENCE_PX } from './knobs.js'

// Every bounded edge knob is quoted against this frame (`paper.js:39`). ONE declaration, in
// `./knobs.ts` beside `scaleKnob`, which is the module that defines what the frame means;
// re-exported here so `unstable.ts`'s P5 block keeps its shape and every consumer that reached for
// it through this module still gets the same binding rather than a second constant of equal value.
export { KNOB_REFERENCE_PX }

/**
 * The fixed slop for the JFA half-texel and antialiasing, in reference pixels. Spec 8.6 gives
 * "8-12"; this is the conservative end, because under-reserving produces a straight flat slice of
 * the scrap parallel to the texture edge - a bug class - while over-reserving costs a handful of
 * artwork texels.
 */
export const EDGE_SLOP_REFERENCE_PX = 12

/** Where `paper.js:319-322`'s hard cut begins, in centred normalised texture coordinates. */
export const GUARD_BAND_INNER = 0.482

/** Where it is complete: the field has collapsed to -1e4 by here. */
export const GUARD_BAND_OUTER = 0.5

/**
 * The band's own width, as a fraction of the texture: `0.5 - 0.482`. Never write `0.018`.
 * design 2026-09-05 §4.2.
 */
export const GUARD_MARGIN_G = GUARD_BAND_OUTER - GUARD_BAND_INNER

/**
 * Insurance on top of the closed form, stated as ε reference px out of the
 * `KNOB_REFERENCE_PX` (1000 px) reference frame — but `guardMarginsFor` applies it as
 * `A.h · ε / KNOB_REFERENCE_PX` TEXELS (a fraction of the artwork's height), not as a flat
 * `ε`-texel reserve, so it comes out to well under 2 texels at realistic artwork sizes (≈1.5 at
 * the hull defaults, `A.h ≈ 790`).
 *
 * **It is load-bearing on the x axis, and not on the y axis.** On y the derivation is exact and
 * every rounding in the pipeline (`reachRect`'s `+0.5`, the inclusive `signedFieldExtent` box, the
 * `ceil` below) runs in the check's favour, so ε is pure insurance there. On x it is not: the x
 * closed form in `guardMarginsFor` takes the paint reach as `A.h · p / Q`, i.e. evaluated at the
 * IDEAL `m_y`, while the front the pipeline actually builds is taller than that — the y margin is
 * `ceil(A.h · (m_y/A.h + ε/1000))`, so the real front carries up to `2 (A.h·ε/1000 + 1)` texels of
 * height the closed form did not price, and the real paint reach `p · F.h` grows with it. The
 * `A.h · ε / KNOB_REFERENCE_PX` term on the x line is what pays for that: it has to cover
 * `2p (A.h·ε/1000 + 1) / (1 - 2g)`, which at any realistic `p` is a fraction of the term itself.
 * The shortfall it covers is under one texel and only bites on small artwork, where the `ceil`'s
 * own `+1` dominates — so the code is right as written, but ε cannot be dropped to zero on the
 * strength of the y-axis argument alone. Design §11's fourth measurement is that question, and this
 * is half its answer.
 *
 * Frozen at 2 by controller ruling R1 for the whole branch — a second reason to leave it alone:
 * changing it after Task 8 would invalidate the committed `hull-default.json` golden frame, which
 * cannot be recaptured once `develop`'s `edgeMode` is gone.
 */
export const GUARD_EPSILON_REFERENCE_PX = 2

/**
 * Where the guard margin diverges: `1 - 2g - 2R/1000 = 0`. Past it no front is large enough to
 * hold the reserve outside the band, so `overscanFromRadius` refuses here rather than at 500.
 */
export const RADIUS_CAP_REFERENCE_PX = KNOB_REFERENCE_PX * (GUARD_BAND_OUTER - GUARD_MARGIN_G)

/** design 2026-09-05 §4.1's single radius. Every term is reference px unless noted. */
export interface EdgeParams {
  /** `W` — the contour's own width, design §3. */
  readonly widthRef: number
  /** `v` — `edgeVariance`, 0..1. */
  readonly variance: number
  /** `0` under finish `'clean'`; the margin reserves four of them. */
  readonly fiberLen: number
  /** `0` under finish `'clean'`. */
  readonly deckleWidth: number
  readonly slop?: number
}

/**
 * `r = W (1 + v) + 4 fiberLen + deckleWidth + e`.
 *
 * `ASPECT_BOUND` and the `0.45 * sigma` blur lead are gone with `looseness`'s contribution to the
 * width (design §6.1 item 2 zeroes `uLoosePush` in every cell), and `thickness` is gone because it
 * has BECOME `W` (§2.3). What is left is the honest outward reach: the band's far edge, plus the
 * two finish decorations that draw past it.
 */
export function overscanRadius(p: EdgeParams): number {
  const slop = p.slop ?? EDGE_SLOP_REFERENCE_PX
  return p.widthRef * (1 + p.variance) + 4 * p.fiberLen + p.deckleWidth + slop
}

/**
 * `p = r / (1000 - 2r)`, the reserved radius expressed as a fraction of the artwork's long side.
 *
 * At `r >= RADIUS_CAP_REFERENCE_PX` (482, design 2026-09-05 §4.2 — narrowed from the pre-§4.2
 * 500, a documented breaking change per ruling R2) the guard margin diverges and the reserve
 * leaves no artwork outside the shader's guard band inside the reference frame. Spec 8.6 forbids
 * a silent clamp and spec 10.8 forbids a throw, so it returns.
 */
export function overscanFromRadius(r: number): InstanceType<typeof KnobError> | number {
  if (!Number.isFinite(r) || r < 0 || r >= RADIUS_CAP_REFERENCE_PX) {
    return new KnobError(
      `edge parameters reserve ${r} reference px per side as the reserve radius, at or past the ` +
        `${RADIUS_CAP_REFERENCE_PX} px cap (design 2026-09-05 §4.2, R2) where the guard margin ` +
        `diverges and leaves no artwork outside the shader's guard band inside the ` +
        `${KNOB_REFERENCE_PX} px reference frame - re-add required with smaller edge knobs`,
    )
  }
  return r / (KNOB_REFERENCE_PX - 2 * r)
}

/**
 * The TOTAL per-side margin on the front's height axis, as a fraction of the artwork's height —
 * paint plus guard, `epsilon` NOT included. design 2026-09-05 §4.2's y-axis solve:
 * `m_y / A.h = (p(1 + 2g) + g) / Q`, `Q = 1 - 2g(1 + 2p)`.
 */
export function marginFractionFor(overscan: number): number {
  const p = Math.max(0, overscan)
  const g = GUARD_MARGIN_G
  return (p * (1 + 2 * g) + g) / (1 - 2 * g * (1 + 2 * p))
}

/**
 * The TOTAL per-side margin in texels on each axis. `y` carries the self-referential solve; `x`
 * follows from it, because the paint reach is isotropic in texels but quoted against the front's
 * HEIGHT, while `axisIntrusion` is relative to each axis's own dimension.
 */
export function guardMarginsFor(o: { readonly artwork: Size; readonly overscan: number }): {
  readonly x: number
  readonly y: number
} {
  const p = Math.max(0, o.overscan)
  const g = GUARD_MARGIN_G
  const eps = GUARD_EPSILON_REFERENCE_PX / KNOB_REFERENCE_PX
  const q = 1 - 2 * g * (1 + 2 * p)
  const y = Math.ceil(o.artwork.h * (marginFractionFor(p) + eps))
  const x = Math.ceil((g * o.artwork.w + (o.artwork.h * p) / q) / (1 - 2 * g) + o.artwork.h * eps)
  return { x, y }
}

/**
 * The sprite's derived overscan, frozen at `add()` and constant for the sprite's life (spec 8.6).
 * Edge knobs stay at `'front'` / `'hull'` and move freely *within* the reserved margin; moving one
 * past the reserve is what the guard-band check catches.
 */
export function overscanFor(p: EdgeParams): InstanceType<typeof KnobError> | number {
  return overscanFromRadius(overscanRadius(p))
}

/**
 * The artwork's long side: `A = maxSize / (1 + 2p)` (spec 8.5). Artwork resolution is
 * front-derived, never source-derived, and is stored unpadded - the margin belongs to front space
 * and is applied by the seed pass with a uv offset at no cost.
 *
 * `maxSize` here is the front's long side, not the stage-level `maxSize` knob - spec 8.6's bucket
 * scheme makes the two coincide, but a caller reaching for this outside that scheme should pass the
 * sprite's front, the same value `sdfResFor` (spec 7.4.3) is based on.
 *
 * `paperSheet()` no longer uses this: it reserves the margin per axis in texels
 * (`paper/src/handle.ts`'s `frontForArtwork`), for which this uniform-fraction form is the
 * portrait/square case.
 */
export function artworkLongSide(maxSize: number, overscan: number): number {
  return Math.ceil(maxSize / (1 + 2 * overscan))
}

/**
 * The front's long side under `exact: true`: `ceil(source x (1 + 2p))` (spec 7.4.3) - larger than
 * the source, because the paper margin still has to fit.
 *
 * `paperSheet()` no longer uses this: it reserves the margin per axis in texels
 * (`paper/src/handle.ts`'s `frontForArtwork`), for which this uniform-fraction form is the
 * portrait/square case.
 */
export function exactFrontLongSide(sourceLongSide: number, overscan: number): number {
  return Math.ceil(sourceLongSide * (1 + 2 * overscan))
}

export interface GuardCheckInput {
  /** The front texture, in texels. */
  readonly frontSize: Size
  /**
   * The hull's extent in front texel space, margin included: silhouette plus paint radius, and
   * ideally continuous and unclamped — a box clamped to the plane stops at exactly 0.5, so it can
   * say that a sheet intrudes but never how far it really reaches.
   */
  readonly hullExtent: Rect
}

function axisIntrusion(min: number, extent: number, dimension: number): number {
  const half = dimension / 2
  return Math.max(Math.abs(min - half), Math.abs(min + extent - half)) / dimension
}

/**
 * The guard-band intrusion check (spec 8.6).
 *
 * `paper.js:319-322` is `d - smoothstep(0.482, 0.5, max(q.x, q.y)) * 1e4` - a hard cut, with the
 * field collapsing to -1e4 in the outer 1.8% of the texture. An under-sized margin therefore
 * produces a straight flat slice of the scrap parallel to the texture edge, which is a bug class
 * rather than a graceful degradation. The obvious home was the `alphaBbox` readback, which spec
 * 8.3 removes, so the check moves with it: compare the hull's extent against the band and return.
 *
 * Returns a `SheetError`, which is a member of `SourceError` - this runs inside
 * `SheetRenderer.source()`.
 */
export function checkGuardBand(i: GuardCheckInput): InstanceType<typeof SheetError> | undefined {
  const { w, h } = i.frontSize
  if (!(w > 0) || !(h > 0)) {
    return new SheetError(`front size is ${w}x${h}, so the guard band cannot be measured`)
  }
  const qx = axisIntrusion(i.hullExtent.x, i.hullExtent.w, w)
  const qy = axisIntrusion(i.hullExtent.y, i.hullExtent.h, h)
  if (qx <= GUARD_BAND_INNER && qy <= GUARD_BAND_INNER) return undefined
  const axis = qx > GUARD_BAND_INNER ? 'x' : 'y'
  const reached = Math.max(qx, qy)
  return new SheetError(
    `the hull reaches ${reached.toFixed(4)} of the front on axis ${axis}, inside the shader's ` +
      `guard band at ${GUARD_BAND_INNER}; the scrap would be sliced flat along that edge - ` +
      `re-add required with a larger overscan or smaller edge knobs`,
  )
}
