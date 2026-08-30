/**
 * # §4.5's state table, as a pure function
 *
 * A view is in exactly one of six states, plus a terminal one. There is **no `stopped` state**:
 * `stop()` is a transition to `idle`, because a latching stopped state would need an un-stopping
 * transition and every call legal in it is already legal in `idle`.
 *
 * This file decides; it never draws and never emits. `runner.ts` performs what it decides and
 * P9 wires the drawing. Testing it as a table rather than through a stage is the point: the rows
 * are what a level-1 suite can pin, and a stage is a wave-4 object.
 */

export type ViewState =
  | 'idle'
  | 'playing'
  | 'crumpling.rise'
  | 'crumpling.ball'
  | 'crumpling.fall'
  | 'crumpling.recover'
  | 'disposed'

/** The five states in which a run is live. `idle` and `disposed` are the two that are not. */
export const RUNNING_STATES: readonly ViewState[] = [
  'playing',
  'crumpling.rise',
  'crumpling.ball',
  'crumpling.fall',
  'crumpling.recover',
]

export type ViewAction =
  'show' | 'play' | 'crumpleTo' | 'swapTo' | 'refresh' | 'draw' | 'stop' | 'dispose'

/**
 * What a refused call yields.
 *
 * §4.5 says a disposed view returns a `SheetError` from "every call", and amendments 15 and 22
 * made that impossible for five of the eight: `refresh`, `draw` and `stop` return `void`, and
 * `play` / `crumpleTo` / `swapTo` return `Run<R>` whose `R` — `PlayResult` or `SwapResult` — has
 * no `SheetError` member. So the sentence survives where it still can and degrades where it
 * cannot: `'SheetError'` for `show`, `'aborted'` for the three `Run` returners (a disposed view
 * is a request that will never be spent, which is what `ABORTED` means), and `'noop'` for the
 * rest. **No refusal emits anything**, which is the half of §4.5's sentence that is unaffected.
 */
export type Refusal = 'SheetError' | 'aborted' | 'noop'

export interface TransitionResult {
  /** `false` means the call is refused; `refusal` says with what. */
  readonly legal: boolean
  readonly refusal?: Refusal
  /** Tears down a live run first, emitting `end { completed: false }` (§7.1). */
  readonly endsLiveRun: boolean
  /** Creates a new run and emits `start` (§7.1). */
  readonly startsRun: boolean
  /** Issues at least one render. */
  readonly draws: boolean
  /** Emits anything at all. `refresh` and `draw` do not (amendment 15). */
  readonly emits: boolean
  /** The state after the call, or `null` when the call leaves `view.state` where it was. */
  readonly next: ViewState | null
}

const RUNNING = new Set<ViewState>(RUNNING_STATES)

/**
 * `play(x, x)` stays legal — one render, zero dwells — but it is no longer the documented way to
 * redraw (amendment 15). It is a pun: it emits a `start` / `step` / `end` triple for a repaint,
 * and §7.1's ordering guarantees make that pollution faithful rather than incidental, so every
 * consumer's metrics and every `isPlaying` counter would carry repaints as runs. `refresh` and
 * `draw` are the rows below that do not.
 */
export function transition(state: ViewState, action: ViewAction): TransitionResult {
  if (state === 'disposed') {
    const refusal: Refusal =
      action === 'play' || action === 'crumpleTo' || action === 'swapTo'
        ? 'aborted'
        : action === 'show'
          ? 'SheetError'
          : 'noop'
    return {
      // `dispose()` is idempotent (§4.6), so calling it on a disposed view is legal and does
      // nothing; every other call is refused.
      legal: action === 'dispose',
      refusal,
      endsLiveRun: false,
      startsRun: false,
      draws: false,
      emits: false,
      next: 'disposed',
    }
  }

  const live = RUNNING.has(state)

  switch (action) {
    // Amendment 15. Neither creates nor supersedes a run, neither emits `start` / `step` / `end`,
    // and neither moves `view.state`. `draw` is also the honest escape hatch for scroll-driven or
    // devtools-stepped scrubbing, where the scheduler belongs to the consumer and the library is
    // being asked for one frame rather than for a traversal.
    case 'refresh':
    case 'draw':
      return {
        legal: true,
        endsLiveRun: false,
        startsRun: false,
        draws: true,
        emits: false,
        next: null,
      }

    // Instant, pose 0, no run (§4.2). It ends a live run first, or that run's next step would
    // draw over what `show` just put up. `show()` is also the whole of the
    // `prefers-reduced-motion` accommodation, which is why it must stay a one-call path.
    case 'show':
      return {
        legal: true,
        endsLiveRun: live,
        startsRun: false,
        draws: true,
        emits: live,
        next: 'idle',
      }

    case 'play':
      return {
        legal: true,
        endsLiveRun: live,
        startsRun: true,
        draws: true,
        emits: true,
        next: 'playing',
      }

    // A `crumpleTo` is **one** run: one `start`, one `end`, with `via: ball` on the `start`. The
    // state it enters is `crumpling.rise`; `runner.ts` refines that to `crumpling.ball` in the
    // same synchronous block when the run begins at the ball pose and there is no rise.
    case 'crumpleTo':
    case 'swapTo':
      return {
        legal: true,
        endsLiveRun: live,
        startsRun: true,
        draws: true,
        emits: true,
        next: 'crumpling.rise',
      }

    // Freezes the view at its current pose and issues no draw — a cancel path must not render.
    // On an `idle` view it emits nothing, or `end` would appear without a matching `start`.
    case 'stop':
      return {
        legal: true,
        endsLiveRun: live,
        startsRun: false,
        draws: false,
        emits: live,
        next: 'idle',
      }

    // §4.6: detaches, and emits `end { completed: false }` if a run was live. The `end` is emitted
    // at `idle`, under §7.1's universal teardown-before-`end` rule, and the view is marked
    // `disposed` after it.
    case 'dispose':
      return {
        legal: true,
        endsLiveRun: live,
        startsRun: false,
        draws: false,
        emits: live,
        next: 'disposed',
      }
  }
}
