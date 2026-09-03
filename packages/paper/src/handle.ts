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
   * The front `source()` sized for its `maxSize` and traced the hull on, in texels. `frontRect`
   * and the hull's own texels are relative to the artwork's centred, 1:1 placement in THIS front;
   * `build()` needs it to carry both into a front of another size.
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
 * `heightOverWidth` is the front's `h / w`, and matters only above 1. The radius is quoted
 * against the front's HEIGHT (`paper-renderer.ts`'s own `uPxScale = front.h / KNOB_REFERENCE_PX`,
 * and `source()`'s `k`), but the margin `p` buys is the same uv FRACTION of each axis — so on a
 * front narrower than it is tall the x margin holds only `w / h` of the radius, and a silhouette
 * that comes within the difference of its own bitmap's side is sliced flat by the guard band on
 * axis x. That was every 2:3 demo sample at the demo's own defaults: `0.667 × 150 ≈ 100`
 * reference px of x margin against a paint radius of 150. Scaling the radius by `h / w` before it
 * becomes `p` makes the x margin exactly the radius (the y margin, already exact, grows with it);
 * below 1 the y margin is the exact one and the x margin already the larger, so nothing is
 * scaled. The RADIUS returned stays the paint radius, unscaled — `checkReserve` compares paint
 * radii, which know nothing of aspect.
 */
export function freezeOverscan(
  params: EdgeParams,
  headroom: number,
  heightOverWidth = 1,
): InstanceType<typeof KnobError> | OverscanReserve {
  const room = Number.isFinite(headroom) && headroom > 0 ? headroom : 0
  const radius = overscanRadius(params) * (1 + room)
  const scale = Number.isFinite(heightOverWidth) && heightOverWidth > 1 ? heightOverWidth : 1
  const overscan = overscanFromRadius(radius * scale)
  if (KnobError.is(overscan)) return overscan
  return { overscan, radius }
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
