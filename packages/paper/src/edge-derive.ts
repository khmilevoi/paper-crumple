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
 *   pulled INWARD by about `tearAngular * L^2 / (8 rho)`.
 *
 *   That is a `1 / tearFreq^2` law AND a `1 / rho` one, and the second half is the half that gets
 *   dropped. `rho` is the LOCAL radius of curvature of the feature under the contour, not a
 *   property of the knobs: at the shipped `tearFreq 9` the pull is `857 / rho` reference px, which
 *   is 2.5 on the 343-reference-px arc the test disc happens to present, 8.6 on a feature of radius
 *   100, and past `W v` itself on anything sharper. So "the shipped `tearFreq 9` barely notices" is
 *   TRUE OF THAT ARC AND NOT IN GENERAL: on any convex detail with `rho` below roughly 260
 *   reference px the pull already carries `W(1 - v)` under `0.4*W` and the floor is what stops the
 *   contour. Most of a real silhouette is that sharp — so on real artwork the dependable lower
 *   bound is `0.4*W`, and `W(1 - v)` is the refinement that holds where the pull is under a texel.
 *   The descriptor's own minimum of `tearFreq 2` does not notice either way: 51 reference px on the
 *   test disc, more than `W v` itself, so the contour is dragged down until the shader's
 *   `tearFloor = tight + 0.4*W` catches it. At a REFLEX vertex the same interpolant pushes OUTWARD
 *   instead, which is a reserve question rather than a width one (`paper-shader.ts`'s own header
 *   for `baseAngular` states that direction).
 *   So: at `tearAngular > 0` the lower reach is `max(0.4*W, W(1 - v) - the pull above)`, not
 *   `W(1 - v)`, and which of the two terms binds depends on `rho` as much as on `tearFreq`.
 *   Measured and pinned in `edge-redesign.gl.test.ts` ("is pulled to the tear floor by baseAngular
 *   at low tearFreq, and stops there"); at `tearFreq 2, tearAngular 0.8` the rendered inward reach
 *   sits on the floor, in three independent configurations, against the 22.09 the identity would
 *   give.
 *
 * - **The reserve bounds the alpha BOX, not the distance from the alpha.** `overscanRadius`
 *   reserves `reserve.radius` reference px around the artwork's alpha bounding box per axis, and
 *   `checkGuardBand` holds that grown box inside the front; across four fixtures, `tearFreq`
 *   {2, 9, 24}, `tearAngular` {0.8, 1} and three lattice phases no painted texel left it (worst
 *   64.81 of 83.91). The Euclidean distance from the alpha is NOT bounded by `reserve.radius`
 *   inside a concavity: `baseAngular`'s interpolant pushes the webbed contour outward along the
 *   exterior medial ridge, and on a 20-texel slit between two lobes the paper sat up to 117.95
 *   reference px from the alpha (84.33 at the shipped `tearFreq 9`), about 11 texels past the box's
 *   edge and 37 reference px inside the reserve. The box bound is measured, not derived: the worst
 *   geometry for it is a notch opening AT the box edge with a gap just under `2 W`, which puts the
 *   web outside the box before the push starts. That fixture was built and measured — two flat
 *   teeth 30 texels apart, gap against `2 W = 30.5` — and it did NOT approach the reserve: the web
 *   reached 61.73 of 83.91 out through the gap's mouth, never past the teeth's own outline, and the
 *   fixture's worst cell overall was 64.81 (margin 19.10, 22.8 %). All of it in
 *   `edge-redesign.gl.test.ts` ("holds the outward reach inside the frozen reserve, across
 *   fixtures, lattices and phases"), which publishes the whole 72-cell table.
 */

/**
 * # The five coefficients this module shares with the GLSL, declared HERE and interpolated THERE
 *
 * Ruling R11 accepted these as an unavoidable TS/GLSL duplication kept in step by comment. That
 * premise was wrong: `PAPER_FS` is a TS template literal and already interpolates a module constant
 * (`#define MAX_FOLDS ${MAX_FOLDS}`), so the shader can simply read these. It does —
 * `paper-shader.ts` imports them and interpolates them through its own `glslFloat`, which emits
 * the same text the literals were. There is one declaration of each and no sync note left to keep.
 */

/**
 * `MID_SCALLOP` in the shader: the amplitude scale on `midSmooth`, the smooth branch of
 * `mid = mix(midSmooth, midAng, uTearAngular)`. The smooth scallops were tuned at 4.5 px and
 * `uMidAmp` is now quoted as an angular notch depth, so this is what keeps the old look at
 * `tearAngular 0`.
 */
export const MID_SCALLOP = 0.18
/** `midSmooth`'s own coefficient on `MID_SCALLOP` in the shader. */
export const MID_SMOOTH_COEF = 1.25
/**
 * `|midSmooth|`: `MID_SMOOTH_COEF * MID_SCALLOP`. Derived, not restated — see the block above.
 * (`0.22499999999999998` rather than the `0.225` this was written as: the product of two doubles,
 * one ulp under, and every consumer of it compares to nine places or feeds a `float` uniform.)
 */
export const MID_LOW_SMOOTH = MID_SMOOTH_COEF * MID_SCALLOP
/**
 * `-bite * 1.0`, the shader's `midAng` angular branch of that same `mid = mix(...)` expression.
 * Read by `midLow` here and interpolated into the GLSL there.
 */
export const MID_LOW_ANGULAR = 1
/** `+tab * 0.55`, the other half of that same `midAng` expression. */
export const MID_HIGH_ANGULAR = 0.55
/**
 * `teeth = chew * 1.6` in the shader — at TWO sites there (the tear silhouette's `teeth` and a
 * second, differently-scoped `teeth = (uChew * k) * 1.6`), both interpolated from this constant.
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
