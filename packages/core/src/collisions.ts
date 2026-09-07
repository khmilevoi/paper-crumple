import type { RunOwner } from './run.js'

/**
 * # §4.4's one rule, and the report that keeps skipping audible
 *
 * > Collisions are decided by scope, not by method. Within a scope the latest call wins and
 * > supersedes the live run; across scopes the narrower scope wins.
 *
 * Pure functions, tested as tables rather than through a stage: a skip reason is a decision and
 * not a side effect, and a stage is a wave-4 object. P9 drives these and performs what they say.
 */

export type CollisionOutcome = 'start' | 'supersede' | 'skip'

/**
 * ```
 * stage.play             vs  view-owned run     → skip, reported with reason 'busy'
 * stage.play             vs  stage-owned run    → supersede (tie)
 * view.play / crumpleTo  vs  anything           → supersede
 * ```
 *
 * "Skip" is not a second rule sitting awkwardly beside "supersede"; it is what latest-wins looks
 * like from the losing side when a wide call meets a run owned by a narrow one. The tie is the
 * case a naive "skip if busy" gets wrong: re-triggering a grid loader must restart it rather than
 * silently do nothing.
 */
export function decideCollision(caller: RunOwner, live: RunOwner | null): CollisionOutcome {
  if (live === null) return 'start'
  if (caller === 'view') return 'supersede'
  return live === 'stage' ? 'supersede' : 'skip'
}

/**
 * The same scope principle applied to cancellation, so that a broadcast stop cannot silently kill
 * a user-initiated garment swap. `stage.stop()` stops only stage-owned runs;
 * `stage.stop({ all: true })` stops everything.
 */
export function decideStop(caller: RunOwner, live: RunOwner | null, all = false): boolean {
  if (live === null) return false
  if (all || caller === 'view') return true
  return live === 'stage'
}

export type SkipReason = 'busy' | 'no-sprite' | 'cancelled' | 'disposed'

/** What P9 knows about one view at the moment `stage.play()` snapshots its eligible set. */
export interface StagePlayCandidate<V> {
  readonly view: V
  readonly tag?: string
  readonly hasSprite: boolean
  readonly disposed: boolean
  readonly liveOwner: RunOwner | null
}

export interface StagePlaySkip<V> {
  readonly view: V
  readonly tag?: string
  readonly reason: SkipReason
}

export interface StagePlayEligibility<V> {
  /** In registration order, which is the order `stage.views` is snapshotted in. */
  readonly start: readonly StagePlayCandidate<V>[]
  readonly skipped: readonly StagePlaySkip<V>[]
}

const withTag = <V, T extends object>(view: V, tag: string | undefined, rest: T): T & { view: V } =>
  ({ view, ...(tag === undefined ? {} : { tag }), ...rest }) as T & { view: V }

/**
 * The eligible set is **fixed at the call** — a view created while a `stage.play()` is in flight
 * does not join it, so the resolution condition is decidable.
 *
 * One view gets one reason, and the order of the checks is the order of severity: a disposed view
 * is disposed whether or not it also has no sprite, and a view with no sprite has nothing to play
 * whether or not something is live on it.
 */
export function planStagePlay<V>(
  candidates: readonly StagePlayCandidate<V>[],
): StagePlayEligibility<V> {
  const start: StagePlayCandidate<V>[] = []
  const skipped: StagePlaySkip<V>[] = []
  for (const c of candidates) {
    const reason: SkipReason | null = c.disposed
      ? 'disposed'
      : !c.hasSprite
        ? 'no-sprite'
        : decideCollision('stage', c.liveOwner) === 'skip'
          ? 'busy'
          : null
    if (reason === null) start.push(c)
    else skipped.push(withTag(c.view, c.tag, { reason }))
  }
  return { start, skipped }
}

/** What one started chain reported back when it settled. */
export type ChainOutcome =
  | { kind: 'completed' }
  /** Superseded or stopped: it reached neither `to` nor an error. */
  | { kind: 'incomplete' }
  | { kind: 'failed'; error: Error }
  /** The `stage.play` signal fired before this view's staggered start. */
  | { kind: 'cancelled' }

/**
 * §4.4's report. **`stage.play` keeps this and is not a `Run`** (amendment 22, which is
 * view-scoped): the report is what "skipping is never silent" rests on, and a `Run` cannot carry
 * a per-view skip reason — one settled value cannot say that view 7 was busy while view 12 had no
 * sprite. A broadcast also has no single run to stop; its cancellation is `stage.stop()`.
 */
export interface StagePlayReport<V> {
  started: V[]
  skipped: Array<{ view: V; tag?: string; reason: SkipReason }>
  failed: Array<{ view: V; tag?: string; error: Error }>
  completed: boolean
}

/**
 * `outcomes` is index-correlated with `eligibility.start`. A missing entry is treated as
 * `cancelled` rather than as success, so a caller that lost a chain reports it instead of
 * silently shortening the account.
 *
 * **The three arrays partition the eligible set**, and a view appears in exactly one of them:
 * §4.2's rule that "the return value is the complete account" is only checkable if
 * `started.length + skipped.length + failed.length` equals the number of eligible views, and a
 * view that started and then failed is more usefully reported under its failure than counted
 * twice.
 *
 * `completed` lifts §7.1's `completed = reachedTo && noErrorEmitted && notSuperseded` from one run
 * to the broadcast: a skip is the broadcast's version of not reaching `to`, a failure is
 * `noErrorEmitted` violated, and an `incomplete` chain is `notSuperseded` violated. A broadcast
 * over zero eligible views is **not** completed — reporting `true` for a wave that never happened
 * is the one answer a consumer cannot act on.
 */
export function stagePlayReport<V>(
  eligibility: StagePlayEligibility<V>,
  outcomes: readonly ChainOutcome[],
): StagePlayReport<V> {
  const started: V[] = []
  const skipped: Array<{ view: V; tag?: string; reason: SkipReason }> = eligibility.skipped.map(
    (s) => withTag(s.view, s.tag, { reason: s.reason }),
  )
  const failed: Array<{ view: V; tag?: string; error: Error }> = []
  let everyChainCompleted = true

  eligibility.start.forEach((c, i) => {
    const outcome: ChainOutcome = outcomes[i] ?? { kind: 'cancelled' }
    if (outcome.kind === 'completed') {
      started.push(c.view)
      return
    }
    everyChainCompleted = false
    if (outcome.kind === 'failed') failed.push(withTag(c.view, c.tag, { error: outcome.error }))
    else if (outcome.kind === 'cancelled') {
      skipped.push(withTag(c.view, c.tag, { reason: 'cancelled' as SkipReason }))
    } else started.push(c.view)
  })

  return {
    started,
    skipped,
    failed,
    completed:
      eligibility.start.length > 0 &&
      everyChainCompleted &&
      skipped.length === 0 &&
      failed.length === 0,
  }
}
