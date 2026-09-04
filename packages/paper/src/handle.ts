/**
 * §8.5's handle: **no image data at all**, ≈1 712 B, and a figure independent of source
 * dimensions — the property that would have caught the original's 45.9 MB per 100 sprites.
 *
 * §8.6's reserve rides here too: `overscan` is derived per sprite and **frozen at `add()`**, with
 * `overscanHeadroom` buying live slider room, and a knob that moves past the reserve returning an
 * Error naming "re-add required" rather than a silent clamp.
 */
import { KnobError, SheetError } from '@paper-crumple/core'
import type { Knobs, Rect, Size } from '@paper-crumple/core'
import {
  handleBytes,
  overscanFromRadius,
  overscanRadius,
  KNOB_REFERENCE_PX,
} from '@paper-crumple/core/unstable'
import type { EdgeParams, HandleFacts, SheetHandle } from '@paper-crumple/core/unstable'
import { hullBuffers } from './hull-shape.js'
import type { HullShape } from './hull-shape.js'
import type { PaperEdgeMode } from './paper-knobs.js'

export interface PaperSheetHandle extends SheetHandle {
  /** The key the artwork slot and the hull cache are both keyed by. */
  readonly spriteKey: string
  /** §5.2: the silhouette's box, in **source** pixels. */
  readonly rect: Rect
  /**
   * The same box in **front** texels — the box `motion.fit` sizes the bucket front over, the one
   * the guard band reads, and what `SheetFront.rect` reports once moved with the artwork into
   * whatever front `build()` is asked for.
   */
  readonly frontRect: Rect
  /**
   * The front `source()` sized — the artwork plus its per-axis margin, so not the source's
   * aspect — bounded by `maxSize` on its long side, and traced the hull on, in texels.
   * `frontRect` and the hull's own texels are relative to the artwork's centred, 1:1 placement in
   * THIS front; `build()` needs it to carry both into a front of another size.
   */
  readonly front: Size
  /** `A`, the unpadded artwork the resample wrote (§8.5). */
  readonly artwork: Size
  readonly overscan: number
  readonly sdfRes: number
  readonly srcW: number
  readonly srcH: number
  readonly aspect: number
  readonly exact: boolean
  readonly edgeMode: PaperEdgeMode
  readonly hull: HullShape
  /**
   * §6.3 — the hull-tier knob values (`invalidates: 'hull'`: `minDist`, `maxDist`, `angularity`
   * and `seed` in this package, whichever of them the mode declares) the hull was traced at,
   * keyed as the descriptors are. `build()` compares the values it is handed against these and
   * answers `SourceExpiredError` on any difference: the trace lives inside `source()` (§5.2), so
   * a moved hull-tier knob is a re-source at the new values, never a retrace `build()` does on
   * its own.
   */
  readonly hullKnobs: Knobs
  /** Cleared by `release()`; a `build()` on a released handle is a `SheetError`. */
  alive: boolean
  readonly bytes: number
}

/** What core's budget model reads. Every term is a scalar or a packed buffer; none is an image. */
export function handleFactsFor(h: PaperSheetHandle): HandleFacts {
  return {
    rect: { x: h.rect.x, y: h.rect.y, w: h.rect.w, h: h.rect.h },
    overscan: h.overscan,
    sdfRes: h.sdfRes,
    srcW: h.srcW,
    srcH: h.srcH,
    aspect: h.aspect,
    exact: h.exact,
    hull: hullBuffers(h.hull),
  }
}

export function handleBytesFor(h: PaperSheetHandle): number {
  return handleBytes(handleFactsFor(h))
}

/** The frozen reserve: the radius in reference px, and the overscan derived from it. */
export interface OverscanReserve {
  readonly overscan: number
  readonly radius: number
}

/**
 * §8.6. `headroom` inflates the **radius** rather than the overscan, because the reserve is a
 * distance and `p = r / (1000 - 2r)` is not linear in `r`: inflating `p` would reserve a margin
 * no knob value can actually reach.
 *
 * The reserve is aspect-free. The paint radius is quoted against the front's HEIGHT
 * (`paper-renderer.ts`'s own `uPxScale = front.h / KNOB_REFERENCE_PX`), and `frontForArtwork`
 * below applies `p` as a margin of `ceil(p * artwork.h)` TEXELS on every side of the artwork —
 * the same number of texels on x as on y — so the x margin of a tall sprite holds the radius
 * without scaling the reserve by `h / w`. (An earlier version scaled the radius by `h / w` for
 * portrait fronts because the margin was one uv fraction of each axis; that made the y margin
 * `h / w` times larger than needed and cost tall sprites up to a third of their artwork
 * resolution.) The RADIUS returned stays the paint radius — `checkReserve` compares paint radii.
 */
export function freezeOverscan(
  params: EdgeParams,
  headroom: number,
): InstanceType<typeof KnobError> | OverscanReserve {
  const room = Number.isFinite(headroom) && headroom > 0 ? headroom : 0
  const radius = overscanRadius(params) * (1 + room)
  const overscan = overscanFromRadius(radius)
  if (KnobError.is(overscan)) return overscan
  return { overscan, radius }
}

/**
 * §7.4.3's own rule, reused for `A`, for the front and for the field: the long axis takes
 * `longSide` exactly, the short axis keeps the SOURCE's aspect ratio (step 3 of the brief's
 * ten-step pipeline, applied wherever a size is derived from a long-side figure).
 */
export function dimsForLongSide(longSide: number, srcW: number, srcH: number, floor = 1): Size {
  const long = Math.max(srcW, srcH)
  const short = Math.min(srcW, srcH)
  const shortSide = Math.max(floor, Math.round((longSide * short) / long))
  return srcW >= srcH ? { w: longSide, h: shortSide } : { w: shortSide, h: longSide }
}

/** Everything `source()` sizes from the frozen reserve: the artwork, its margin, and the front. */
export interface ArtworkFraming {
  /** `A`, the unpadded artwork, source aspect kept. */
  readonly artwork: Size
  /** The margin on EVERY side of the artwork, in texels: `ceil(overscan * artwork.h)`. */
  readonly margin: number
  /** `artwork` plus `2 * margin` on each axis. Not the source's aspect. */
  readonly front: Size
}

/**
 * §8.6, per axis. The artwork's long side is `srcLong` under `exact`, else the largest value
 * `<= artworkLongSide` (when given) whose front fits `maxSize` on its long side; the front is
 * the artwork plus a `ceil(overscan * artwork.h)` texel margin on every side. The cap's closed
 * form, `floor(maxSize / (1 + 2 * overscan * min(1, srcH / srcW)))`, can overshoot by the
 * rounding of the short side and of the margin, so it is corrected by stepping the long side
 * down until the front fits — at most a couple of steps.
 */
export function frontForArtwork(o: {
  overscan: number
  srcW: number
  srcH: number
  maxSize: number
  exact: boolean
  artworkLongSide?: number
}): InstanceType<typeof SheetError> | ArtworkFraming {
  const p = o.overscan
  const srcLong = Math.max(o.srcW, o.srcH)
  const a = Math.min(1, o.srcH / o.srcW)
  const capA = Math.floor(o.maxSize / (1 + 2 * p * a))
  let aLong = o.exact ? srcLong : Math.min(o.artworkLongSide ?? Number.POSITIVE_INFINITY, capA)
  for (;;) {
    if (aLong < 1) {
      return new SheetError(
        `paperSheet: maxSize ${o.maxSize} leaves no artwork inside the reserved margin ` +
          `(overscan ${p.toFixed(3)}, spec 8.6)`,
      )
    }
    const artwork = dimsForLongSide(aLong, o.srcW, o.srcH)
    const margin = Math.ceil(p * artwork.h)
    const front = { w: artwork.w + 2 * margin, h: artwork.h + 2 * margin }
    if (o.exact || Math.max(front.w, front.h) <= o.maxSize) return { artwork, margin, front }
    aLong -= 1
  }
}

/**
 * §8.6: "Moving a margin-affecting knob past the reserve returns an `Error` naming the fix
 * ('re-add required'), never a silent clamp."
 */
export function checkReserve(
  reserve: OverscanReserve,
  params: EdgeParams,
): InstanceType<typeof SheetError> | undefined {
  const wanted = overscanRadius(params)
  if (wanted <= reserve.radius) return undefined
  return new SheetError(
    `edge knobs need ${wanted.toFixed(1)} reference px of margin but this sprite reserved ` +
      `${reserve.radius.toFixed(1)} at add() — re-add required, or pass a larger ` +
      `overscanHeadroom next time (reference plane ${KNOB_REFERENCE_PX} px, spec 8.6)`,
  )
}
