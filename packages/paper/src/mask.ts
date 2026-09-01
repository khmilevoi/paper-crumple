// Alpha-mask geometry for the sheet fit and the verify jobs. Pure functions, no GL, no DOM.
//
// Connectivity convention: foreground components (`components()`, and the foreground pass inside
// `holes()`) are 8-connected — a diagonal touch joins two blobs into one, so a knife-edge corner of
// a crumpled silhouette does not register as a stray extra component. The complement/holes labelling
// inside `holes()` (including the border-touching flag) stays 4-connected, so a diagonal-only gap
// between two foreground pixels is not treated as a path to the border and can still enclose a hole.
// This is the standard digital-topology pairing (8-connected foreground / 4-connected background);
// using the same connectivity for both is topologically inconsistent and can flip either count on a
// single ambiguous pixel.

/** §8.3 — the alpha above which a pixel counts as part of the silhouette. */
export const ALPHA_BBOX_THRESHOLD = 8

/**
 * §8.3 — the sheet's margin, as a fraction of the bbox's LONG side. Named here rather than left as
 * a default buried in a call: "a different rect gives a different aspect, hence a different bucket,
 * hence a different look".
 */
export const SHEET_MARGIN_FRAC = 0.04

/** An inclusive pixel box. */
export interface AlphaBox {
  readonly x0: number
  readonly y0: number
  readonly x1: number
  readonly y1: number
}

/**
 * Inclusive bbox of pixels with alpha strictly above `threshold`.
 *
 * Rows are whatever order the buffer is in — `gl.readPixels` is bottom-up, a canvas `ImageData` is
 * top-down — and callers keep that straight.
 *
 * `undefined` when nothing clears the threshold. `undefined` and not an `Error`: this package
 * returns no `Error` at all (see the plan's global constraints), and an empty silhouette is an
 * absence rather than a failure, on amendment 17's precedent. The sheet renderer turns it into the
 * `SheetError` its `source()` contract owes; a verify job may reasonably treat it as data.
 */
export function alphaBbox(
  rgba: ArrayLike<number>,
  width: number,
  height: number,
  threshold: number = ALPHA_BBOX_THRESHOLD,
): AlphaBox | undefined {
  let x0 = width
  let y0 = height
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (rgba[(y * width + x) * 4 + 3] <= threshold) continue
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }
  if (x1 < 0) return undefined
  return { x0, y0, x1, y1 }
}

/**
 * The sheet extent: the box plus a margin of `marginFrac` of its long side, clamped to the frame.
 *
 * §8.3 moves the box's source: with the hull inside `source()` the rect is min/max over the hull
 * vertices — `hullExtent` in `hull-shape.ts` — rather than a 3.8 MB `readPixels`. This function is
 * indifferent to which produced the box.
 */
export function sheetRect(
  box: AlphaBox,
  width: number,
  height: number,
  marginFrac: number = SHEET_MARGIN_FRAC,
): { x: number; y: number; w: number; h: number } {
  const bw = box.x1 - box.x0 + 1
  const bh = box.y1 - box.y0 + 1
  const m = Math.round(marginFrac * Math.max(bw, bh))
  const x = Math.max(0, box.x0 - m)
  const y = Math.max(0, box.y0 - m)
  const x1 = Math.min(width - 1, box.x1 + m)
  const y1 = Math.min(height - 1, box.y1 + m)
  return { x, y, w: x1 - x + 1, h: y1 - y + 1 }
}

interface Labelling {
  readonly sizes: number[]
  readonly border: boolean[]
}

function label(mask: ArrayLike<number>, w: number, h: number, diagonal: boolean): Labelling {
  const seen = new Uint8Array(mask.length)
  const stack = new Int32Array(mask.length)
  const sizes: number[] = []
  const touchesBorder: boolean[] = []
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue
    let top = 0
    stack[top++] = start
    seen[start] = 1
    let size = 0
    let border = false
    while (top > 0) {
      const p = stack[--top]
      size++
      const x = p % w
      const y = (p / w) | 0
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) border = true
      if (x > 0 && mask[p - 1] && !seen[p - 1]) {
        seen[p - 1] = 1
        stack[top++] = p - 1
      }
      if (x < w - 1 && mask[p + 1] && !seen[p + 1]) {
        seen[p + 1] = 1
        stack[top++] = p + 1
      }
      if (y > 0 && mask[p - w] && !seen[p - w]) {
        seen[p - w] = 1
        stack[top++] = p - w
      }
      if (y < h - 1 && mask[p + w] && !seen[p + w]) {
        seen[p + w] = 1
        stack[top++] = p + w
      }
      if (diagonal) {
        if (x > 0 && y > 0 && mask[p - w - 1] && !seen[p - w - 1]) {
          seen[p - w - 1] = 1
          stack[top++] = p - w - 1
        }
        if (x < w - 1 && y > 0 && mask[p - w + 1] && !seen[p - w + 1]) {
          seen[p - w + 1] = 1
          stack[top++] = p - w + 1
        }
        if (x > 0 && y < h - 1 && mask[p + w - 1] && !seen[p + w - 1]) {
          seen[p + w - 1] = 1
          stack[top++] = p + w - 1
        }
        if (x < w - 1 && y < h - 1 && mask[p + w + 1] && !seen[p + w + 1]) {
          seen[p + w + 1] = 1
          stack[top++] = p + w + 1
        }
      }
    }
    sizes.push(size)
    touchesBorder.push(border)
  }
  const order = sizes.map((_, i) => i).sort((a, b) => sizes[b] - sizes[a])
  return { sizes: order.map((i) => sizes[i]), border: order.map((i) => touchesBorder[i]) }
}

/** 8-connected component sizes of a 0/1 mask, largest first. */
export function components(mask: ArrayLike<number>, w: number, h: number): number[] {
  return label(mask, w, h, true).sizes
}

export interface HolesReport {
  readonly components: number
  /** The six largest component sizes. */
  readonly sizes: number[]
  readonly holes: number
  /** The six largest hole sizes. */
  readonly holeSizes: number[]
}

/**
 * Components of the mask (8-connected), and holes = 4-connected components of its complement that
 * never touch the border. See the connectivity note at the top of this file.
 */
export function holes(mask: ArrayLike<number>, w: number, h: number): HolesReport {
  const inv = new Uint8Array(mask.length)
  for (let i = 0; i < mask.length; i++) inv[i] = mask[i] ? 0 : 1
  const sizes = components(mask, w, h)
  const comp = label(inv, w, h, false)
  const holeSizes = comp.sizes.filter((_, i) => !comp.border[i])
  return {
    components: sizes.length,
    sizes: sizes.slice(0, 6),
    holes: holeSizes.length,
    holeSizes: holeSizes.slice(0, 6),
  }
}
