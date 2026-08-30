/**
 * `@paper-crumple/core/unstable` — the slot-authoring surface (§14).
 *
 * A consumer annotating `const s: SheetRenderer = paperSheet()` imports from the root; a third
 * party *building* a slot needs this subpath and knows it. Importing from `/unstable` shows up in
 * a diff and greps cleanly, which is a stronger signal than a JSDoc tag TypeScript does not
 * enforce.
 *
 * **This file is append-only for the rest of the run**, on the same terms as `index.ts`. P6
 * appends `compile`, `createTarget` and the GPU timer.
 */

export { taggedError } from './errors.js'
export type {
  CrumpleErrorInit,
  ErrorProps,
  NoProps,
  TaggedError,
  TaggedErrorConstructor,
} from './errors.js'
export type { DrawScope, GlContext } from './gl.js'
export type { Program, Target, Texture, TextureDesc } from './forward.js'
export type { SheetHandle } from './sheet.js'
export type { MotionClip, MotionFit } from './motion.js'

// --- P3: the knob utilities a slot computes with (§6.3, §6.4, §6.2) ---
export { hexToRgb, isHex } from './color.js'
export { atOrAbove, hullCacheKey, maxInvalidation } from './invalidation.js'
export { pxScale, scaleKnob } from './knobs.js'

// P5 — the normative resample reference (spec 7.4.1). The GLSL ES 3.00 twin is byte-identical to
// this by construction; changing either without the other breaks a cross-language contract.
export {
  axisPlan,
  idiv,
  identityResample,
  resampleAreaExact,
  RESAMPLE_MAX_ACCUMULATOR,
  RESAMPLE_Q,
  RESAMPLE_T,
  roundDiv,
} from './resample.js'
export type { AxisWindow, ResampleSource } from './resample.js'

// P5 — resolution and derived overscan (spec 7.4.3, 8.6).
export { SDF_RES_MAX, SDF_RES_MIN, sdfResFor, SIZE_QUANTUM } from './resolution.js'
export {
  artworkLongSide,
  ASPECT_BOUND,
  checkGuardBand,
  EDGE_SLOP_REFERENCE_PX,
  exactFrontLongSide,
  GUARD_BAND_INNER,
  GUARD_BAND_OUTER,
  KNOB_REFERENCE_PX,
  overscanFor,
  overscanFromRadius,
  overscanRadius,
} from './overscan.js'
export type { EdgeMode, EdgeParams, GuardCheckInput } from './overscan.js'

// P5 — the byte accounting (spec 8.1, 8.5, 8.9).
export {
  cpuSdfBytes,
  fieldBytes,
  frontBytes,
  FRONT_BYTES_PER_TEXEL,
  handleBytes,
  poolABytes,
  poolBBytes,
  scratchBytes,
} from './bytes.js'
export type { CountedBuffer, HandleFacts, ScratchBytes, ScratchRequest } from './bytes.js'
