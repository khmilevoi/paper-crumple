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
 * Exactly one of `maxSize` / `cssPx` is required (§4.0, amendment 12) — §7.4 keeps the number
 * required *somewhere*, and `cssPx` is the form that states it without making every consumer
 * spell out `sizeForDisplay` and `devicePixelRatio` at the call site. A two-member union with
 * `?: never` on the absent one is how "exactly one" is said in a type; it distributes correctly
 * through P9's `StageOptions & { present: 'blit' }`.
 *
 * `cssPx` feeds `sizeForDisplay({ cssPx, dpr: devicePixelRatio, cap: 512 })`, which is P5's.
 * A `paperStage` whose `signal` aborts mid-flight disposes what it built and returns `ABORTED`,
 * which is P9's.
 */
export type StageOptions =
  | (StageOptionsBase & { maxSize: number; cssPx?: never })
  | (StageOptionsBase & { cssPx: number; maxSize?: never })
