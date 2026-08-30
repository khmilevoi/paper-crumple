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
