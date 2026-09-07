import type { Events, View } from '@paper-crumple/core'
import type { CrumpleSnapshot } from './crumple-types.js'
import { frameStyleFor } from './frame-style.js'

/**
 * The mutable record the snapshot is read out of. One per hook instance, never replaced — the
 * same shape `usePaperScene` uses for the scene. Nothing here is handed to a consumer.
 */
export interface CrumpleCore {
  view: View | null
  /** The spriteKey last asked for. Survives a scene rebuild: it is the consumer's prop. */
  requested: string | null
  error: Error | null
  parked: boolean
  /** The resolved ball index the current run reported at `start`. Only a swap carries one. */
  via: number | undefined
  frameTo: number | undefined
  /** Which (view, key) pair the sprite driver has already acted on. */
  synced: { view: View; key: string } | null
}

export function createCrumpleCore(): CrumpleCore {
  return {
    view: null,
    requested: null,
    error: null,
    parked: false,
    via: undefined,
    frameTo: undefined,
    synced: null,
  }
}

/**
 * Re-read the getters into one snapshot. The caller caches it: `view.state`, `view.pose` and
 * `view.frame` are getters, so an object literal built inside `getSnapshot` would have a new
 * identity every call and `useSyncExternalStore` would loop forever (§5.5).
 */
export function readCrumple(core: CrumpleCore): CrumpleSnapshot {
  const view = core.view
  const frame = view?.frame ?? null
  return {
    state: view?.state ?? 'detached',
    parked: core.parked,
    pose: view?.pose ?? 0,
    shown: view?.sprite?.key ?? null,
    requested: core.requested,
    error: core.error,
    frame,
    frameStyle: frameStyleFor(frame, core.frameTo),
    view,
  }
}

/**
 * `error` reports the last settled run and is cleared when the next one STARTS — not on `end` —
 * so a consumer rendering a rollback notice from `error !== null` sees it removed the moment the
 * user's next interaction begins rather than a fold later (§5.1).
 */
export function onRunStart(core: CrumpleCore, e: Events['start']): void {
  core.error = null
  core.parked = false
  core.via = e.via
}

/** A swap's `start` reports `via`, the resolved ball index, and the run is parked from the step
 *  whose `pose === via`. `crumpling.ball` itself is set between two emissions and is never
 *  observable, which is why the binding maintains this rather than reading `view.state`. */
export function onRunStep(core: CrumpleCore, e: Events['step']): void {
  if (core.via !== undefined && e.pose === core.via) core.parked = true
}

/** A park cut short by `stop()`, by supersession or by `dispose()` goes cancel → finish → end and
 *  the descent stepper is never created, so there is no next `step` to clear it. */
export function onRunEnd(core: CrumpleCore): void {
  core.parked = false
  core.via = undefined
}
