/**
 * §6.7's knob count arithmetic: The spike's `DEFAULT_PARAMS` (paper.js:2027) has 42 entries.
 * Six are not slot knobs: `edgeMode` (factory option), `preset` (demo-app UI state), `pose`
 * (view state), `crumpleFill` (commented in source as "driven per pose from `poses.CRUMPLE_FILL`,
 * not a knob"), and `paperColor` / `paperBack` (core-declared shared, §6.2). That leaves 36:
 * 20 common, 3 hull-only, 13 torn-only, exactly as §6.7 states. `sdfRes` is a 37th descriptor
 * that §6.7 does not count because it was never in `DEFAULT_PARAMS` — §5.2 moves it out of
 * `SourceOptions` and makes it "`sheet.sdfRes`, a knob with `invalidates: 'field'`".
 *
 * §6.5's factory-option rule: "A setting that changes the shape of the program, the set of
 * resources, or the set of other knobs is a factory option." `edgeMode` changes the set of other
 * knobs, so it is `paperSheet({ edgeMode })` and a `hull` factory's `knobs` array simply does
 * not contain the 13 torn-only descriptors.
 *
 * Two derived bounds, justified in the brief: `shadowBlur` is 0–40 (scale with `thickness` and
 * `deckleWidth`), and `photoFibre` is 0–1 (a mix factor, matching `photoCrumple`).
 *
 * No `binds` on any paper descriptor. Core's `SharedKnob` union is exactly `'paperColor' |
 * 'paperBack'` (packages/core/src/shared-knobs.ts), and `paperColor` / `paperBack` are
 * core-declared, so they are not among this slot's own knobs. The schedule's Owns line asked for
 * "the grain match expressed as a `binds:` shared knob"; §6.2 refuses exactly that, recording
 * `grain` as the canonical *ambiguous* key with two separately-tuned values (paper 0.09 over
 * 0–0.5, motion 0.18 over 0–0.6) reachable only as `sheet.grain` and `motion.grain`. Declaring
 * it as a shared knob would require a third member of `SharedKnob` in P3's file.
 *
 * §6.5's "31 knobs rather than 46": This does not reconcile with 46 − 13 = 33. The plan report
 * raises that conflict; the derived composition stands instead.
 */

import { knobs } from '@paper-crumple/core'
import type { KnobDescriptor } from '@paper-crumple/core'
import { SDF_RES_MAX, SDF_RES_MIN, SIZE_QUANTUM, sdfResFor } from '@paper-crumple/core/unstable'
import type { EdgeMode, EdgeParams } from '@paper-crumple/core/unstable'

/**
 * Core's `EdgeMode`, re-exported under this package's name. Never re-declare the union.
 *
 * The three front modes. `hull` and `torn` are `paper.js:25`'s own `EDGE_MODES`; `both` is the
 * third mode `edge.js` adds on top of them — the hull polygon as the silhouette, decorated by the
 * torn shader path — and it never crosses into the 2D engine's own `edgeMode` uniform.
 */
export type PaperEdgeMode = EdgeMode

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

export const HULL_KNOBS = knobs([
  {
    key: 'minDist',
    kind: 'number',
    invalidates: 'hull',
    default: 22,
    min: 0,
    max: 80,
    step: 1,
    reference: 'sprite-px',
  },
  {
    key: 'maxDist',
    kind: 'number',
    invalidates: 'hull',
    default: 72,
    min: 0,
    max: 140,
    step: 1,
    reference: 'sprite-px',
  },
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

export const TORN_KNOBS = knobs([
  {
    key: 'thickness',
    kind: 'number',
    invalidates: 'front',
    default: 22,
    min: 0,
    max: 40,
    step: 1,
    reference: 'sprite-px',
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
  { key: 'tearFreq', kind: 'number', invalidates: 'front', default: 9, min: 2, max: 24, step: 0.5 },
  {
    key: 'tearAmp',
    kind: 'number',
    invalidates: 'front',
    default: 44,
    min: 0,
    max: 90,
    step: 1,
    reference: 'sprite-px',
  },
  {
    key: 'midAmp',
    kind: 'number',
    invalidates: 'front',
    default: 26,
    min: 0,
    max: 50,
    step: 0.5,
    reference: 'sprite-px',
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
    key: 'tearAngular',
    kind: 'number',
    invalidates: 'front',
    default: 0.8,
    min: 0,
    max: 1,
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

export function descriptorsFor(mode: PaperEdgeMode): readonly KnobDescriptor[] {
  const edge =
    mode === 'hull' ? HULL_KNOBS : mode === 'torn' ? TORN_KNOBS : [...HULL_KNOBS, ...TORN_KNOBS]
  return [...COMMON_KNOBS, ...edge, SDF_RES_KNOB]
}

export function defaultsFor(mode: PaperEdgeMode): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  for (const d of descriptorsFor(mode)) out[d.key] = d.default
  return out
}

/** §7.4.3, with `0` reading as "derive" and anything else quantised and clamped. */
export function resolveSdfRes(knobValue: number, frontLongSide: number): number {
  if (!Number.isFinite(knobValue) || knobValue <= 0) return sdfResFor(frontLongSide)
  const quantised = SIZE_QUANTUM * Math.ceil(knobValue / SIZE_QUANTUM)
  return Math.min(SDF_RES_MAX, Math.max(SDF_RES_MIN, quantised))
}

/**
 * The bag core's `overscanFor` / `overscanRadius` read (§8.6). `'both'` maps to core's `'both'`;
 * `'hull'` reports only `maxDist`, which is the whole of `r_hull = maxDist + slop`.
 */
export function edgeParamsFrom(
  mode: PaperEdgeMode,
  values: Readonly<Record<string, unknown>>,
): EdgeParams {
  const num = (key: string, fallback: number): number => {
    const v = values[key]
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback
  }
  return {
    mode,
    maxDist: num('maxDist', 0),
    thickness: num('thickness', 0),
    looseness: num('looseness', 0),
    tearAmp: num('tearAmp', 0),
    midAmp: num('midAmp', 0),
    fiberLen: num('fiberLen', 0),
  }
}
