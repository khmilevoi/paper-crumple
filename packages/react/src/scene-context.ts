import { createContext, createElement, useContext, type Context, type ReactNode } from 'react'
import type { Scene } from './scene-types.js'

export const PaperSceneContext: Context<Scene | null> = createContext<Scene | null>(null)

export interface PaperSceneProps {
  value: Scene
  children?: ReactNode
}

/** A context provider and nothing else — it renders no DOM (§4.2), so SSR emits nothing (§8). */
export function PaperScene({ value, children }: PaperSceneProps): ReactNode {
  return createElement(PaperSceneContext.Provider, { value }, children)
}

/**
 * One frozen module-level object, not a fresh one per call. It is handed to every `useCrumple`
 * that finds no provider, and a fresh identity per render would re-render that whole subtree —
 * §2.1's catastrophe one level up.
 */
const NO_PROVIDER: Scene = Object.freeze({
  status: 'failed',
  stage: null,
  meta: null,
  error: new Error(
    'useScene() was called outside a <PaperScene>. Wrap the subtree in ' +
      '<PaperScene value={usePaperScene(...)}>, or pass an explicit `scene` option.',
  ),
  warnings: Object.freeze([]) as readonly Error[],
  lost: false,
  generation: 0,
  knobEpoch: 0,
  play: async () => ({ started: [], skipped: [], failed: [], completed: false }),
  stop: () => {},
})

/**
 * Outside a provider this returns a permanently-`failed` scene carrying an Error rather than
 * throwing. Nothing in this package throws (§7).
 */
export function useScene(): Scene {
  return useContext(PaperSceneContext) ?? NO_PROVIDER
}
