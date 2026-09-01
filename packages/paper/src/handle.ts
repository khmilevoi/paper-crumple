/**
 * §8.5's handle: **no image data at all**, ≈1 712 B, and a figure independent of source
 * dimensions — the property that would have caught the original's 45.9 MB per 100 sprites.
 *
 * §8.6's reserve rides here too: `overscan` is derived per sprite and **frozen at `add()`**, with
 * `overscanHeadroom` buying live slider room, and a knob that moves past the reserve returning an
 * Error naming "re-add required" rather than a silent clamp.
 */
import { KnobError, SheetError } from '@paper-crumple/core'
import type { Rect, Size } from '@paper-crumple/core'
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
  /** The same box in **front** texels — what `SheetFront.rect` reports and the guard band reads. */
  readonly frontRect: Rect
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
