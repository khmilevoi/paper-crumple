/**
 * Everything the GL bench imports from the library, in one place.
 *
 * `tools/` is outside the pnpm workspace on purpose (`tests/workspace-shape.test.ts`), so the bare
 * `@paper-crumple/*` specifiers do not resolve from here. The bench measures the BUILT packages
 * through their dist entry points instead — the same files the playground consumes — which is why
 * `pnpm bench:gl` needs core, paper and motion built first. Vite resolves the packages' own
 * `@paper-crumple/core` imports through pnpm's symlinks to the same real files, so there is one
 * module instance of core in the page and `ABORTED` is one symbol.
 */
export { ABORTED, GlError, isAborted, paperStage } from '../../../packages/core/dist/index.js'
export type {
  DrawTarget,
  MotionKnobs,
  Rect,
  SheetFront,
  Size,
  Sprite,
  View,
} from '../../../packages/core/dist/index.js'
export {
  createGlContext,
  createGpuTimer,
  createScratchPools,
  drawTargetFor,
  FULLSCREEN_VS,
  GL_ATTRIBUTES,
  sdfResFor,
  uploadBytes,
} from '../../../packages/core/dist/unstable.js'
export type {
  CoreGlContext,
  GlContext,
  GpuTimer,
  ScratchPools,
  Target,
  Texture,
} from '../../../packages/core/dist/unstable.js'
export {
  createPaperRenderer,
  createResampler,
  createSdfBuilder,
  defaultsFor,
  descriptorsFor,
  PAPER_FS,
  paperSheet,
  SDF_POOL_SLOTS,
  sigmaFor,
} from '../../../packages/paper/dist/index.js'
export type {
  Field,
  LooseField,
  MountedTiles,
  PaperEdgeMode,
} from '../../../packages/paper/dist/index.js'
export { bakedMotion, MOTION_KNOBS } from '../../../packages/motion/dist/index.js'
export type { BakedClip, BakedFit, MotionLookKnobs } from '../../../packages/motion/dist/index.js'
export { default as pack1x1 } from '../../../packages/motion/dist/packs/1x1.js'
export { default as pack2x3 } from '../../../packages/motion/dist/packs/2x3.js'
export { default as pack3x2 } from '../../../packages/motion/dist/packs/3x2.js'
