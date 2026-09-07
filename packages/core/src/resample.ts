/**
 * The normative TypeScript reference of `identityResample` (spec 7.4.1).
 *
 * A single pass. Not a chain of halvings, not separable, no float. An exact area filter whose
 * weights are quantised to `Q = 128` per axis, so the two-dimensional weight total is
 * `T = Q² = 16384` for every output texel at every ratio — which is what lets 32-bit accumulators
 * suffice regardless of the size relationship, and what removes "a rule for odd sizes" from the
 * problem entirely.
 *
 * The GLSL ES 3.00 twin of this file (P6) is byte-identical to it by construction rather than by
 * measurement, so every change here is a change to a cross-language contract.
 */

import { SheetError } from './errors.js'
import type { Rect } from './geometry.js'

/** Weight quantisation per axis (spec 7.4.1). */
export const RESAMPLE_Q = 128

/** The two-dimensional weight total, `Q²` — identical for every output texel at every ratio. */
export const RESAMPLE_T = RESAMPLE_Q * RESAMPLE_Q

/**
 * The exact floor, for `n >= 0, d >= 1`.
 *
 * Both operands are non-negative everywhere in this file by construction, which puts the known
 * GLSL/JS disagreement on negative rounding out of reach rather than merely documenting it.
 *
 * `Math.floor(n / d)` is exact for every division this filter performs. The double quotient is
 * correctly rounded, so the floor can only be wrong when the true quotient `q` satisfies
 * `q >= 2^53 / d`. The largest quotient here is 255 and the largest divisor is 255 * T =
 * 4 177 920, which needs `q >= 2 147 483 648` before the bound bites.
 */
export function idiv(n: number, d: number): number {
  return Math.floor(n / d)
}

/** Round-half-up, for `n >= 0, d >= 1`. */
export function roundDiv(n: number, d: number): number {
  return idiv(n + (d >> 1), d)
}

/** One output texel's contiguous source window along one axis. */
export interface AxisWindow {
  /** The first source index the window reads, inclusive. */
  readonly j0: number
  /**
   * The weights for source indices `j0, j0 + 1, …`. Sums to exactly `RESAMPLE_Q`, with no
   * correction pass, and no element is negative.
   */
  readonly weights: readonly number[]
}

/**
 * The per-axis plan of spec 7.4.1 steps 1 and 2, for `dstLen` outputs over `srcLen` source texels.
 *
 * Step 1, in units of `1 / dstLen`: `lo = i·srcLen`, `hi = lo + srcLen`, `j0 = idiv(lo, dstLen)`,
 * `j1 = min(srcLen, idiv(hi + dstLen − 1, dstLen))`.
 *
 * Step 2, weights by telescoping integer division for `j` in `[j0, j1)`:
 * `e(j) = clamp((j+1)·dstLen, lo, hi) − lo`, `cum(j) = idiv(Q·e(j), srcLen)`,
 * `q(i,j) = cum(j) − cum(j−1)` with `cum(j0−1) ≡ 0`. Since `cum(j1−1) = Q`, `Σ q = Q` exactly.
 * `cum` is non-decreasing, so `q >= 0`.
 *
 * A degenerate axis returns an empty plan rather than throwing (spec 10.8).
 */
export function axisPlan(srcLen: number, dstLen: number): readonly AxisWindow[] {
  if (srcLen < 1 || dstLen < 1) return []
  const plan: AxisWindow[] = []
  for (let i = 0; i < dstLen; i++) {
    const lo = i * srcLen
    const hi = lo + srcLen
    const j0 = idiv(lo, dstLen)
    const j1 = Math.min(srcLen, idiv(hi + dstLen - 1, dstLen))
    const weights: number[] = []
    let previous = 0
    for (let j = j0; j < j1; j++) {
      const e = Math.min(Math.max((j + 1) * dstLen, lo), hi) - lo
      const cumulative = idiv(RESAMPLE_Q * e, srcLen)
      weights.push(cumulative - previous)
      previous = cumulative
    }
    plan.push({ j0, weights })
  }
  return plan
}

/**
 * The largest value any accumulator or `roundDiv` addend reaches: `Sr <= 255 · Sa` with
 * `Sa <= 255 · T`, plus `roundDiv`'s own `Sa >> 1`. Four times this is 4 269 834 240, still inside
 * 2³² — spec 7.4.1's 4x headroom, and the reason `highp int` suffices in the GLSL twin.
 */
export const RESAMPLE_MAX_ACCUMULATOR = 255 * 255 * RESAMPLE_T + ((255 * RESAMPLE_T) >> 1)

/** Tightly packed, non-premultiplied RGBA8 (spec 8.7). `data.length === width * height * 4`. */
export interface ResampleSource {
  readonly data: Uint8ClampedArray
  readonly width: number
  readonly height: number
}

function isPositiveInteger(n: number): boolean {
  return Number.isInteger(n) && n > 0
}

function checkRequest(
  source: ResampleSource,
  srcRect: Rect,
  dstW: number,
  dstH: number,
): InstanceType<typeof SheetError> | undefined {
  if (!isPositiveInteger(source.width) || !isPositiveInteger(source.height)) {
    return new SheetError(`resample source is ${source.width}x${source.height}`)
  }
  if (source.data.length !== source.width * source.height * 4) {
    return new SheetError(
      `resample source holds ${source.data.length} bytes for ${source.width}x${source.height}, ` +
        `which needs ${source.width * source.height * 4}`,
    )
  }
  if (!isPositiveInteger(dstW) || !isPositiveInteger(dstH)) {
    return new SheetError(`resample destination is ${dstW}x${dstH}`)
  }
  if (
    !Number.isInteger(srcRect.x) ||
    !Number.isInteger(srcRect.y) ||
    !isPositiveInteger(srcRect.w) ||
    !isPositiveInteger(srcRect.h) ||
    srcRect.x < 0 ||
    srcRect.y < 0 ||
    srcRect.x + srcRect.w > source.width ||
    srcRect.y + srcRect.h > source.height
  ) {
    return new SheetError(
      `resample rect ${srcRect.w}x${srcRect.h} at ${srcRect.x},${srcRect.y} does not fit a ` +
        `${source.width}x${source.height} source`,
    )
  }
  return undefined
}

function copyRect(source: ResampleSource, srcRect: Rect): Uint8ClampedArray {
  const out = new Uint8ClampedArray(srcRect.w * srcRect.h * 4)
  for (let y = 0; y < srcRect.h; y++) {
    const from = ((srcRect.y + y) * source.width + srcRect.x) * 4
    out.set(source.data.subarray(from, from + srcRect.w * 4), y * srcRect.w * 4)
  }
  return out
}

/**
 * The general path of spec 7.4.1 — a single pass, always, at every ratio including 1.
 *
 * Step 3, accumulate with `wt = q_x·q_y` into seven exact accumulators: `Sr += wt·r·a`, `Sg`,
 * `Sb`, `Sa += wt·a`, and unweighted `Ur += wt·r`, `Ug`, `Ub`. Every accumulator stays under
 * `RESAMPLE_MAX_ACCUMULATOR`, far below `Number.MAX_SAFE_INTEGER`, so a JavaScript number is an
 * exact integer here and matches the shader's `uint` bit for bit.
 *
 * Step 4, the only place `roundDiv` appears, four times per texel: `A = roundDiv(Sa, T)`; if
 * `Sa > 0` then `R = roundDiv(Sr, Sa)` (and `G`, `B`), else `R = roundDiv(Ur, T)`.
 *
 * RGB divides by the **unrounded** `Sa`, never by `A`: the normaliser cancels out of
 * `(Σwt·r·a / T) ÷ (Σwt·a / T)`, so the un-premultiply is one exact division rather than a second
 * rounding. The `Sa = 0` branch preserves the matte colour of a fully transparent region.
 *
 * Step 5, no clamp. `Sa <= 255·T => A <= 255`; `Sr <= 255·Sa => R <= 255`. Clamping never fires
 * and must not be written as a safety net.
 */
export function resampleAreaExact(
  source: ResampleSource,
  srcRect: Rect,
  dstW: number,
  dstH: number,
): InstanceType<typeof SheetError> | Uint8ClampedArray {
  const invalid = checkRequest(source, srcRect, dstW, dstH)
  if (invalid !== undefined) return invalid

  const planX = axisPlan(srcRect.w, dstW)
  const planY = axisPlan(srcRect.h, dstH)
  const out = new Uint8ClampedArray(dstW * dstH * 4)

  for (let y = 0; y < dstH; y++) {
    const windowY = planY[y]
    for (let x = 0; x < dstW; x++) {
      const windowX = planX[x]
      let sr = 0
      let sg = 0
      let sb = 0
      let sa = 0
      let ur = 0
      let ug = 0
      let ub = 0
      for (let dy = 0; dy < windowY.weights.length; dy++) {
        const qy = windowY.weights[dy]
        const row = (srcRect.y + windowY.j0 + dy) * source.width
        for (let dx = 0; dx < windowX.weights.length; dx++) {
          const wt = qy * windowX.weights[dx]
          const o = (row + srcRect.x + windowX.j0 + dx) * 4
          const r = source.data[o]
          const g = source.data[o + 1]
          const b = source.data[o + 2]
          const a = source.data[o + 3]
          sr += wt * r * a
          sg += wt * g * a
          sb += wt * b * a
          sa += wt * a
          ur += wt * r
          ug += wt * g
          ub += wt * b
        }
      }
      const d = (y * dstW + x) * 4
      out[d] = sa > 0 ? roundDiv(sr, sa) : roundDiv(ur, RESAMPLE_T)
      out[d + 1] = sa > 0 ? roundDiv(sg, sa) : roundDiv(ug, RESAMPLE_T)
      out[d + 2] = sa > 0 ? roundDiv(sb, sa) : roundDiv(ub, RESAMPLE_T)
      out[d + 3] = roundDiv(sa, RESAMPLE_T)
    }
  }
  return out
}

/**
 * The shipped entry point of spec 7.4.1, and the normative definition of pose 0 (spec 7.4.2).
 *
 * Identity at ratio 1 is structural, not a fast path: every window is exactly one source texel at
 * weight 128, so `Σwt = T`, `roundDiv(Sa, T) = a` and `roundDiv(T·r·a, T·a) = r`, on every channel
 * including RGB under zero alpha. The short-circuit below exists for speed only, and CI compares
 * it against `resampleAreaExact` so it can never drift.
 */
export function identityResample(
  source: ResampleSource,
  srcRect: Rect,
  dstW: number,
  dstH: number,
): InstanceType<typeof SheetError> | Uint8ClampedArray {
  const invalid = checkRequest(source, srcRect, dstW, dstH)
  if (invalid !== undefined) return invalid
  if (srcRect.w === dstW && srcRect.h === dstH) return copyRect(source, srcRect)
  return resampleAreaExact(source, srcRect, dstW, dstH)
}
