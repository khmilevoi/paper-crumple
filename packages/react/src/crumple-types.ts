import type { Events, Fit, PinFor, SpriteSource } from '@paper-crumple/core'
import type { Entrance, ReducedMotion, CrumpleSettleEvent } from '@paper-crumple/core/bindings'
import type { Scene, StageErrorListener } from './scene-types.js'
export type {
  Entrance,
  ReducedMotion,
  CrumpleState,
  CrumpleStatus,
  CrumpleFrameStyle,
  CrumpleArtworkStyle,
  CrumplePending,
  CrumpleSettleEvent,
  CrumpleSnapshot,
  CrumpleMethods,
} from '@paper-crumple/core/bindings'

export type CrumpleOptions<S extends SpriteSource> = {
  spriteKey: string
  src: S
  /** Defaults to `useScene()`. The escape hatch for two scenes on one page (§4.2). */
  scene?: Scene
  /**
   * Fixed at `stage.view()` and not changeable afterwards, which is why it is a hook option and
   * never a prop (§2). Under §2.1's stable `ref` the creating callback is not re-invoked, so a
   * changed `fit` is silently ignored until the view is rebuilt.
   */
  fit?: Fit
  /** Fixed at `stage.view()` too; `View.tag` is a read-only accessor. */
  tag?: string
  entrance?: Entrance
  /**
   * Wall time in MILLISECONDS for the whole traversal — not a multiplier. `swapPlan` treats
   * `duration` as the total and rescales the authored cadence into it, so
   * `play('flat', 'ball', { duration: 585 })` finishes at t=585. Applies to every run this hook
   * starts: the entrance, the swap, and `play()` unless that call passes its own.
   */
  duration?: number
  /** The CSS long side the ARTWORK should hold on screen. Absent — the default — means the hook
   *  reports `frame` and applies nothing. */
  frameTo?: number
  reducedMotion?: ReducedMotion
  onStart?: (e: Events['start']) => void
  onEnd?: (e: Events['end']) => void
  /** A `StageEvent`, not an `Events` member — errors never reach a view's own bus (§5.5). */
  onError?: StageErrorListener
  /**
   * Exactly once per request that reaches an outcome — animated end, degraded show, rollback.
   * Never for a superseded or unmounted request (§2.1). This, and not `onEnd`, is what a consumer
   * branches a "swap finished" on: the reduced path emits no `end` at all.
   */
  onSettle?: (e: CrumpleSettleEvent) => void
} & PinFor<S>
