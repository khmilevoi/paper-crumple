import type { StageEvent } from './events.js'
import type { Rect } from './geometry.js'
import type { MotionSource } from './motion.js'
import type { SheetRenderer } from './sheet.js'

/** The stage's own drawing surface (§4.0). Unchanged by the third pass. */
export interface Surface {
  readonly canvas: HTMLCanvasElement | OffscreenCanvas
  readonly owned: boolean
  readonly width: number
  readonly height: number
  /** Whether the granted attributes permit a view to target the default framebuffer. */
  readonly presentable: boolean
}

/**
 * Blit into a 2D canvas the consumer supplies. The stage never asks it for a WebGL context.
 * `BlitStage` only.
 *
 * `size: 'managed'` — the default — makes the stage own the destination's backing store: before a
 * blit it compares `canvas.width/height` against `round(cssSize × devicePixelRatio)`, capped at
 * the front size, and sets them when they are stale (amendment 13). A zero CSS size is left alone
 * rather than resized to zero, because a zero-sized backing store is a destroyed backing store.
 * `'manual'` is for the consumer already sizing the element themselves.
 */
export type BlitTarget = {
  canvas: HTMLCanvasElement
  fit?: 'stretch' | 'contain'
  size?: 'managed' | 'manual'
  tag?: string
}

/** A rect of the stage's own surface. `DirectStage` only. Nothing is copied. */
export type DirectTarget = { rect: Rect; tag?: string }

/**
 * A framebuffer in the stage's context — the only target available under a non-presentable
 * injected context. `HostedStage` only.
 */
export type HostedTarget = {
  framebuffer: WebGLFramebuffer
  viewport: Rect
  rect?: Rect
  tag?: string
}

/**
 * The union of the three (amendment 8), for the places that speak about a view's destination
 * without knowing the stage's mode. `tag` is declared on all three rather than on `BlitTarget`
 * alone: `view.tag` is a property of a view, and a `stage.play()` report over a `DirectStage`
 * needs correlating exactly as much as one over a `BlitStage` does.
 *
 * **P9 keys the three stage interfaces on these three types.** Nothing here narrows `view()`;
 * that is P9's work.
 */
export type ViewTarget = BlitTarget | DirectTarget | HostedTarget

/**
 * Everything in `StageOptions` that is not the size, restated by the third pass (amendment 12).
 *
 * `gl` and `present` are deliberately absent: they left this bag and became the discriminant of
 * P9's three overloads, because they are the part of the options that changes the *type* of what
 * comes back.
 *
 * `budget` is a bare byte count and is sugar for `stage.budget({ bytes })`, which keeps its
 * object form because it also carries `artworkSlots`. `onError` is the pre-mount form of
 * `stage.on('error')`: a listener attached after the factory resolves cannot observe an error
 * raised inside it. Both methods remain — the options are a shorthand and not a replacement.
 */
export interface StageOptionsBase {
  sheet: SheetRenderer
  motion: MotionSource
  /** Bytes; sugar for `stage.budget({ bytes })` before the first `add()`. */
  budget?: number
  onError?: (e: StageEvent<'error'>) => void
  signal?: AbortSignal
}

/**
 * Exactly one of `maxSize` / `cssPx` / `artworkCssPx` is required (§4.0, amendment 12) — §7.4
 * keeps the number required *somewhere*. Members with `?: never` on the absent ones is how
 * "exactly one" is said in a type; it distributes correctly through P9's
 * `StageOptions & { present: 'blit' }`.
 *
 * `cssPx` is the CSS long side of the box the **paper** is fitted into: the front is
 * `sizeForDisplay({ cssPx, dpr: devicePixelRatio, cap: FRONT_LONG_SIDE_CAP })`, drawn 1:1 under
 * `fit: 'contain'` in a box of that size. How much of that front is artwork depends on the
 * source's aspect: the margin is reserved per axis against the artwork's HEIGHT
 * (`ceil(overscan x artwork.h)` on every side, `paper/src/handle.ts`'s `frontForArtwork`), so a
 * portrait or square source sits near `1 / (1 + 2 x sheet.overscan)` of the front — and, from the
 * `ceil`, usually a little under it — while a landscape source's shorter margin leaves it MORE: a
 * 3:2 source gets noticeably more than a 2:3 one at the same `cssPx`, and a very wide one more
 * still. `View.frame.artwork` is the authoritative per-sprite number; do not compute it from this
 * formula. The grid's contract.
 *
 * `artworkCssPx` is the CSS long side the **artwork** holds on screen: the stage asks the sheet
 * for `ceil(artworkCssPx x dpr)` artwork texels (`SourceOptions.artworkLongSide`) and sizes its
 * surface to `frontCapFor({ artworkLongSide, overscan: sheet.overscan, cap: FRONT_LONG_SIDE_CAP })`,
 * so `View.frame.artwork` scaled by `artworkCssPx / max(artwork.w, artwork.h)` is 1:1 at
 * `devicePixelRatio`. The hero's contract; the paper overflows the picture by the edge knobs'
 * reach and costs `(1 + 2 x overscan)²` more front than `cssPx` would for the same number.
 *
 * A `paperStage` whose `signal` aborts mid-flight disposes what it built and returns `ABORTED`,
 * which is P9's.
 */
export type StageOptions =
  | (StageOptionsBase & { maxSize: number; cssPx?: never; artworkCssPx?: never })
  | (StageOptionsBase & { cssPx: number; maxSize?: never; artworkCssPx?: never })
  | (StageOptionsBase & { artworkCssPx: number; maxSize?: never; cssPx?: never })
