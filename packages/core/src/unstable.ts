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
