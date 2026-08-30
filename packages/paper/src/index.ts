/**
 * `@paper-crumple/paper` — the sheet renderer's public surface.
 *
 * **This file is append-only for the rest of the run.** Every export is named explicitly rather
 * than star-re-exported, so a neighbouring plan's addition is a clean append and two plans
 * exporting one name collide loudly at the sync point instead of silently shadowing.
 *
 * Decision 2 of the spec is why the CPU primitives are exported alongside the slot rather than
 * hidden behind it: "layered — a high-level effect on top, but every primitive exported
 * separately".
 */

// --- P8: the signed distance field, moved in from the spike's tools/sdf.mjs (§3.3) ---
export {
  computeSdf,
  decodeDistance,
  decodeField,
  downsampleField,
  edt1d,
  encodeDistance,
  encodeField,
  SDF_INF,
  signedDistanceField,
  squaredEdt,
  targetDimensions,
} from './sdf.js'
export type { ComputeSdfOptions, SdfResult } from './sdf.js'

// --- P8: reading a signed field (§8.2) ---
export type { Loop, Point } from './point.js'
export { cpuSdfFromAlpha, fieldGradient, moveToDistance, sampleField } from './field.js'
