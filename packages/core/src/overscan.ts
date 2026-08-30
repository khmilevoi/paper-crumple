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

/** Every bounded edge knob is quoted against this frame (`paper.js:39`). */
export const KNOB_REFERENCE_PX = 1000

/**
 * The fixed slop for the JFA half-texel and antialiasing, in reference pixels. Spec 8.6 gives
 * "8-12"; this is the conservative end, because under-reserving produces a straight flat slice of
 * the scrap parallel to the texture edge - a bug class - while over-reserving costs a handful of
 * artwork texels.
 */
export const EDGE_SLOP_REFERENCE_PX = 12

/**
 * The conservative `maxDim / H` bound from the widest bucket (spec 8.6). Spec 8.6 offers either
 * this or one fixed-point iteration; the bound is taken because it is stated as a number, while
 * the iteration needs `maxDim` and `H` in a coordinate space 8.6 never defines. Overscan is a
 * reserve, so over-estimating is safe and under-estimating is the failure this whole section
 * exists to prevent.
 */
export const ASPECT_BOUND = 1.3

/** Where `paper.js:319-322`'s hard cut begins, in centred normalised texture coordinates. */
export const GUARD_BAND_INNER = 0.482

/** Where it is complete: the field has collapsed to -1e4 by here. */
export const GUARD_BAND_OUTER = 0.5

export type EdgeMode = 'hull' | 'torn' | 'both'

/** Every term of spec 8.6's radius formulae, in reference pixels unless noted. */
export interface EdgeParams {
  readonly mode: EdgeMode
  /** The hull's maximum distance - the only consumer of the margin in the default mode. */
  readonly maxDist: number
  /** The paper's thickness. */
  readonly thickness: number
  /** 0..1. Drives both the blur sigma and the tear bracket. */
  readonly looseness: number
  /** Tear amplitude. */
  readonly tearAmp: number
  /** Mid-frequency amplitude. */
  readonly midAmp: number
  /** Fibre length; the margin reserves four of them. */
  readonly fiberLen: number
  /** Overrides `EDGE_SLOP_REFERENCE_PX`. */
  readonly slop?: number
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/**
 * The reserved radius `r`, in reference pixels, for a front build (pose 0, shadow 0):
 *
 * ```
 * r_hull = maxDist + e
 * r_torn = 0.45*sigma + thickness + [thickness + 0.6*looseness*tearAmp + midAmp]*edgeK
 *          + 4*fiberLen + e
 * r_both = maxDist  + thickness + [same bracket]                                 + 4*fiberLen + e
 *          sigma = 200*looseness^1.6*(maxDim/H),  edgeK = smoothstep(0, 6, thickness)
 * ```
 *
 * `r_both` is `r_torn` with `maxDist` substituted for the `0.45*sigma` blur term - the hull radius
 * standing in for the looseness blur - so `[same bracket]` reproduces the bracket whole, `edgeK`
 * included. The two readings coincide for any `thickness >= 6`, where `edgeK` saturates.
 */
export function overscanRadius(p: EdgeParams): number {
  const slop = p.slop ?? EDGE_SLOP_REFERENCE_PX
  if (p.mode === 'hull') return p.maxDist + slop

  const edgeK = smoothstep(0, 6, p.thickness)
  const bracket = (p.thickness + 0.6 * p.looseness * p.tearAmp + p.midAmp) * edgeK
  const lead =
    p.mode === 'torn' ? 0.45 * (200 * Math.pow(p.looseness, 1.6) * ASPECT_BOUND) : p.maxDist
  return lead + p.thickness + bracket + 4 * p.fiberLen + slop
}

/**
 * `p = r / (1000 - 2r)`, the reserved radius expressed as a fraction of the artwork's long side.
 *
 * At `r >= 500` the reserve leaves no artwork inside the reference frame and `p` is undefined or
 * negative. Spec 8.6 forbids a silent clamp and spec 10.8 forbids a throw, so it returns.
 */
export function overscanFromRadius(r: number): InstanceType<typeof KnobError> | number {
  if (!Number.isFinite(r) || r < 0 || 2 * r >= KNOB_REFERENCE_PX) {
    return new KnobError(
      `edge parameters reserve ${r} reference px per side, which leaves no artwork inside the ` +
        `${KNOB_REFERENCE_PX} px reference frame - re-add required with smaller edge knobs`,
    )
  }
  return r / (KNOB_REFERENCE_PX - 2 * r)
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
 */
export function artworkLongSide(maxSize: number, overscan: number): number {
  return Math.ceil(maxSize / (1 + 2 * overscan))
}

/**
 * The front's long side under `exact: true`: `ceil(source x (1 + 2p))` (spec 7.4.3) - larger than
 * the source, because the paper margin still has to fit.
 */
export function exactFrontLongSide(sourceLongSide: number, overscan: number): number {
  return Math.ceil(sourceLongSide * (1 + 2 * overscan))
}

export interface GuardCheckInput {
  /** The front texture, in texels. */
  readonly frontSize: Size
  /** The hull's extent in front texel space, margin included. */
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
