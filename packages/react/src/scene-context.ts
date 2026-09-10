import { createContext, createElement, useContext, type Context, type ReactNode } from 'react'
import type { Scene } from './scene-types.js'

/**
 * `Scene<unknown>` and not `Scene<M>`: React has one context object for the whole tree and it
 * cannot be generic. `Scene<M>` is covariant in `M` — `meta` is a readonly field — so any scene
 * goes in without a cast, and `useScene<M>()` asserts on the way out what the caller named.
 */
export const PaperSceneContext: Context<Scene<unknown> | null> =
  createContext<Scene<unknown> | null>(null)

export interface PaperSceneProps<M = undefined> {
  value: Scene<M>
  children?: ReactNode
}

/** A context provider and nothing else — it renders no DOM (§4.2), so SSR emits nothing (§8). */
export function PaperScene<M = undefined>({ value, children }: PaperSceneProps<M>): ReactNode {
  return createElement(PaperSceneContext.Provider, { value }, children)
}

/**
 * One frozen module-level object, not a fresh one per call. It is handed to every `useCrumple`
 * that finds no provider, and a fresh identity per render would re-render that whole subtree —
 * §2.1's catastrophe one level up.
 */
const NO_PROVIDER: Scene<unknown> = Object.freeze({
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
 * throwing. Nothing in this package throws (§7). The assertion is the erased-context trade
 * described on `PaperSceneContext`: the caller names `M`, React cannot remember it.
 */
export function useScene<M = undefined>(): Scene<M> {
  return (useContext(PaperSceneContext) ?? NO_PROVIDER) as Scene<M>
}
