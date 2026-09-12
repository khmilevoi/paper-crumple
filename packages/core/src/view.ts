import type { Aborted } from './abort.js'
import type { ChangeSource } from './changes.js'
import type { Knobs } from './knobs.js'
import type { SheetError } from './errors.js'
import type { KnobDescriptor } from './forward.js'
import type { Rect, Size } from './geometry.js'
import type { EventName, Events } from './events.js'
import type { KnobSetter, ViewKnobPatch } from './knob-patch.js'
import type { PoseRef } from './pose.js'
import type { PlayResult, SwapResult } from './results.js'
import type { Run } from './run.js'
import type { PlayOptions } from './runner.js'
import type { SpriteSource } from './source.js'
import type { Sprite } from './sprite.js'
import type { ViewState } from './view-state.js'

type AnySlot = readonly KnobDescriptor[]

/** `view.crumpleTo` and `view.swapTo`'s options (§4.2). */
export interface SwapOptions extends PlayOptions {
  /** Named because a `crumpleTo` chained by hand does not reproduce the ball hold (§7.2). */
  duration?: number
}

/**
 * `swapTo`'s options ALONE (§5.3). `SwapOptions` above stays as it is — it is shared with
 * `crumpleTo`, which takes a `Sprite` rather than a source and for which a key is meaningless.
 * Widening the shared type would have added a member one of its two users silently ignores.
 */
export interface SwapToOptions extends SwapOptions {
  /**
   * The key the incoming sprite is added under. Defaults to the minted `swap:…` key, which is
   * unstable by design. Supplying one makes the fold preset stable per picture, lets two views
   * share one front, and lets the byte budget bound the result.
   *
   * A key that is already resident is a CACHE HIT, not a failure: the swap adopts the resident
   * sprite and `src` is not read. Re-pointing a live key remains `replace()`, and a key whose
   * `add()` is still in flight is still refused — sharing a front holds only once the first
   * `add()` has settled.
   */
  key?: string
}

/**
 * Where the shown sprite's **artwork** lands in the box the view draws into.
 *
 * `box` is the destination the sheet is drawn into, in its own pixels: the front's box for a
 * `{ canvas }` view (what the blit copies out), the rect itself for a `{ rect }` view, the
 * framebuffer's rect for a `{ framebuffer }` one. `artwork` is the unpadded source inside that
 * box — the picture, without the paper around it — at pose 0. Both are in the box's pixels;
 * `artwork` is measured from the box's top-left corner, y down, the way the box appears on the
 * screen (a `{ rect }` view's rect is placed in GL coordinates, and its screen position is the
 * consumer's to know). A consumer pinning the picture at a fixed on-screen rectangle and letting
 * the paper overflow past it sizes and offsets its element from these two boxes and nothing else:
 * one scale, `cssPx / max(artwork.w, artwork.h)`, applied to both.
 *
 * The motion slot centres the sheet on the *paper's* box (`SheetFront.rect`), which the hull
 * grows asymmetrically around the picture, so the artwork is neither centred in `box` nor a
 * constant fraction of it — and a hull-tier knob moves it. Read it again after the re-source
 * such a knob triggers has landed (`stage.prepare(key)` joins it), and after every swap.
 */
export interface ViewFrame {
  readonly box: Size
  readonly artwork: Rect
}

/**
 * §4.2 — **a place on the screen**: a render target and a destination rect, at most one sprite at
 * a time, and **the pose**. Owner of draw-class knob overrides. Created and disposed explicitly.
 *
 * One sprite may be shown by several views — the same garment as a grid thumbnail and in a detail
 * panel, sharing one front texture. That is why the pose belongs to the view.
 */
export interface View {
  readonly changes: ChangeSource
  /** Local accepted overrides; sprite and stage values are read separately. */
  readonly appliedKnobs: Readonly<Knobs>
  // --- the accessors the design already assumes (amendment 14) ---
  /** The **resolved numeric index** — the value §4.5 tells a caller to pass to
   *  `play(view.pose, 'flat')`. `PoseRef` is an input type only. */
  readonly pose: number
  /** §4.5's table, exposed — all seven states, under the table's own names. A three-value summary
   *  was refused: it would hide whether a parked view waits on a target (`crumpling.ball`) or
   *  descends on the old sprite after one failed (`crumpling.recover`). */
  readonly state: ViewState
  readonly sprite: Sprite | null
  /** Replaces every hand-rolled `isPlaying` counter, and makes `run.stop()` reachable. */
  readonly run: Run<PlayResult | SwapResult> | null
  /** Supplied at `stage.view()`; what makes a `stage.play()` skip entry correlatable without a
   *  reverse `Map<View, id>`. */
  readonly tag: string | undefined
  /** What the motion slot asked the front be rendered at (amendment 13). */
  readonly idealSize: Size
  /**
   * Where the shown sprite's artwork lands in the box this view draws into — `null` while no
   * sprite is shown or its front is not resident (evicted, or a re-source still in flight).
   */
  readonly frame: ViewFrame | null

  // --- drawing ---
  show(sprite: Sprite | null): InstanceType<typeof SheetError> | undefined
  /** Redraw at the current pose. No run, no events (amendment 15). */
  refresh(): void
  /** Draw one pose. No run, no events. The honest escape hatch for scroll-driven or
   *  devtools-stepped scrubbing, where the scheduler belongs to the consumer. */
  draw(pose: PoseRef): void

  // --- runs (§4.2, amendment 22) ---
  play(from: PoseRef, to: PoseRef, o?: PlayOptions): Run<PlayResult>
  /**
   * **Not `async`.** It returns a promise-like, but it emits `start` **before** it returns, so
   * `AudioContext.resume()` can be called from inside the user gesture that triggered it (§7.1).
   * Refactoring this to `async` silently breaks audio on iOS; `Run` is a non-promise return type
   * so that edit is a type error at every call site rather than a prose warning.
   *
   * A consumer honouring `prefers-reduced-motion` needs no API: `show()` **is** the degraded
   * swap — instant, pose 0, no run — so the whole accommodation is
   * `matchMedia('(prefers-reduced-motion: reduce)').matches ? view.show(b) : view.swapTo(src)`.
   */
  crumpleTo(target: Sprite | Promise<Sprite | Error | Aborted>, o?: SwapOptions): Run<SwapResult>
  /**
   * `add` + `crumpleTo(pending)`. Inherits `crumpleTo`'s contract exactly (amendment 11).
   *
   * Without `o.key` the key is minted from the source and a monotonic counter, so the same
   * picture folds differently on every swap — the fold preset is `presetForImageId(key)`. With
   * one, the key is the caller's: a resident key is adopted without an `add()` and `src` is not
   * read, a fresh one is the key the `add()` runs under.
   */
  swapTo(src: SpriteSource, o?: SwapToOptions): Run<SwapResult>
  /** Freezes at the current pose and **issues no draw** — a cancel path must not render. */
  stop(): void

  set: KnobSetter<ViewKnobPatch<AnySlot, AnySlot>>
  on<E extends EventName>(event: E, fn: (e: Events[E]) => void): () => void
  once<E extends EventName>(event: E, fn: (e: Events[E]) => void): () => void
  /** Detaches and releases nothing context-wide. A `{ canvas }` view leaves the element's last
   *  blitted pixels in place; the element itself is the consumer's (§4.6). */
  dispose(): void
}
