/**
 * design 2026-09-05 §2.4's descriptor count table: `descriptorsFor` produces 24 keys for
 * `smooth`/`clean`, 30 for `smooth`/`paper`, 28 for `torn`/`clean` and 34 for `torn`/`paper` — the
 * 20 `COMMON_KNOBS`, one `edgeWidth` and one `edgeVariance` (both universal, present in every
 * cell), the shape-only set (`SMOOTH_KNOBS`'s 1 or `TORN_KNOBS`'s 5), `PAPER_FINISH_KNOBS`'s 6
 * under `finish: 'paper'` only, and `SDF_RES_KNOB`: `20 + 2 + 1 + 0 + 1 = 24`, `+6 = 30`,
 * `20 + 2 + 5 + 0 + 1 = 28`, `+6 = 34`.
 *
 * §6.5's factory-option rule: "A setting that changes the shape of the program, the set of
 * resources, or the set of other knobs is a factory option." `edgeShape` and `edgeFinish` each
 * change the set of other knobs, so both are `paperSheet({ … })` options.
 *
 * Two derived bounds, justified in the brief: `shadowBlur` is 0–40 (scale with `edgeWidth` and
 * `deckleWidth` — the old `thickness` this bound was originally pinned against is gone, folded
 * into `edgeWidth`, §2.3), and `photoFibre` is 0–1 (a mix factor, matching `photoCrumple`).
 *
 * No `binds` on any paper descriptor. Core's `SharedKnob` union is exactly `'paperColor' |
 * 'paperBack'` (packages/core/src/shared-knobs.ts), and `paperColor` / `paperBack` are
 * core-declared, so they are not among this slot's own knobs. The schedule's Owns line asked for
 * "the grain match expressed as a `binds:` shared knob"; §6.2 refuses exactly that, recording
 * `grain` as the canonical *ambiguous* key with two separately-tuned values (paper 0.09 over
 * 0–0.5, motion 0.18 over 0–0.6) reachable only as `sheet.grain` and `motion.grain`. Declaring
 * it as a shared knob would require a third member of `SharedKnob` in P3's file.
 */

import { knobs } from '@paper-crumple/core'
import type { Invalidates, KnobDescriptor } from '@paper-crumple/core'
import { SDF_RES_MAX, SDF_RES_MIN, SIZE_QUANTUM, sdfResFor } from '@paper-crumple/core/unstable'
import type { EdgeParams, EdgeSpec } from '@paper-crumple/core/unstable'

export const COMMON_KNOBS = knobs([
  {
    key: 'sheetCrumple',
    kind: 'number',
    invalidates: 'front',
    default: 0.12,
    min: 0,
    max: 1,
    step: 0.01,
  },
  {
    key: 'creases',
    kind: 'number',
    invalidates: 'front',
    default: 0.035,
    min: 0,
    max: 0.6,
    step: 0.005,
  },
  {
    key: 'grain',
    kind: 'number',
    invalidates: 'front',
    default: 0.09,
    min: 0,
    max: 0.5,
    step: 0.005,
  },
  { key: 'shadow', kind: 'number', invalidates: 'front', default: 0.6, min: 0, max: 1, step: 0.01 },
  {
    key: 'shadowBlur',
    kind: 'number',
    invalidates: 'front',
    default: 13,
    min: 0,
    max: 40,
    step: 0.5,
    reference: 'sprite-px',
  },
  { key: 'seed', kind: 'int', invalidates: 'hull', default: 3, min: 0, max: 999 },
  {
    key: 'facetStrength',
    kind: 'number',
    invalidates: 'front',
    default: 0.8,
    min: 0,
    max: 1.5,
    step: 0.01,
  },
  {
    key: 'lightAngle',
    kind: 'number',
    invalidates: 'front',
    default: 125,
    min: 0,
    max: 360,
    step: 1,
  },
  { key: 'jitter', kind: 'number', invalidates: 'front', default: 3, min: 0, max: 14, step: 0.25 },
  {
    key: 'depthDark',
    kind: 'number',
    invalidates: 'front',
    default: 0.2,
    min: 0,
    max: 1,
    step: 0.01,
  },
  {
    key: 'scrapSize',
    kind: 'number',
    invalidates: 'front',
    default: 0.3,
    min: 0.12,
    max: 0.6,
    step: 0.01,
  },
  {
    key: 'creaseDark',
    kind: 'number',
    invalidates: 'front',
    default: 0.42,
    min: 0,
    max: 0.8,
    step: 0.01,
  },
  {
    key: 'creaseWidth',
    kind: 'number',
    invalidates: 'front',
    default: 2.5,
    min: 1,
    max: 8,
    step: 0.25,
    reference: 'sprite-px',
  },
  {
    key: 'crumpleCells',
    kind: 'number',
    invalidates: 'front',
    default: 12,
    min: 5,
    max: 24,
    step: 0.5,
  },
  {
    key: 'crumpleBite',
    kind: 'number',
    invalidates: 'front',
    default: 0.11,
    min: 0,
    max: 0.3,
    step: 0.01,
  },
  {
    key: 'crumpleDepthLo',
    kind: 'number',
    invalidates: 'front',
    default: 1.4,
    min: 0,
    max: 4,
    step: 0.05,
  },
  {
    key: 'crumpleDepthHi',
    kind: 'number',
    invalidates: 'front',
    default: 1.9,
    min: 0.5,
    max: 6,
    step: 0.05,
  },
  {
    key: 'photoCrumple',
    kind: 'number',
    invalidates: 'front',
    default: 0.2,
    min: 0,
    max: 1,
    step: 0.01,
  },
  {
    key: 'photoFibre',
    kind: 'number',
    invalidates: 'front',
    default: 0.8,
    min: 0,
    max: 1,
    step: 0.01,
  },
  { key: 'debug', kind: 'int', invalidates: 'front', default: 0, min: 0, max: 7, dev: true },
])

/**
 * design 2026-09-05 §2.1 — the width, present in every combination, and the only knob that
 * decides how far the paper reaches past the artwork.
 *
 * `47 / 0.53` reproduces today's `hull` band `[22, 72]` to within a tenth of a reference px
 * (§9.1); the exact parity variance is `25/47 = 0.5319`, below this descriptor's own 0.01 step.
 *
 * The percent default is the value that reproduces `W = 47` on a SQUARE at the library's own
 * default `overscanHeadroom` of 0 (`percentWidthReserve({ pct: 0.059, aspect: 1, variance: 0.53,
 * finishTerms: 0, headroom: 0 })` gives `W = 46.98`). The design document's `5.7` derives from a
 * `p` taken at `variance: 0` and does not reproduce; see the plan's correction 4.
 *
 * Neither base declares `invalidates` (ruling R5): `KnobBase.invalidates` is required, so typing
 * these as `KnobDescriptor` does not check against a literal missing it. `descriptorsFor` attaches
 * `invalidates` when it composes the array, because the level is shape-dependent, not a property
 * of the width or variance in isolation.
 */
export const WIDTH_PX_KNOB = {
  key: 'edgeWidth',
  kind: 'number',
  default: 47,
  min: 0,
  max: 140,
  step: 1,
  reference: 'sprite-px',
} as const

export const WIDTH_PCT_KNOB = {
  key: 'edgeWidth',
  kind: 'number',
  default: 5.9,
  min: 0,
  max: 15,
  step: 0.1,
  reference: 'artwork-pct',
} as const

export const VARIANCE_KNOB = {
  key: 'edgeVariance',
  kind: 'number',
  default: 0.53,
  min: 0,
  max: 1,
  step: 0.01,
} as const

/** design 2026-09-05 §2.2. `angularity` is unchanged from the old `HULL_KNOBS`. */
export const SMOOTH_KNOBS = knobs([
  {
    key: 'angularity',
    kind: 'number',
    invalidates: 'hull',
    default: 0.7,
    min: 0,
    max: 1,
    step: 0.01,
  },
])

/**
 * design 2026-09-05 §2.2. `looseness` survives as a PURE SHAPE knob: after §6.1's edits its only remaining
 * effect is that the blurred field fills concavities (`scrapUnguarded`'s `max(tight, loose)`),
 * which is a shape role, not a width one. `tearMix` is new — how the variance splits between the
 * coarse tear and the mid-frequency wobble. `tearMix` is consumed only by `edge-derive.ts`'s
 * `tearAmpsFor` on the CPU side (Task 6); the shader never sees it and no `uTearMix` uniform
 * exists.
 */
export const TORN_KNOBS = knobs([
  { key: 'tearFreq', kind: 'number', invalidates: 'front', default: 9, min: 2, max: 24, step: 0.5 },
  {
    key: 'tearAngular',
    kind: 'number',
    invalidates: 'front',
    default: 0.8,
    min: 0,
    max: 1,
    step: 0.01,
  },
  {
    key: 'looseness',
    kind: 'number',
    invalidates: 'field',
    default: 0.5,
    min: 0,
    max: 1,
    step: 0.01,
  },
  {
    key: 'chew',
    kind: 'number',
    invalidates: 'front',
    default: 1.8,
    min: 0,
    max: 8,
    step: 0.1,
    reference: 'sprite-px',
  },
  {
    key: 'tearMix',
    kind: 'number',
    invalidates: 'front',
    default: 0.6,
    min: 0,
    max: 1,
    step: 0.01,
  },
])

/**
 * design 2026-09-05 §2.3. Every dimensional finish knob stays in `sprite-px`: a fibre hair and a deckle band
 * are small absolute features of the rim, not a fraction of the picture (§3, §12).
 *
 * `thickness` is NOT here. The shader has no thickness slab — `uThickness` was the contour's own
 * width in all four of its uses — so it becomes `W` and stops being a knob (§2.3, §6.1).
 */
export const PAPER_FINISH_KNOBS = knobs([
  {
    key: 'deckleWidth',
    kind: 'number',
    invalidates: 'front',
    default: 7,
    min: 0,
    max: 40,
    step: 0.5,
    reference: 'sprite-px',
  },
  {
    key: 'deckleLight',
    kind: 'number',
    invalidates: 'front',
    default: 0.6,
    min: 0,
    max: 1,
    step: 0.01,
  },
  {
    key: 'deckleTex',
    kind: 'number',
    invalidates: 'front',
    default: 0.3,
    min: 0,
    max: 1.2,
    step: 0.01,
  },
  { key: 'fibers', kind: 'number', invalidates: 'front', default: 0.8, min: 0, max: 1, step: 0.01 },
  {
    key: 'fiberLen',
    kind: 'number',
    invalidates: 'front',
    default: 4,
    min: 0,
    max: 12,
    step: 0.25,
    reference: 'sprite-px',
  },
  {
    key: 'tearShadow',
    kind: 'number',
    invalidates: 'front',
    default: 0.4,
    min: 0,
    max: 1,
    step: 0.01,
  },
])

/**
 * §5.2 takes `sdfRes` out of `SourceOptions` and makes it a knob at `'field'`. `0` means "derive
 * from the front's long side with §7.4.3's formula": a descriptor carries one constant `default`
 * and §7.4.3's value is a function of a size that is not known until `fit` has run.
 */
export const SDF_RES_KNOB: KnobDescriptor = {
  key: 'sdfRes',
  kind: 'int',
  invalidates: 'field',
  default: 0,
  min: 0,
  max: SDF_RES_MAX,
  dev: true,
}

/**
 * design 2026-09-05 §2.1's per-shape `invalidates`: a width change under `smooth` rebuilds the hull polygon,
 * under `torn` it only rebuilds the front. Legal because the descriptor array is built by the
 * factory, so a given sheet carries exactly one answer (ruling R5).
 */
export function descriptorsFor(spec: EdgeSpec): readonly KnobDescriptor[] {
  const level: Invalidates = spec.shape === 'smooth' ? 'hull' : 'front'
  const base = spec.widthUnit === 'percent' ? WIDTH_PCT_KNOB : WIDTH_PX_KNOB
  const width: KnobDescriptor = { ...base, invalidates: level }
  const variance: KnobDescriptor = { ...VARIANCE_KNOB, invalidates: level }
  const shape: readonly KnobDescriptor[] = spec.shape === 'smooth' ? SMOOTH_KNOBS : TORN_KNOBS
  const finish: readonly KnobDescriptor[] = spec.finish === 'paper' ? PAPER_FINISH_KNOBS : []
  return [...COMMON_KNOBS, width, variance, ...shape, ...finish, SDF_RES_KNOB]
}

export function defaultsFor(spec: EdgeSpec): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  for (const d of descriptorsFor(spec)) out[d.key] = d.default
  return out
}

/** §7.4.3, with `0` reading as "derive" and anything else quantised and clamped. */
export function resolveSdfRes(knobValue: number, frontLongSide: number): number {
  if (!Number.isFinite(knobValue) || knobValue <= 0) return sdfResFor(frontLongSide)
  const quantised = SIZE_QUANTUM * Math.ceil(knobValue / SIZE_QUANTUM)
  return Math.min(SDF_RES_MAX, Math.max(SDF_RES_MIN, quantised))
}

/**
 * The bag core's `overscanRadius` reads (design §4.1). `widthRef` is resolved by the CALLER —
 * `paperSheet`'s `build()` / `source()` — because the percent unit's conversion needs the sprite's
 * aspect and the frozen reserve, neither of which a knob bag carries (§3.1).
 *
 * §2.5's zero rule is enforced here as well as in the shader: at `widthRef === 0` the finish terms
 * are zero, so the reserve is one `slop`.
 *
 * Ruling R3: every value this reads from `values` falls back to `defaultsFor(spec)`, never to a
 * bare literal. An incomplete knob bag (a caller that only ever set `edgeWidth`, say) must still
 * resolve to the SAME defaults `descriptorsFor(spec)` declares — Task 6 feeds this same resolved
 * number to `tearAmpsFor` and to the shader's uniform upload, and a literal `0` there would break
 * the `W(1 ± v)` invariant instead of reproducing the shipped default.
 */
export function edgeParamsFrom(
  spec: EdgeSpec,
  values: Readonly<Record<string, unknown>>,
  widthRef: number,
): EdgeParams {
  const defaults = defaultsFor(spec)
  const num = (key: string): number => {
    const v = values[key]
    if (typeof v === 'number' && Number.isFinite(v)) return v
    const d = defaults[key]
    // `defaults` is `defaultsFor(spec)`, and `descriptorsFor(spec)` declares `edgeVariance` in
    // every cell and `fiberLen` / `deckleWidth` in every cell this function actually reads them
    // in (`decorated` gates both on `finish === 'paper'`), so `d` is always a number here — this
    // branch is unreachable for the three keys this file calls `num` with. It stays NaN, not `0`,
    // on purpose: ruling R3 exists because a missing knob value must never look like that knob
    // being deliberately zeroed, and `0` is exactly indistinguishable from a real zero variance —
    // `NaN` propagates loudly through `overscanRadius` instead. If this ever fires, the caller
    // passed a key `descriptorsFor(spec)` does not declare, which is a bug in the caller.
    return typeof d === 'number' ? d : NaN
  }
  const w = Number.isFinite(widthRef) && widthRef > 0 ? widthRef : 0
  const decorated = spec.finish === 'paper' && w > 0
  return {
    widthRef: w,
    variance: num('edgeVariance'),
    fiberLen: decorated ? num('fiberLen') : 0,
    deckleWidth: decorated ? num('deckleWidth') : 0,
  }
}
