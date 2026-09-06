import { defaultsFor, edgeParamsFrom, freezeOverscan } from '@paper-crumple/paper'
import type { EdgeSpec } from '@paper-crumple/paper'
import { EDGE_SLOP_REFERENCE_PX } from '@paper-crumple/core/unstable'
import { KnobError } from '@paper-crumple/core'

/**
 * The live ceiling `edgeWidth` and `edgeVariance` are actually bounded by, given the sheet's
 * frozen reserve (design 2026-09-05 §8.6) — computed from `@paper-crumple/paper`'s own public
 * exports, so the playground can show a slider's honest range instead of letting a reader
 * discover the ceiling by refusal (task 9 brief).
 *
 * **The core idea**: `build()`'s step-4 `checkReserve` refuses whenever
 * `overscanRadius({ widthRef, variance, fiberLen, deckleWidth }) > reserve.radius` — see
 * `packages/paper/src/handle.ts`. Solving that inequality for the ONE live knob a slider is
 * asking about, holding every other term at its current live (or default) value, gives that
 * knob's ceiling directly:
 *
 * ```
 * widthMax    = (R - slop - F) / (1 + variance)
 * varianceMax = (R - slop - F) / width - 1        (width > 0; unconstrained at width === 0)
 * ```
 *
 * where `R` is the sprite's frozen reserve radius and `F = 4 * fiberLen + deckleWidth` under
 * `edgeFinish: 'paper'`, `0` under `'clean'` (`edgeParamsFrom`'s own zero rule).
 *
 * **Where `R` comes from.** `PaperSheet.overscan`'s own doc comment (`sheet.ts`) states the rule
 * `reserveFor` implements: the reserve is frozen from THIS FACTORY'S DEFAULTS — never the live
 * knob values — plus `overscanHeadroom`, at the sprite's own aspect. `reserveRadiusFor` below
 * mirrors that private `reserveFor(1)` using only `defaultsFor` / `edgeParamsFrom` /
 * `freezeOverscan`, all exported from `@paper-crumple/paper`'s public barrel (ruling R5's
 * neighbourhood: `checkReserve`, `freezeOverscan`, `handleBytesFor`, `handleFactsFor` and
 * `OverscanReserve` / `PaperSheetHandle` are exported alongside `optionsFor` for exactly this
 * kind of external reasoning about the reserve).
 *
 * **Exact under `edgeWidthUnit: 'px'`**, where `reserveFor` is CONSTANT in the sprite's aspect (no
 * sprite dimension enters the formula at all), so the factory-level `reserveFor(1)` this function
 * computes IS every sprite's own frozen reserve under that unit, not merely an upper bound.
 *
 * **`undefined` under `'percent'`.** There the true per-sprite reserve additionally depends on the
 * live sprite's aspect and on `handle.artwork` / `handle.front` (both in FRONT-texel space,
 * `sheet.ts`'s private `widthRefFrom`) — and neither is reachable from the public `Sprite` type
 * (`packages/core/src/sprite.ts`): only `frontSize` (the padded front) and `rect` (the silhouette
 * box, in SOURCE-pixel space — a different absolute scale, not just a different fraction) are
 * exposed there. Recovering `artwork` from `frontSize` alone would mean re-deriving
 * `guardMarginsFor`'s asymmetric x/y margin split against an UNKNOWN overscan fraction — the
 * exact chicken-and-egg `percentWidthReserve`'s closed form exists to break, one level further
 * from public reach. This function says so honestly rather than faking a number: see the task-9
 * report for the point this was decided at. The existing `stage.on('error')` -> status-pill path
 * (`useStage.ts`) stays the backstop under `'percent'`.
 */
export function reserveRadiusFor(spec: EdgeSpec, overscanHeadroom: number): number | undefined {
  if (spec.widthUnit !== 'px') return undefined
  const defaults = defaultsFor(spec)
  const widthRef = Math.max(0, num(defaults.edgeWidth, 0))
  const params = edgeParamsFrom(spec, defaults, widthRef)
  const reserve = freezeOverscan(params, overscanHeadroom)
  if (KnobError.is(reserve)) return undefined
  return reserve.radius
}

export interface EdgeCeilings {
  /** The largest `edgeWidth` the frozen reserve permits at the CURRENT `edgeVariance` (and finish
   *  knobs) — `undefined` where the reserve cannot be recomputed from public values (`'percent'`). */
  readonly widthMax: number | undefined
  /** The largest `edgeVariance` the frozen reserve permits at the CURRENT `edgeWidth` (and finish
   *  knobs) — `Number.POSITIVE_INFINITY` when `edgeWidth` is `0` (the reserve's width term drops
   *  out entirely there, so variance is unconstrained by it), `undefined` under `'percent'`. */
  readonly varianceMax: number | undefined
}

function num(v: string | number | boolean | undefined, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

/**
 * `knobs` is the LIVE bag, keyed the way `useStage`'s `KnobValues` keys everything — patch keys
 * (`sheet.edgeVariance`, not `edgeVariance`). Every fallback comes from `defaultsFor(spec)`
 * (ruling R3), never a bare literal.
 */
export function ceilingsFor(
  spec: EdgeSpec,
  overscanHeadroom: number,
  knobs: Readonly<Record<string, string | number | boolean>>,
): EdgeCeilings {
  const R = reserveRadiusFor(spec, overscanHeadroom)
  if (R === undefined) return { widthMax: undefined, varianceMax: undefined }
  const defaults = defaultsFor(spec)
  const slop = EDGE_SLOP_REFERENCE_PX
  const width = num(knobs['sheet.edgeWidth'], num(defaults.edgeWidth, 0))
  const variance = num(knobs['sheet.edgeVariance'], num(defaults.edgeVariance, 0))
  const finishTerms =
    spec.finish === 'paper'
      ? 4 * num(knobs['sheet.fiberLen'], num(defaults.fiberLen, 0)) +
        num(knobs['sheet.deckleWidth'], num(defaults.deckleWidth, 0))
      : 0
  const widthMax = (R - slop - finishTerms) / (1 + variance)
  const varianceMax = width > 0 ? (R - slop - finishTerms) / width - 1 : Number.POSITIVE_INFINITY
  return { widthMax, varianceMax }
}
