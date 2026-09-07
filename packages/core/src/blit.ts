import type { Rect, Size } from './geometry.js'

/**
 * # The blit, and the two things the original left unstated (§4.0.1, amendment 13)
 *
 * `present: 'blit'` draws one view at a time at the surface's origin and copies the result into a
 * 2D canvas the consumer supplies. The blit happens **six times per fold, not per frame** — there
 * is no `requestAnimationFrame` — and the spikes' own measurements already include it at
 * 0.33–0.36 ms per step against a ~95 ms dwell. That budget is why this module reads
 * `getBoundingClientRect()` once per draw and needs no `ResizeObserver`.
 */
export interface BlitPlan {
  /**
   * The source rect **in surface pixels, top-left origin**, for `drawImage`. GL's viewport origin
   * is bottom-left and a 2D canvas's is top-left, so a view drawn at the surface's origin is read
   * from `(0, surfaceHeight - h, w, h)`. That is the front's own box, `(0, 0, w, h)` in GL
   * coordinates, and it is the box a blit view draws in (`resolveTarget` in `stage.ts`): the two
   * must name one rectangle, or a non-square front comes out shifted and cropped.
   * `paper-crumple-3d` avoids this offset only by resizing the surface to the front on every
   * draw, which §7.3 forbids.
   */
  readonly src: Rect
  /** Where it lands in the destination, in destination-backing-store pixels. */
  readonly dest: Rect
  /**
   * What to clear before `drawImage`, in destination pixels — always the whole destination rect,
   * under both `'contain'` and `'stretch'`. **This is a live bug fix and not an ergonomic
   * complaint:** without it a `swapTo` from a wide sprite to a narrow one leaves the previous
   * sprite's edges on the tile, because §4.3's scissored clear covers the GL surface only and
   * nothing in the design ever touched the destination.
   *
   * Clearing stops at the letterbox bars only when the front's own opaque silhouette is the same
   * from draw to draw — it never is here. The front carries the crumpled paper's shape in its
   * alpha channel, and that shape keeps changing size and outline between poses of the very same
   * fold while `dest` itself stays fixed, so a bars-only clear left every earlier pose's opaque
   * pixels sitting under the new pose's transparent ones — a visible trail of "old frames" behind
   * the current one, worst right where a fold shrinks the silhouette fastest.
   */
  readonly clear: readonly Rect[]
}

const ZERO: Rect = { x: 0, y: 0, w: 0, h: 0 }

function whole(size: Size): Rect {
  return { x: 0, y: 0, w: size.w, h: size.h }
}

export function blitPlan(o: {
  surface: Size
  front: Size
  dest: Size
  fit: 'stretch' | 'contain'
}): BlitPlan {
  const src: Rect = { x: 0, y: o.surface.h - o.front.h, w: o.front.w, h: o.front.h }

  if (o.front.w <= 0 || o.front.h <= 0 || o.dest.w <= 0 || o.dest.h <= 0) {
    return { src, dest: ZERO, clear: [whole(o.dest)] }
  }

  if (o.fit === 'stretch') {
    return { src, dest: whole(o.dest), clear: [whole(o.dest)] }
  }

  const scale = Math.min(o.dest.w / o.front.w, o.dest.h / o.front.h)
  const w = Math.round(o.front.w * scale)
  const h = Math.round(o.front.h * scale)
  const x = Math.round((o.dest.w - w) / 2)
  const y = Math.round((o.dest.h - h) / 2)

  return { src, dest: { x, y, w, h }, clear: [whole(o.dest)] }
}

/**
 * `size: 'managed'` — the default — makes the stage own the destination's backing store
 * (amendment 13). Returns the size to set, or `null` to leave the element alone.
 *
 * This closes a gap that otherwise ships the headline scenario blurry on every retina display: a
 * consumer's `<canvas>` arrives at its stock 300x150 backing store, nothing in the API sets it,
 * and the front size is bucket-derived (§8.6) and unexposed — so §7.4's claim that "the number of
 * places `devicePixelRatio` is thought about goes from N to one" is true of the front and false
 * of the destination.
 *
 * **The cap at the front size is what makes the 1:1 case reachable at all.** A destination sized
 * past the front resamples through the 2D context's own filter, which the library does not
 * control, so the managed rule stops at the front rather than at the display.
 *
 * **The cap is uniform, never per axis.** The browser draws the backing store stretched into the
 * CSS box, so the store must keep the box's own shape: capping each axis at the front on its own
 * gave a landscape front in a square box a landscape store, and the sprite came out stretched to
 * twice its height. Instead the box shrinks as a whole until the front fits it 1:1 on the axis
 * that binds, and `contain` letterboxes the other — still never past the front on that axis.
 *
 * **A zero CSS size is left alone rather than resized to zero** — a hidden element, a
 * `display: none` ancestor — because a zero-sized backing store is a destroyed backing store.
 */
export function managedBackingStore(o: {
  cssSize: Size
  dpr: number
  front: Size
  current: Size
}): Size | null {
  if (o.cssSize.w <= 0 || o.cssSize.h <= 0) return null
  const dpr = Number.isFinite(o.dpr) && o.dpr > 0 ? o.dpr : 1
  const boxW = Math.max(1, Math.round(o.cssSize.w * dpr))
  const boxH = Math.max(1, Math.round(o.cssSize.h * dpr))
  // 1 once the front overflows the box on either axis (the store is the display's own pixels and
  // the blit downsamples); below that, the box's shape scaled down to meet the front where it
  // first does.
  const k = Math.min(1, Math.max(Math.max(1, o.front.w) / boxW, Math.max(1, o.front.h) / boxH))
  const w = Math.max(1, Math.round(boxW * k))
  const h = Math.max(1, Math.round(boxH * k))
  if (w === o.current.w && h === o.current.h) return null
  return { w, h }
}
