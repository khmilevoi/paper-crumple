/**
 * `@paper-crumple/motion` — the stable entry point.
 *
 * **This file is append-only for the rest of the run.** Every export is named explicitly rather
 * than star-re-exported, so a neighbouring plan's addition is a clean append and two plans
 * exporting one name collide loudly at the sync point instead of silently shadowing.
 *
 * This subpath is the **format tooling** (spec 3.2): the CRMP v1 parser, the two codecs, the
 * offset arithmetic and the bucket fit — kilobytes, and everything an author of a custom bake
 * needs. The built-in packs are megabytes and live one per `./packs/<bucket>` subpath, so
 * importing this entry never drags someone else's assets into a bundle.
 *
 * The convention (spec 10): functions return `Error | T`, callers narrow with `instanceof Error`
 * and exit early. Nothing in this package throws.
 */

// --- P7: the format, and the arithmetic a writer computes from (§9) ---
export {
  HEADER_BYTES,
  MAGIC,
  MAX_VERTS_PER_SIDE,
  VERSION,
  align4,
  frameLayout,
  packOffsets,
} from './format.js'
export type { FrameLayout, PackOffsets } from './format.js'

// --- P7: the codecs (§9, §11) ---
export { fromHalf, toHalf } from './half.js'
export { decodeOct, encodeOct, snorm8 } from './oct.js'

// --- P7: the parser, the frame accessors and the key-frame rules (§9.1, §9.2) ---
export { decodeFrame, frameBytes, parsePack, setKeyFrames } from './pack.js'
export type { DecodedFrame, Pack, PackFrame, PackManifest, PackManifestFrame } from './pack.js'

// --- P7: buckets and the fit (§5.3, §9.3) ---
export { BUCKETS, MAX_STRETCH, STRETCH_TOLERANCE, fitSheet, pickBucket } from './buckets.js'
export type { Bucket, SheetFit } from './buckets.js'

// --- P7: the one-shot load, with an explicit binUrl (§9.2, §14) ---
export { loadPack } from './load.js'
export type { LoadPackOptions } from './load.js'

// --- P11: the 3D sheet program and its attribute layout (§3.1, §8.4) ---
export { ATTR, DEBUG_VIEWS, SHEET_FS, SHEET_VS } from './shaders.js'

// --- P11: the motion knob registry (§6.7) ---
export { FIBRE_TILE_PX, MOTION_KNOBS } from './knobs.js'
export type { MotionLookKnobs } from './knobs.js'

// --- P11: what a pack module subpath default-exports (§3.2, §14) ---
export type { PackModule } from './pack-module.js'

// --- P11: the shared per-bucket pack store (§5.3) ---
export { createPackStore } from './pack-store.js'
export type { PackStore, PackStoreOptions } from './pack-store.js'

// --- P11: twelve preconfigured VAOs per bucket (§8.4) ---
export { createSheetMesh } from './mesh.js'
export type { SheetMesh } from './mesh.js'

// --- P11: the MotionSource itself (§5.3) ---
export { bakedMotion } from './source.js'
export type { BakedClip, BakedFit, BakedMotionOptions } from './source.js'
