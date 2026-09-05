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
  fillHullMask,
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
// `set` caps each sprite at `HULL_CACHE_VARIANTS_PER_SPRITE` (4) variants; a fifth silently evicts
// that sprite's least-recently-used variant, with no error and no warning.
export { HULL_CACHE_VARIANTS_PER_SPRITE, hullCache } from './hull-cache.js'
export type { HullCache, HullCacheKey, HullCacheStats } from './hull-cache.js'

// --- P8: the alpha-mask geometry the sheet fit and the verify jobs read (§8.3, §11) ---
export {
  ALPHA_BBOX_THRESHOLD,
  alphaBbox,
  components,
  holes,
  SHEET_MARGIN_FRAC,
  sheetRect,
} from './mask.js'
export type { AlphaBox, HolesReport } from './mask.js'

// --- design 2026-09-05 §2.1-§2.4: the knob descriptors, composed from edgeShape/edgeFinish/edgeWidthUnit ---
export {
  COMMON_KNOBS,
  defaultsFor,
  descriptorsFor,
  edgeParamsFrom,
  PAPER_FINISH_KNOBS,
  resolveSdfRes,
  SDF_RES_KNOB,
  SMOOTH_KNOBS,
  TORN_KNOBS,
  VARIANCE_KNOB,
  WIDTH_PCT_KNOB,
  WIDTH_PX_KNOB,
} from './paper-knobs.js'
export type { EdgeFinish, EdgeShape, EdgeSpec, EdgeWidthUnit } from '@paper-crumple/core/unstable'

// --- P10: the rect §8.3 derives without a readback ---
export { growBox, scaleBox, sheetRectFromExtent, signedFieldExtent } from './extent.js'

// --- P10: the handle that holds no image data, and §8.6's frozen reserve ---
export { checkReserve, freezeOverscan, handleBytesFor, handleFactsFor } from './handle.js'
export type { OverscanReserve, PaperSheetHandle } from './handle.js'

// --- P10: the tiles (§14). The four baked files live on the ./tiles subpath, never here. ---
// `PaperTileSet` itself is declared in `tile-set.ts` (not `paper-tiles.ts`, which only consumes
// it) — the plan's own table names the wrong module for this one type; the code is authoritative.
export { NEUTRAL_TILE_BYTE, TILE_NAMES } from './paper-tiles.js'
export type { MountedTiles, TileName } from './paper-tiles.js'
export type { PaperTileSet } from './tile-set.js'

// --- P10: the GL halves — the jump-flood field, the blur, and the ported shader (§5.1, §15) ---
export { createSdfBuilder, looseSizeFor, SDF_POOL_SLOTS, sigmaFor } from './gl-sdf.js'
export type {
  BlurFieldOptions,
  BuildFieldOptions,
  Field,
  FieldContract,
  LooseField,
  SdfBuilder,
} from './gl-sdf.js'
export {
  DEBUG_MODES,
  FIBRE_TILE_PX,
  MAX_FOLDS,
  PAPER_FS,
  PAPER_UNIFORMS,
  SHEET_TILE_PX,
} from './paper-shader.js'
export { createPaperRenderer } from './paper-renderer.js'
export type { FrontRenderRequest, PaperRenderer } from './paper-renderer.js'
export { createResampler } from './artwork.js'
export type { ArtworkSlot, ResampleOptions, Resampler } from './artwork.js'

// --- P10: the slot itself (§5.2) ---
export { paperSheet } from './sheet.js'
export type { PaperSheet, PaperSheetOptions } from './sheet.js'
