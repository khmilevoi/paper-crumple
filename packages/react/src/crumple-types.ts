import type {
  Events,
  Fit,
  PinFor,
  PlayOptions,
  PlayResult,
  PoseRef,
  Run,
  Sprite,
  SpriteSource,
  SwapResult,
  View,
  ViewFrame,
  ViewState,
} from '@paper-crumple/core'
import type { Scene, StageErrorListener } from './scene-types.js'

/** `'flat'` is the default: `show()` with no animation, which is the state `stage.mount` leaves. */
export type Entrance = 'flat' | 'uncrumple'

export type ReducedMotion = 'auto' | 'off'

/** `'detached'` is what `state` reads while no view exists (§5.2). */
export type CrumpleState = ViewState | 'detached'

/**
 * One discriminant to branch a UI on, derived and never stored (§2.5). It overlaps `state`
 * deliberately: `state` is core's view machine and cannot express the acquire window — where
 * nothing is playing and nothing has arrived — nor the rollback outcome, which survives `end`.
 */
export type CrumpleStatus =
  'detached' | 'empty' | 'acquiring' | 'shown' | 'playing' | 'swapping' | 'rolled-back'

/**
 * `frame` already scaled by `frameTo` into the four CSS numbers §6 writes on the wrapper. The
 * arithmetic lives in the hook and not in the component because §2 puts logic in the hook, and
 * because the component is handed only the instance — it never sees `frameTo`.
 */
export interface CrumpleFrameStyle {
  readonly width: string
  readonly height: string
  readonly left: string
  readonly top: string
}

/**
 * The ARTWORK's own rectangle under the same one scale `frameStyle` uses — what a layout reserves
 * for the picture, as opposed to the paper box the wrapper takes (§2.3). Same `null` convention:
 * absent `frameTo` or absent `frame` means the hook applies nothing.
 */
export interface CrumpleArtworkStyle {
  readonly width: string
  readonly height: string
}

/**
 * The request for the current (view, spriteKey) until it settles; `null` when idle (§2.1).
 *
 * `run` is the typed handle — it carries `stop()` and the settled result — and wraps core's
 * untyped `View.run`. The three phases are the three shapes a request takes: `acquiring` covers
 * the entrance, the degraded swap and a joined `add`, where nothing is playing yet; `entering` is
 * an uncrumple entrance; `swapping` is a `swapTo` or a joined `crumpleTo`.
 *
 * This is the field that makes `requested`, `shown` and `error` safe to read together: `shown`
 * moves at the ball, mid-fold, and always has (§0.1) — `pending` is what tells a consumer the
 * request behind it has not finished.
 */
export type CrumplePending =
  | { readonly key: string; readonly phase: 'acquiring'; readonly run: null }
  | { readonly key: string; readonly phase: 'entering'; readonly run: Run<PlayResult> }
  | { readonly key: string; readonly phase: 'swapping'; readonly run: Run<SwapResult> }

/**
 * What `onSettle` is handed. `reduced` reports whether the reduced-motion accommodation applied to
 * this request — the value of the media query on the path it took — not whether an animation ran:
 * a `entrance: 'flat'` mount with the OS setting off settles `reduced: false` having animated
 * nothing.
 */
export interface CrumpleSettleEvent {
  readonly key: string
  readonly error: Error | null
  readonly reduced: boolean
}

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

/** The reactive half of a `Crumple`, rebuilt as one cached object per store bump (§5.5). */
export interface CrumpleSnapshot {
  readonly state: CrumpleState
  readonly status: CrumpleStatus
  /** The swap is parked at the ball, waiting on its target. Maintained by the binding, because
   *  `crumpling.ball` is set between two emissions and is never observable (§5.5). */
  readonly parked: boolean
  /** 0 while detached — `'flat'`, the pose a view is born at. */
  readonly pose: number
  readonly shown: string | null
  /** The shown sprite itself, read in the same pass as `shown` (§2.4). After core's `adopt` at
   *  the ball `view.sprite` is already the target while the previous snapshot's `shown` still
   *  names the outgoing one; reading both here is what closes that skew. */
  readonly sprite: Sprite | null
  readonly requested: string | null
  readonly pending: CrumplePending | null
  readonly error: Error | null
  readonly frame: ViewFrame | null
  readonly frameStyle: CrumpleFrameStyle | null
  readonly artworkStyle: CrumpleArtworkStyle | null
  /** Raw, so an unforeseen scenario stays reachable. */
  readonly view: View | null
}

/** The methods a `Crumple` carries on top of its snapshot. Merged into the interface in
 *  `crumple.tsx`, which is also where the component of the same name lives. */
export interface CrumpleMethods {
  /** Identity-stable per §2.1, and that is load-bearing: React re-invokes a callback ref whose
   *  identity changed, which here means disposing the view and rebuilding it every render. */
  readonly ref: (el: HTMLCanvasElement | null) => void
  /** `null` while detached. The `Run` is returned rather than swallowed: it is the only handle
   *  that carries `stop()` and the settled result. Never `async` — `start` is emitted
   *  synchronously inside `view.play`, and a wrapper is exactly where that is lost. */
  play(from: PoseRef, to: PoseRef, o?: PlayOptions): Run<PlayResult> | null
  stop(): void
  refresh(): void
  /** `view.draw(pose)`, then one bump. A no-op while detached, so a scrubbing consumer needs no
   *  `view === null` guard and no `refresh()` chaser — `refresh` forces a second blit (§2.2). */
  draw(pose: PoseRef): void
  /** Re-read the view's getters into a new snapshot and publish it. The generic escape for a raw
   *  `view.set` / `view.once` the binding has no method for (§2.2, §11). */
  sync(): void
  /** Re-run the sprite driver for the current options, bypassing the `synced` check (§2.6).
   *  `synced` is written before the swap and never reset on failure, so a rolled-back key is
   *  otherwise refused forever and the only declarative escape is key-away-and-back, which plays
   *  a full fold to a sprite already on screen. A no-op while detached. */
  retry(): void
}
