import { observeReactivity } from '../reactivity-observers.mjs'
import type { BlitStage, View } from './deps.js'

export type ReactivityMode = 'raw' | 'semantic' | 'progress'
export const reactivityModes: readonly ReactivityMode[] = ['raw', 'semantic', 'progress']

export async function observeSmoothReactivity(
  mode: ReactivityMode,
  stage: BlitStage,
  cells: readonly { view: View; canvas: HTMLCanvasElement; source: string }[],
) {
  // Preserve the original rows' module heap; each new mode loads the same runtime in setup.
  const { bind, context, notify, wrap } =
    await import('../../../packages/reatom/node_modules/@reatom/core/dist/index.js')
  const { reatomScene } = await import('../../../packages/reatom/dist/index.js')
  return observeReactivity(mode, stage, cells, { bind, context, notify, wrap, reatomScene })
}
