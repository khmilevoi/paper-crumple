/**
 * The edge vocabulary (design 2026-09-05 §2) and the percent unit's closure (§4.3).
 *
 * Three orthogonal settings replace `EdgeMode`. `shape` and `finish` are factory options because
 * each changes the set of other knobs (spec §6.5). Width controls spacing; shape 'none' disables
 * the contour and its finish. A paper finish retains its intrinsic core at zero spacing.
 */
import { EDGE_SLOP_REFERENCE_PX, RADIUS_CAP_REFERENCE_PX } from './overscan.js'

export type EdgeShape = 'none' | 'smooth' | 'torn'
export type EdgeFinish = 'clean' | 'paper'
export type EdgeWidthUnit = 'px' | 'percent'

export interface EdgeSpec {
  readonly shape: EdgeShape
  readonly finish: EdgeFinish
  readonly widthUnit: EdgeWidthUnit
}

export interface PercentWidthInput {
  /** A FRACTION of the artwork's short side: `0.059`, not `5.9`. */
  readonly pct: number
  /** `c = min(1, srcW / srcH)` — the artwork's short side over its height. */
  readonly aspect: number
  readonly variance: number
  /** `4 * fiberLen + deckleWidth`, reference px; `0` under finish `'clean'`. */
  readonly finishTerms: number
  readonly headroom: number
  readonly slop?: number
}

export interface PercentWidth {
  readonly radius: number
  readonly widthRef: number
}

/**
 * The percent width and the reserve it implies, in one closed form.
 *
 * The percent is a fraction of the artwork, and the artwork is what is left after the reserve, so
 * the two are mutually defined. Under design §4.2's split the closure is LINEAR, so there is no
 * iteration and no second pass through `capA`:
 *
 * ```
 * S     = 1000 (1 - 2g)                      // the front's own reference plane after the guard
 * kappa = (1 + v) * pct * c
 * R     = (1 + eta) * (S kappa + F + e) / (1 + 2 (1 + eta) kappa)
 * W     = pct * c * (S - 2 R)
 * ```
 *
 * `S` and not `1000` is the whole of correction 2's consequence here: the front carries the guard
 * margin as well as the paint one, so a reference px is `front.h / 1000` of a LARGER front, and a
 * fixed fraction of the artwork is worth proportionally fewer of them. This uses Task 1's front
 * (`front.h / A.h = 1000 / (1000(1 - 2g) - 2R)`), not the spec's own — the spec's is short by the
 * guard shortfall and would make the rendered border about 1 % wider than the number on the slider.
 *
 * `dR/dkappa` is proportional to `S - 2 (1 + eta)(F + e)`, and `R(c = 1)` is therefore a true
 * ceiling over the aspect, `c`, exactly when that is positive:
 *
 * ```
 * (1 + eta)(F + e) < RADIUS_CAP_REFERENCE_PX
 * ```
 *
 * `S` cancels to this form because `S = 1000(1 - 2g)` is EXACTLY `2 * RADIUS_CAP_REFERENCE_PX`
 * (`RADIUS_CAP_REFERENCE_PX = KNOB_REFERENCE_PX * (0.5 - g)`, so doubling it is `1000(1 - 2g)`,
 * the same `S` above — not an approximation): `S - 2(1 + eta)(F + e) > 0
 * <=> (1 + eta)(F + e) < S / 2 = RADIUS_CAP_REFERENCE_PX`. Task 1's cap on the radius `r` itself
 * (design §4.2, ruling R2) and this bound on `(1 + eta)(F + e)` are two different conditions, but
 * they share the identical threshold — 482 reference px is where the guard margin diverges either
 * way. Every `(v, F, eta)` this library can actually build clears the bound by a wide margin
 * (`edge.test.ts`'s sweep goes as high as `eta = 1`, `F = 40`, for `(1 + eta)(F + e) = 104`,
 * well under the 482 line), so the ceiling is total for anything this library constructs, not
 * merely for the points sampled — but the identity above, not the sample, is why.
 */
export function percentWidthReserve(o: PercentWidthInput): PercentWidth {
  const e = o.slop ?? EDGE_SLOP_REFERENCE_PX
  const eta = Number.isFinite(o.headroom) && o.headroom > 0 ? o.headroom : 0
  // S = 1000(1 - 2g), computed as 2 * RADIUS_CAP_REFERENCE_PX (see the doc comment above for why
  // that doubling is exact) so the monotonicity ceiling's own threshold is read from the same
  // constant this function's radius is built from, not re-derived independently of it.
  const s = 2 * RADIUS_CAP_REFERENCE_PX
  const kappa = (1 + o.variance) * o.pct * o.aspect
  const radius = ((1 + eta) * (s * kappa + o.finishTerms + e)) / (1 + 2 * (1 + eta) * kappa)
  const widthRef = o.pct * o.aspect * (s - 2 * radius)
  return { radius, widthRef }
}
