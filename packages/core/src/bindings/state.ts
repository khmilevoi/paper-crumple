import type { Events, View } from '../index.js'
import type { CrumplePending, CrumpleSnapshot, CrumpleState, CrumpleStatus } from './types.js'

/**
 * The mutable record the snapshot is read out of. One per hook instance, never replaced — the
 * same shape `usePaperScene` uses for the scene. Nothing here is handed to a consumer.
 */
export interface CrumpleCore {
  view: View | null
  /** The spriteKey last asked for. Survives a scene rebuild: it is the consumer's prop. */
  requested: string | null
  /** The open request, or `null` when idle. Set when one opens and cleared at exactly one place
   *  in the hook — see `settle` in `use-crumple.ts` (§2.1). */
  pending: CrumplePending | null
  error: Error | null
  parked: boolean
  /** The resolved ball index the current run reported at `start`. Only a swap carries one. */
  via: number | undefined
  /** Which (view, key) pair the sprite driver has already acted on. */
  synced: { view: View; key: string } | null
}

export function createCrumpleCore(): CrumpleCore {
  return {
    view: null,
    requested: null,
    pending: null,
    error: null,
    parked: false,
    via: undefined,
    synced: null,
  }
}

/**
 * What the versioned store holds. `frameStyle` and `artworkStyle` are NOT part of it: both are
 * derived from the published `frame` and the `frameTo` PROP in the hook's render (§2.7, §2.3),
 * because a prop mirrored into this record through an effect lags its own commit by one bump —
 * the lag that left the first entrance measuring 0 × 0 (§9.1).
 */
export type CrumpleReading = Omit<CrumpleSnapshot, 'frameStyle' | 'artworkStyle'>

/**
 * Precedence, and each step earns its place (§2.5):
 *
 * 1. No view is `detached` before anything else can be said.
 * 2. An open request wins over everything below it — `error` is cleared at `start`, not at `end`,
 *    and the degraded path has no `start` at all, so a stale rollback error can still be standing
 *    while the next request acquires. The request is the more informative of the two.
 * 3. `rolled-back` is `error !== null && requested !== shown`: the prop says B, the canvas shows A.
 * 4. A live run with no request behind it is a `play()` the consumer started.
 * 5. Then the two resting states.
 */
function statusOf(core: CrumpleCore, state: CrumpleState, shown: string | null): CrumpleStatus {
  if (state === 'detached') return 'detached'
  const pending = core.pending
  if (pending !== null) {
    if (pending.phase === 'acquiring') return 'acquiring'
    if (pending.phase === 'swapping') return 'swapping'
    return 'playing'
  }
  if (core.error !== null && core.requested !== shown) return 'rolled-back'
  if (state !== 'idle' && state !== 'disposed') return 'playing'
  if (shown === null) return 'empty'
  return 'shown'
}

/**
 * Re-read the getters into one reading. The caller caches it: `view.state`, `view.pose` and
 * `view.frame` are getters, so an object literal built inside `getSnapshot` would have a new
 * identity every call and `useSyncExternalStore` would loop forever (§5.5).
 */
export function readCrumple(core: CrumpleCore): CrumpleReading {
  const view = core.view
  const sprite = view?.sprite ?? null
  const state: CrumpleState = view?.state ?? 'detached'
  const shown = sprite?.key ?? null
  return {
    state,
    status: statusOf(core, state, shown),
    parked: core.parked,
    pose: view?.pose ?? 0,
    shown,
    sprite,
    requested: core.requested,
    pending: core.pending,
    error: core.error,
    frame: view?.frame ?? null,
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
 *  whose `pose === via` until the NEXT step moves off it. Written on every step rather than
 *  latched: only `start` and `end` cleared it before, so a spinner branched on `parked` — the
 *  pattern USAGE §5 documents — stayed up for the whole descent (§0.2). `crumpling.ball` itself is
 *  set between two emissions and is never observable, which is why the binding maintains this
 *  rather than reading `view.state`. */
export function onRunStep(core: CrumpleCore, e: Events['step']): void {
  core.parked = core.via !== undefined && e.pose === core.via
}

/** A park cut short by `stop()`, by supersession or by `dispose()` goes cancel → finish → end and
 *  the descent stepper is never created, so there is no next `step` to clear it. */
export function onRunEnd(core: CrumpleCore): void {
  core.parked = false
  core.via = undefined
}
