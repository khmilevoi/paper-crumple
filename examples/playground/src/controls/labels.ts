/**
 * The demo owns its labels, and `controls/LibrarySections.tsx` groups the leftover knobs by the `group`
 * below — the design's own curated sections carry their labels literally instead, so only the
 * knobs the mockup leaves out are ever rendered from this table.
 *
 * The demo owns its labels. Paper declares no `ui` on any descriptor and motion declares one on
 * all six — §6.1's rule that a consumer's bundle does not carry English strings for a UI the
 * library does not own. A descriptor absent from this table is still rendered, under its raw
 * key and carrying a `no label` badge, which is what keeps this file from silently rotting.
 *
 * Keys are patch keys, not descriptor keys: `k.binds ? k.key : `${ns}.${k.key}``. The two
 * core-declared shared knobs are keyed bare (`paperColor`, `paperBack`); every slot-declared
 * knob is namespaced `sheet.*` or `motion.*`.
 *
 * `grain` and `debug` exist in both slots as genuinely different knobs — a flat 2D sheet and a
 * shaded 3D mesh are tuned separately (grain: paper's default 0.09 over 0–0.5, motion's 0.18
 * over 0–0.6) — so their labels below are written to be told apart at a glance rather than
 * sharing a name.
 */
export interface KnobLabel {
  readonly label: string
  readonly group: string
  readonly order: number
}

export const GROUP_ORDER: readonly string[] = [
  'Paper',
  'Silhouette',
  'Silhouette — shape',
  'Silhouette — finish',
  'Fold',
  'Ball',
  'Motion',
  'Resolution',
  'Debug',
]

export const LABELS: ReadonlyMap<string, KnobLabel> = new Map([
  // Paper — the two core-declared shared knobs plus the six sheet-wide look knobs.
  ['paperColor', { label: 'paper colour (front)', group: 'Paper', order: 0 }],
  ['paperBack', { label: 'paper colour (back)', group: 'Paper', order: 1 }],
  ['sheet.sheetCrumple', { label: 'sheet relief', group: 'Paper', order: 2 }],
  ['sheet.creases', { label: 'creases', group: 'Paper', order: 3 }],
  ['sheet.grain', { label: 'grain (2D sheet)', group: 'Paper', order: 4 }],
  ['sheet.shadow', { label: 'drop shadow', group: 'Paper', order: 5 }],
  ['sheet.shadowBlur', { label: 'shadow blur', group: 'Paper', order: 6 }],
  ['sheet.seed', { label: 'seed', group: 'Paper', order: 7 }],

  // Silhouette — the width, present in every cell (design 2026-09-05 §2.1). `sheet.minDist` /
  // `sheet.maxDist` / `sheet.thickness` / `sheet.tearAmp` / `sheet.midAmp` are gone: the old
  // three-knob hull band and four-knob tear amplitude are replaced outright by `edgeWidth` +
  // `edgeVariance` (spec §12, no compatibility shim).
  ['sheet.edgeWidth', { label: 'edge width', group: 'Silhouette', order: 0 }],
  ['sheet.edgeVariance', { label: 'edge variance', group: 'Silhouette', order: 1 }],

  // Silhouette — shape (design §2.2): `angularity` under `smooth`, the other five under `torn`.
  // `tearMix` belongs here too (ruling R14) — every torn-shape knob does; there is no
  // `Silhouette — torn` group.
  ['sheet.angularity', { label: 'angularity', group: 'Silhouette — shape', order: 0 }],
  ['sheet.looseness', { label: 'edge looseness', group: 'Silhouette — shape', order: 1 }],
  ['sheet.tearFreq', { label: 'tear frequency', group: 'Silhouette — shape', order: 2 }],
  ['sheet.tearAngular', { label: 'tear angularity', group: 'Silhouette — shape', order: 3 }],
  ['sheet.chew', { label: 'chew', group: 'Silhouette — shape', order: 4 }],
  ['sheet.tearMix', { label: 'tear mix', group: 'Silhouette — shape', order: 5 }],

  // Silhouette — finish (design §2.3): the six knobs under `edgeFinish: 'paper'` only.
  ['sheet.deckleWidth', { label: 'deckle width', group: 'Silhouette — finish', order: 0 }],
  ['sheet.deckleLight', { label: 'deckle highlight', group: 'Silhouette — finish', order: 1 }],
  ['sheet.deckleTex', { label: 'deckle texture', group: 'Silhouette — finish', order: 2 }],
  ['sheet.fibers', { label: 'fibre density', group: 'Silhouette — finish', order: 3 }],
  ['sheet.fiberLen', { label: 'fibre length', group: 'Silhouette — finish', order: 4 }],
  ['sheet.tearShadow', { label: 'tear shadow', group: 'Silhouette — finish', order: 5 }],

  // Fold
  ['sheet.facetStrength', { label: 'facet strength', group: 'Fold', order: 0 }],
  ['sheet.lightAngle', { label: 'light angle', group: 'Fold', order: 1 }],
  ['sheet.jitter', { label: 'facet jitter', group: 'Fold', order: 2 }],
  ['sheet.depthDark', { label: 'depth darkening', group: 'Fold', order: 3 }],
  ['sheet.creaseDark', { label: 'crease darkening', group: 'Fold', order: 4 }],
  ['sheet.creaseWidth', { label: 'crease width', group: 'Fold', order: 5 }],

  // Ball
  ['sheet.scrapSize', { label: 'scrap size', group: 'Ball', order: 0 }],
  ['sheet.crumpleCells', { label: 'crumple cell count', group: 'Ball', order: 1 }],
  ['sheet.crumpleBite', { label: 'crumple bite', group: 'Ball', order: 2 }],
  ['sheet.crumpleDepthLo', { label: 'crumple depth (low)', group: 'Ball', order: 3 }],
  ['sheet.crumpleDepthHi', { label: 'crumple depth (high)', group: 'Ball', order: 4 }],
  ['sheet.photoCrumple', { label: 'photo crumple mix', group: 'Ball', order: 5 }],
  ['sheet.photoFibre', { label: 'photo fibre mix', group: 'Ball', order: 6 }],

  // Motion — the library ships `ui.label` on all six; these five keep those labels verbatim.
  // (`motion.debug` is grouped under Debug below, alongside `sheet.debug`.)
  ['motion.ambient', { label: 'ambient', group: 'Motion', order: 0 }],
  ['motion.aoStrength', { label: 'baked AO', group: 'Motion', order: 1 }],
  ['motion.aoGamma', { label: 'AO gamma', group: 'Motion', order: 2 }],
  ['motion.backShade', { label: 'reverse shade', group: 'Motion', order: 3 }],
  ['motion.grain', { label: 'fibre grain', group: 'Motion', order: 4 }],

  // Resolution
  ['sheet.sdfRes', { label: 'field resolution', group: 'Resolution', order: 0 }],

  // Debug — both slots ship a debug knob; the two are unrelated views on different renders.
  ['sheet.debug', { label: 'debug view (2D sheet)', group: 'Debug', order: 0 }],
  ['motion.debug', { label: 'debug view (3D)', group: 'Debug', order: 1 }],
])

export function labelFor(patchKey: string): KnobLabel | undefined {
  return LABELS.get(patchKey)
}
