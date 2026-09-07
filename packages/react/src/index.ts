/**
 * `@paper-crumple/react` — the stable entry point.
 *
 * **This file is append-only for the rest of the run.** Every export is named explicitly rather
 * than star-re-exported, so a neighbouring plan's addition is a clean append and two plans
 * exporting one name collide loudly at the sync point instead of silently shadowing.
 *
 * The convention (spec §7): nothing in this package throws, nothing reaches an error boundary,
 * and no promise this package returns rejects. `error` is a field and `status` is a value to
 * branch on. Cancellation is `ABORTED`, a sentinel, and it never reaches a consumer through an
 * instance's own fields.
 *
 * `useEvent`, the versioned store and the fake stage are deliberately absent. The first two are
 * internal conventions and the third is test scaffolding; nothing in this graph imports
 * `src/testing/`, so none of it reaches `dist`.
 */

// --- P2: the scene (§4) ---
export { PaperScene, useScene } from './scene-context.js'
export type { PaperSceneProps } from './scene-context.js'
export { usePaperScene } from './use-paper-scene.js'
export type { Scene, SceneOptions, SceneSnapshot, SceneStatus } from './scene-types.js'

// --- P3: the crumple (§5, §6) ---
/** One specifier, and deliberately: `crumple.tsx` declares both the component and the interface of
 *  this name, and a single re-export carries both meanings. Split across two modules TypeScript
 *  reports `TS2300: Duplicate identifier`. */
export { Crumple } from './crumple.js'
export type { CrumpleProps } from './crumple.js'
export { useCrumple } from './use-crumple.js'
export type {
  CrumpleFrameStyle,
  CrumpleOptions,
  CrumpleSnapshot,
  CrumpleState,
} from './crumple-types.js'
