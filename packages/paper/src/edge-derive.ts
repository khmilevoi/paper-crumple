/**
 * design 2026-09-05 §5 — from one width to a contour, for both shapes.
 *
 * These are the only place the width knob turns into geometry. `hullBandFor` feeds `hull.ts`,
 * which keeps its `[minDist, maxDist]` interface untouched; `tearAmpsFor` feeds `uTearAmp` and
 * `uMidAmp`, which cease to be knobs (§2.2).
 *
 * The tear's displacement is NOT a symmetric `+-tearAmp`. `tearLow` clamps to `[-1, 1]`
 * (`paper-shader.ts`, `tearLow`'s own last line), the mid term is `+-0.225 * midAmp` on the smooth
 * branch (`midSmooth`) but `[-1, +0.55] * midAmp` on the angular one (`midAng`) — bites and tabs
 * are not symmetric — and the teeth add `+-1.6 * chew` independently of the width (`tearOf`'s
 * `teeth`, and `farOutside`'s second `teeth`). Cited by identifier, not by line: ruling R11, and
 * the edge redesign moved every line number in that region. Normalising
 * the mid amplitude by `midLow` is what pins the LOWER reach at exactly `W (1 - v)`; the upper
 * reach then lands inside `W (1 + v)`, which is the direction the reserve can afford.
 *
 * Known boundaries this module does NOT cover:
 *
 * - The tear floor `tearFloor = tight + 0.4*W` (the shader's own clamp on how far a tear can pull
 *   inward) binds before `W(1 - v)` once `v > 0.6`, so the true lower reach past that point is
 *   `max(W(1 - v), 0.4*W)`, not `W(1 - v)` as this module's amplitudes assume. The amplitudes
 *   computed here are unaffected by that floor — they are about amplitudes, not about where the
 *   shader ultimately clamps the result — but a caller sweeping `edgeVariance` past 0.6 must not
 *   assume the band identity above still holds.
 *
 * - `tearAmpsFor`'s own budget clamp (`Math.max(0, w*v - CHEW_REACH*chew)`, below) breaks the SAME
 *   identity from the other end. Whenever `W*v < CHEW_REACH*chew` — at the design defaults
 *   (`chew = 1.8`, so `CHEW_REACH*chew = 2.88`), that is any `v < 0.0613` at `W = 47`, or
 *   equivalently any `W < 5.43` at `v = 0.53` — the budget clamps to 0 (`tearAmp = midAmp = 0`) and
 *   the lower reach becomes `W - CHEW_REACH*chew`, not `W(1 - v)`: strictly BELOW `W(1 - v)`, because
 *   the clamp only engages when the unclamped budget would already have gone negative, i.e. exactly
 *   when `W - CHEW_REACH*chew < W(1 - v)`. `edgeVariance` sweeps starting at 0 walk straight into
 *   this regime at the defaults — do not gate a sweep assertion on `W(1 - v)` holding down there.
 *
 * - `baseAngular` (`paper-shader.ts`) breaks the identity from a THIRD direction, on the `tearFreq`
 *   axis, and this module does not model that term at all. That block replaces the base field
 *   `tight + W` with its piecewise-linear interpolant on a lattice of side
 *   `KNOB_REFERENCE_PX / (tearFreq * ANG_FREQ)` reference px — 417 at `tearFreq 2`, 93 at the
 *   shipped 9, 35 at 24 — and blends the two at weight `tearAngular`; `tearOf` then adds the
 *   octaves computed here on top of `baseAng`, NOT on top of `base`. On a convex arc of radius
 *   `rho` the interpolant of a concave function lies below it by the chord sag, so the contour is
 *   pulled INWARD by about `tearAngular * L^2 / (8 rho)` — a `1 / tearFreq^2` law, which is why the
 *   shipped `tearFreq 9` barely notices (2.5 reference px on a 343-reference-px arc) and the
 *   descriptor's own minimum of 2 does not: 51 reference px there, more than `W v` itself, so the
 *   contour is dragged down until the shader's `tearFloor = tight + 0.4*W` catches it. At a REFLEX
 *   vertex the same interpolant pushes OUTWARD instead, which is a reserve question rather than a
 *   width one (`paper-shader.ts`'s own header for `baseAngular` states that direction).
 *   So: at `tearAngular > 0` and low `tearFreq` the lower reach is `max(0.4*W, W(1 - v) - the pull
 *   above)`, not `W(1 - v)`. Measured and pinned in `edge-redesign.gl.test.ts` ("is pulled to the
 *   tear floor by baseAngular at low tearFreq, and stops there"); at `tearFreq 2, tearAngular 0.8`
 *   the rendered inward reach sits on the floor, in three independent configurations, against the
 *   22.09 the identity would give.
 */

/**
 * `|midSmooth|` in the shader's `mid = mix(midSmooth, midAng, uTearAngular)` branch:
 * `1.25 * MID_SCALLOP`, where `MID_SCALLOP` is `paper-shader.ts`'s own named GLSL constant (NOT a
 * bare literal — this is `1.25 *` that constant's value). The two must move together (R11): if
 * `MID_SCALLOP` changes, this constant must be updated to `1.25 * MID_SCALLOP`'s new value.
 */
export const MID_LOW_SMOOTH = 0.225
/**
 * `-bite * 1.0`, the shader's `midAng` angular branch of that same `mid = mix(...)` expression.
 * Read only by `midLow` in this file — it is exported anyway so a reader can see the shader's own
 * branch coefficient named, not folded into an arithmetic expression; do not let lint/knip strip it
 * as unused-across-files.
 */
export const MID_LOW_ANGULAR = 1
/**
 * `+tab * 0.55`, the other half of that same `midAng` expression. Mirrored as a GLSL literal there;
 * the two must move together (R11). Read only by `midHigh` in this file, exported for the same
 * reason as `MID_LOW_ANGULAR` above.
 */
export const MID_HIGH_ANGULAR = 0.55
/**
 * `teeth = chew * 1.6` in the shader — mirrored as a GLSL literal at TWO sites there (the tear
 * silhouette's `teeth` and a second, differently-scoped `teeth = (uChew * k) * 1.6`); all three
 * (this constant and both shader sites) must move together (R11).
 */
export const CHEW_REACH = 1.6

const clamp01 = (x: number): number => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0)

/** `m-`: how far one unit of `midAmp` can bite INWARD, at this `tearAngular`. */
export function midLow(tearAngular: number): number {
  const a = clamp01(tearAngular)
  return MID_LOW_SMOOTH + (MID_LOW_ANGULAR - MID_LOW_SMOOTH) * a
}

/** `m+`: how far one unit of `midAmp` can build OUTWARD, at this `tearAngular`. */
export function midHigh(tearAngular: number): number {
  const a = clamp01(tearAngular)
  return MID_LOW_SMOOTH + (MID_HIGH_ANGULAR - MID_LOW_SMOOTH) * a
}

export interface HullBand {
  readonly minDist: number
  readonly maxDist: number
}

/** `smooth`: the band handed to `hull.ts` unchanged, `W (1 -+ v)`. */
export function hullBandFor(widthRef: number, variance: number): HullBand {
  const w = Number.isFinite(widthRef) && widthRef > 0 ? widthRef : 0
  const v = clamp01(variance)
  return { minDist: w * (1 - v), maxDist: w * (1 + v) }
}

export interface TearAmps {
  readonly tearAmp: number
  readonly midAmp: number
}

/**
 * `torn`: the two octave amplitudes, from the budget left after `chew` has taken its share.
 *
 * `chew` stays ABSOLUTE and is subtracted rather than scaled, because it is a sub-texel bite of
 * the rim, not a fraction of the border. The consequence is a floor: below `W v = 1.6 chew` the
 * budget would go negative, so it clamps at zero and `chew` alone sets the wobble.
 */
export function tearAmpsFor(o: {
  readonly widthRef: number
  readonly variance: number
  readonly tearMix: number
  readonly tearAngular: number
  readonly chew: number
}): TearAmps {
  const w = Number.isFinite(o.widthRef) && o.widthRef > 0 ? o.widthRef : 0
  const v = clamp01(o.variance)
  const chew = Number.isFinite(o.chew) && o.chew > 0 ? o.chew : 0
  const mix = clamp01(o.tearMix)
  const budget = Math.max(0, w * v - CHEW_REACH * chew)
  return {
    tearAmp: budget * mix,
    midAmp: (budget * (1 - mix)) / midLow(o.tearAngular),
  }
}
