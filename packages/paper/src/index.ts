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

// --- P8: band-limited marching squares on a three-slot scratch cache (§8.2, §8.2.1) ---
export {
  CANDIDATE_BAND,
  CONTOUR_SCRATCH_SLOTS,
  contourScratchStats,
  extractContours,
  releaseContourScratch,
  signedArea,
} from './contours.js'

// --- P8: Douglas-Peucker simplification (§8.2) ---
export { simplifyLoop, simplifyPolyline } from './simplify.js'

// --- P8: the seeded randomness the outline is deterministic in (§8.2.1) ---
export { makeRandom } from './random.js'

// --- P8: the packed hull polygon the handle retains (§8.5) ---
export {
  HULL_USE_ALPHA,
  hullBuffers,
  hullBytes,
  hullComponent,
  hullComponentCount,
  hullExtent,
  hullVertexCount,
  packPolygons,
} from './hull-shape.js'
export type { HullShape, PackedHull, UseAlphaHull } from './hull-shape.js'

// --- P8: the hull build, its measurement and its rasterisation (§8.2, §8.2.1) ---
export {
  buildHull,
  DISTANCE_WAVELENGTH_PX,
  measureHull,
  rasterizeHull,
  toleranceFor,
  TOL_ANGULAR_PX,
  TOL_SMOOTH_PX,
} from './hull.js'
export type {
  BuildHullOptions,
  HullBuild,
  HullCanvas,
  HullMeasure,
  HullRasterContext,
  HullStats,
} from './hull.js'

// --- P8: the hull cache and its invalidate-by-key entry point (§8.2.1, §18 amendment 10) ---
export { HULL_CACHE_VARIANTS_PER_SPRITE, hullCache } from './hull-cache.js'
export type { HullCache, HullCacheKey, HullCacheStats } from './hull-cache.js'
