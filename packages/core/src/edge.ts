/**
 * The edge vocabulary (design 2026-09-05 §2) and the percent unit's closure (§4.3).
 *
 * Three orthogonal settings replace `EdgeMode`. `shape` and `finish` are factory options because
 * each changes the set of other knobs (spec §6.5); the width is a KNOB, because "no edge" has to
 * be reachable by animating a value to zero without a rebuild.
 */
import { EDGE_SLOP_REFERENCE_PX, GUARD_MARGIN_G, KNOB_REFERENCE_PX } from './overscan.js'

export type EdgeShape = 'smooth' | 'torn'
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
 * `dR/dkappa` is proportional to `S - 2 (1 + eta)(F + e)`, positive for every reserve this library
 * can build, so `R(c = 1)` is a true ceiling for every aspect (design §4.4).
 */
export function percentWidthReserve(o: PercentWidthInput): PercentWidth {
  const e = o.slop ?? EDGE_SLOP_REFERENCE_PX
  const eta = Number.isFinite(o.headroom) && o.headroom > 0 ? o.headroom : 0
  const s = KNOB_REFERENCE_PX * (1 - 2 * GUARD_MARGIN_G)
  const kappa = (1 + o.variance) * o.pct * o.aspect
  const radius = ((1 + eta) * (s * kappa + o.finishTerms + e)) / (1 + 2 * (1 + eta) * kappa)
  const widthRef = o.pct * o.aspect * (s - 2 * radius)
  return { radius, widthRef }
}
