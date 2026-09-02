/**
 * The rect §8.3 derives **without** a readback: "min/max over the hull vertices plus a margin",
 * with the margin named as the spike's `sheetRect(…, marginFrac = 0.04)`.
 *
 * In `hull` and `both` modes the polygon's vertices already sit `maxDist` past the silhouette, so
 * `hullExtent` is the sheet's extent. In `torn` mode there is no polygon, so the extent is the
 * silhouette's own box taken from the CPU signed field the hull trace already builds, grown by
 * `overscanRadius` in field texels. Neither path costs the 3.8 MB `readPixels` §8.3 deletes.
 */
import { sheetRect } from './mask.js'
import type { AlphaBox } from './mask.js'
import type { Rect } from '@paper-crumple/core'

/** The inclusive box of the texels a signed field reports as inside (`d >= 0`). */
export function signedFieldExtent(
  field: ArrayLike<number>,
  w: number,
  h: number,
): AlphaBox | undefined {
  let x0 = w
  let y0 = h
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) {
      if (field[row + x] < 0) continue
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }
  return x1 < 0 ? undefined : { x0, y0, x1, y1 }
}

/** Field texels to source pixels. The high edge takes the last covered pixel, not the first. */
export function scaleBox(box: AlphaBox, scale: number): AlphaBox {
  return {
    x0: Math.floor(box.x0 * scale),
    y0: Math.floor(box.y0 * scale),
    x1: Math.ceil((box.x1 + 1) * scale) - 1,
    y1: Math.ceil((box.y1 + 1) * scale) - 1,
  }
}

/** Grow by a radius in the box's own units, clamped to the plane. */
export function growBox(box: AlphaBox, px: number, w: number, h: number): AlphaBox {
  const r = Math.ceil(px)
  return {
    x0: Math.max(0, box.x0 - r),
    y0: Math.max(0, box.y0 - r),
    x1: Math.min(w - 1, box.x1 + r),
    y1: Math.min(h - 1, box.y1 + r),
  }
}

/** P8's `sheetRect` at its default 4 % margin — one call site, so the constant stays one place. */
export function sheetRectFromExtent(box: AlphaBox, w: number, h: number): Rect {
  return sheetRect(box, w, h)
}
