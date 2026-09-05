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
  GUARD_EPSILON_REFERENCE_PX,
  GUARD_MARGIN_G,
  guardMarginsFor,
  KNOB_REFERENCE_PX,
  marginFractionFor,
  overscanFor,
  overscanFromRadius,
  overscanRadius,
  RADIUS_CAP_REFERENCE_PX,
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

// --- P6: the GL foundation (§5.1, §7.3, §7.4.1, §8.1, §8.5.3) ---

// The context itself. `GlContext`, `DrawScope`, `Program`, `Target`, `Texture` and `TextureDesc`
// are already exported above by P2 and are not re-exported here; P6 gave the last four their
// members in `./gl-resources.ts` and `./forward.ts` re-exports them from there.
export { createGlContext, GL_ATTRIBUTES } from './gl-context.js'
export type { CoreGlContext, GlContextOptions } from './gl-context.js'

// The resource tables §8.7 decides, so a slot prices a texture the way the budget does.
export {
  drawTargetFor,
  FLOAT_FORMATS,
  INTEGER_FORMATS,
  TEXTURE_FORMAT_BYTES,
  TEXTURE_FORMAT_GL,
  textureBytes,
  uploadBytes,
} from './gl-resources.js'
export type { GlFormatNames, TextureFormat } from './gl-resources.js'

// §8.5.3's probe, exported because a slot may want to re-run it against its own context.
export { probeExactByteFetch } from './gl-probe.js'

// The GPU timer of `caps.timer`. `null` when the extension is absent; there is no stub.
export { createGpuTimer } from './gl-timer.js'
export type { GpuTimer } from './gl-timer.js'

// §8.1's two pools. Their sizing laws are P5's (`poolABytes`, `poolBBytes`, already above);
// the pools themselves, their slots, their lifetimes and Pool B's idle interval are P6's.
export { createScratchPools, POOL_B_IDLE_MS } from './gl-pools.js'
export type {
  ArtworkPool,
  ScratchPools,
  ScratchPoolsOptions,
  StagingPool,
  TextureFactory,
} from './gl-pools.js'

// The GLSL ES 3.00 sources. `RESAMPLE_FS` is the byte-identical twin of `identityResample`
// above; a slot that runs it gets the reference's output and a slot that edits it breaks a
// cross-language contract.
export { EXACT_BYTE_FETCH_FS, FULLSCREEN_VS, RESAMPLE_FS, RESAMPLE_UNIFORMS } from './gl-shaders.js'

// --- P9: what a slot author needs from the stage side (§4.0.2, §8.4) ---
export { gradeAttributes } from './surface-grade.js'
export type { AttributeGrade } from './surface-grade.js'
export { batchBySortKey } from './draw-batch.js'

// --- S1: the platform yield (§8.10) — what a slot's asynchronous readback polls its fence on;
// S9 added its one option, the back-off delay a long fence wait polls on ---
export { nextTurn } from './next-turn.js'
export type { YieldOptions } from './next-turn.js'

// --- P7: the cancellable wait on a shared promise (§5.2 amendment, §10.5) — what a slot's
// asynchronous path races its program-readiness wait with ---
export { raceAbort } from './abort.js'
