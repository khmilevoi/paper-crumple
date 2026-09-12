import type { Size, ViewFrame } from '@paper-crumple/core'

/**
 * The hero canvas's CSS boxes, so that the **artwork** is what holds still.
 *
 * The stage used to hand the library a fixed `cssPx` square and ask for `fit: 'contain'`. That
 * letterboxes the whole *front* — the artwork plus the paper margin around it — into the square,
 * and the margin is not a constant: it is the silhouette grown by the paint radius, which every
 * edge parameter feeds, so every edge-mode, bucket, sample or headroom change rescaled and slid
 * the picture inside a canvas that never moved.
 *
 * The fix is to frame the artwork and let the paper overflow: the slot is the picture's own box,
 * fixed at `cssPx` on its long side for a given source, and the canvas is positioned over it and
 * reaches however far past it the paper does. Where the picture lands inside what the canvas
 * shows is the library's to say — `View.frame` reports the drawn box and the artwork inside it,
 * in one unit — so this is four multiplications by one scale and no geometry of its own. An
 * earlier version reconstructed the same two boxes from `Sprite.rect`, `Sprite.frontSize` and a
 * second decode of the source, and could only do so at `add()` time; see
 * `docs/design/2026-09-04-artwork-framing.md` for why that was the wrong shape.
 */

/** The boxes a mounted hero needs, in CSS pixels. */
export interface Framing {
  /** The artwork's box: fixed for a given source and `cssPx`, whatever the paper does. */
  readonly image: Size
  /** The canvas element's CSS box — larger than `image` by the paper's reach. */
  readonly canvas: Size
  /** The canvas's top-left, relative to the image box's top-left. Negative on the sides the
   *  paper reaches past the artwork, which is normally all four. */
  readonly offset: { readonly x: number; readonly y: number }
}

/**
 * One scale, `cssPx / max(artwork.w, artwork.h)`, applied to both of the frame's boxes: the
 * picture is laid out exactly as an `<img>` of the same source at the same size would be, and the
 * canvas is that scale applied to the bigger box, offset so the artwork lands on the picture.
 */
export function frameArtwork(frame: ViewFrame, cssPx: number): Framing {
  const long = Math.max(frame.artwork.w, frame.artwork.h)
  // A frame with no artwork has no scale to derive; zero boxes are laid out, not NaN ones.
  const scale = long > 0 ? cssPx / long : 0
  return {
    image: { w: frame.artwork.w * scale, h: frame.artwork.h * scale },
    canvas: { w: frame.box.w * scale, h: frame.box.h * scale },
    offset: { x: -frame.artwork.x * scale, y: -frame.artwork.y * scale },
  }
}
