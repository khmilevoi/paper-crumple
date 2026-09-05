/**
 * design 2026-09-05 §5 — from one width to a contour, for both shapes.
 *
 * These are the only place the width knob turns into geometry. `hullBandFor` feeds `hull.ts`,
 * which keeps its `[minDist, maxDist]` interface untouched; `tearAmpsFor` feeds `uTearAmp` and
 * `uMidAmp`, which cease to be knobs (§2.2).
 *
 * The tear's displacement is NOT a symmetric `+-tearAmp`. `tearLow` clamps to `[-1, 1]`
 * (`paper-shader.ts:346`), the mid term is `+-0.225 * midAmp` on the smooth branch but
 * `[-1, +0.55] * midAmp` on the angular one — bites and tabs are not symmetric — and the teeth
 * add `+-1.6 * chew` independently of the width (`paper-shader.ts:544-558`, `:588`). Normalising
 * the mid amplitude by `midLow` is what pins the LOWER reach at exactly `W (1 - v)`; the upper
 * reach then lands inside `W (1 + v)`, which is the direction the reserve can afford.
 *
 * Known boundary this module does NOT cover: the tear floor `tearFloor = tight + 0.4*W` (the
 * shader's own clamp on how far a tear can pull inward) binds before `W(1 - v)` once `v > 0.6`, so
 * the true lower reach past that point is `max(W(1 - v), 0.4*W)`, not `W(1 - v)` as this module's
 * amplitudes assume. The amplitudes computed here are unaffected by that floor — they are about
 * amplitudes, not about where the shader ultimately clamps the result — but a caller sweeping
 * `edgeVariance` past 0.6 must not assume the band identity above still holds.
 */

/**
 * `|midSmooth|` in the shader: `1.25 * MID_SCALLOP` (`paper-shader.ts:548`). Mirrored as a GLSL
 * literal there; the two must move together (R11).
 */
export const MID_LOW_SMOOTH = 0.225
/**
 * `-bite * 1.0` (`paper-shader.ts:556`). Read only by `midLow` in this file — it is exported
 * anyway so a reader can see the shader's own branch coefficient named, not folded into an
 * arithmetic expression; do not let lint/knip strip it as unused-across-files.
 */
export const MID_LOW_ANGULAR = 1
/**
 * `+tab * 0.55` (`paper-shader.ts:556`). Mirrored as a GLSL literal there; the two must move
 * together (R11). Read only by `midHigh` in this file, exported for the same reason as
 * `MID_LOW_ANGULAR` above.
 */
export const MID_HIGH_ANGULAR = 0.55
/** `teeth = uChew * 1.6` (`paper-shader.ts:585`). Mirrored as a GLSL literal there; the two must
 * move together (R11). */
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
