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
  GUARD_EPSILON_REFERENCE_PX,
  GUARD_MARGIN_G,
  guardMarginsFor,
  KNOB_REFERENCE_PX,
  marginFractionFor,
} from '@paper-crumple/core/unstable'
import type { EdgeParams, EdgeSpec, HandleFacts, SheetHandle } from '@paper-crumple/core/unstable'
import { hullBuffers } from './hull-shape.js'
import type { HullShape } from './hull-shape.js'

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
  /** The x-axis per-side margin, in texels: `front.w - artwork.w === 2 * marginX` (design 2026-09-05 §4.2). */
  readonly marginX: number
  /** The y-axis per-side margin, in texels: `front.h - artwork.h === 2 * marginY` (design 2026-09-05 §4.2). */
  readonly marginY: number
  readonly overscan: number
  readonly sdfRes: number
  readonly srcW: number
  readonly srcH: number
  readonly aspect: number
  readonly exact: boolean
  /** Which cell of design 2026-09-05 §6's table this sprite was sourced under. */
  readonly edgeSpec: EdgeSpec
  /**
   * `W` in reference px, as the TRACE ran at it (design 2026-09-05 §3.1). Under `smooth` this is
   * the width `hullBandFor` derived the band from, and a caller who moves `edgeWidth` gets a
   * `SourceExpiredError` out of `build()`'s hull-tier guard rather than a stale polygon. Under
   * `torn` the width is front-tier and there is no trace, so this records only what `source()`'s
   * own extent arithmetic used: `build()` resolves its own from the live `knobValues` and never
   * uploads this one.
   */
  readonly widthRef: number
  /**
   * THIS sprite's own frozen reserve — the factory's defaults at THIS sprite's aspect
   * (design 2026-09-05 §4.4). Under `edgeWidthUnit: 'px'` it is the factory's own reserve exactly;
   * under `'percent'` a 1:4 tower's is strictly smaller than the `c = 1` ceiling
   * `PaperSheet.overscan` reports, which is why `build()`'s `checkReserve` compares against this
   * rather than against the factory's.
   */
  readonly reserve: OverscanReserve
  readonly hull: HullShape
  /**
   * §6.3 — the hull-tier knob values (`invalidates: 'hull'`: under `smooth`, `edgeWidth`,
   * `edgeVariance`, `angularity` and `seed`; under `torn` the first two are front-tier instead and
   * this bag is empty) the hull was traced at, keyed as the descriptors are. `build()` compares
   * the values it is handed against these and
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

/**
 * Everything `source()` sizes from the frozen reserve: the artwork, its per-axis margin, and the
 * front (design 2026-09-05 §4.2). The two axes no longer carry the same texel count — the x and
 * y margins coincide only on a square artwork (an exact algebraic identity, not a coincidence).
 */
export interface ArtworkFraming {
  /** `A`, the unpadded artwork, source aspect kept. */
  readonly artwork: Size
  /** The x-axis margin on EVERY side of the artwork, in texels (`guardMarginsFor`'s `x`). */
  readonly marginX: number
  /** The y-axis margin on EVERY side of the artwork, in texels (`guardMarginsFor`'s `y`). */
  readonly marginY: number
  /** `artwork` plus `2 * marginX` on x and `2 * marginY` on y. Not the source's aspect. */
  readonly front: Size
}

/**
 * §8.6, per axis. The artwork's long side is `srcLong` under `exact`, else the largest value
 * `<= artworkLongSide` (when given) whose front fits `maxSize` on its long side; the front is
 * the artwork plus `guardMarginsFor`'s per-axis margin (paint plus guard band, design 2026-09-05
 * §4.2) on every side. The cap's closed form, `floor(maxSize / (1 + 2 * longFraction))` (the
 * margin fraction that belongs to the long axis — see the comment at its call site below), can
 * be off by one texel either way from the rounding of the short side and of the margin — usually
 * an overshoot, corrected by stepping the long side down until the front fits, but sometimes an
 * undershoot, so `capA + 1` is probed first (see the comment at its call site below): at most a
 * couple of steps either direction.
 */
export function frontForArtwork(o: {
  overscan: number
  srcW: number
  srcH: number
  maxSize: number
  exact: boolean
  artworkLongSide?: number
}): InstanceType<typeof SheetError> | ArtworkFraming {
  // Every non-finite, zero, or negative input below reaches `aLong -= 1` as `NaN` — or as a
  // value that never shrinks below 1 — and the `for (;;)` loop then spins forever, synchronously,
  // blocking the thread with no way for a caller to recover:
  //   - `srcW: 0, srcH: 0` makes `a = Math.min(1, 0 / 0)` (`NaN`), so `capA` and every `aLong`
  //     the loop computes is `NaN`, and `NaN < 1` is false.
  //   - `overscan: -0.5` on a square source makes `1 + 2 x overscan x a === 0`, so `capA` is
  //     `Infinity`, `margin` is `-Infinity`, `artwork`/`front` are `NaN`, and
  //     `Infinity - 1 === Infinity` never reaches `aLong < 1` either.
  // `paperSheet()` itself cannot reach any of these (`mount()` already refused if
  // `freezeOverscan` failed, which is the only route to a non-positive `overscan`, and its own
  // `srcW`/`srcH`/`maxSize` are always finite and positive), but this function is not itself the
  // public surface that matters here: `frontForArtwork` is not exported from `index.ts` (only
  // `checkReserve`, `freezeOverscan`, `handleBytesFor` and `handleFactsFor` are). The genuinely
  // public, unvalidated vector into this arithmetic is `SourceOptions.artworkLongSide` — guarded
  // separately below, and already complete — but this function's own inputs are reachable by
  // anyone importing it directly from the package's internals, and an infinite synchronous loop
  // is not an acceptable failure mode regardless of how it is reached. Fail cleanly instead.
  if (
    !Number.isFinite(o.overscan) ||
    !Number.isFinite(o.srcW) ||
    !Number.isFinite(o.srcH) ||
    !Number.isFinite(o.maxSize) ||
    o.overscan < 0 ||
    o.srcW <= 0 ||
    o.srcH <= 0 ||
    o.maxSize <= 0
  ) {
    return new SheetError(
      `paperSheet: frontForArtwork needs a finite overscan >= 0 and finite, positive srcW, srcH ` +
        `and maxSize (got overscan ${o.overscan}, srcW ${o.srcW}, srcH ${o.srcH}, maxSize ` +
        `${o.maxSize}, spec 8.6)`,
    )
  }
  if (
    o.artworkLongSide !== undefined &&
    (!Number.isFinite(o.artworkLongSide) ||
      !Number.isInteger(o.artworkLongSide) ||
      o.artworkLongSide <= 0)
  ) {
    return new SheetError(
      `paperSheet: artworkLongSide must be a finite positive integer, got ${o.artworkLongSide} ` +
        `(SourceOptions.artworkLongSide, spec 8.6)`,
    )
  }
  const p = o.overscan
  const srcLong = Math.max(o.srcW, o.srcH)
  // The long side is x for a landscape source and y for a portrait or square one, and the two
  // axes no longer carry the same margin (design 2026-09-05 §4.2). `marginFractionFor` is the Y
  // fraction; the X fraction is `(g + c*p/Q)/(1 - 2g) + c*eps` with `c = A.h / A.w`, which is
  // strictly SMALLER for `c < 1`. Estimating a landscape front with the y fraction under-sizes
  // the artwork by 12-17% (at 3:1, `aLong` lands on 770 where 902 fits — R14), and the loop only
  // ever steps DOWN, so it never recovers. Pick the fraction that belongs to the long axis.
  const g = GUARD_MARGIN_G
  const eps = GUARD_EPSILON_REFERENCE_PX / KNOB_REFERENCE_PX
  const q = 1 - 2 * g * (1 + 2 * p)
  const c = Math.min(1, o.srcH / o.srcW)
  const longFraction =
    o.srcW >= o.srcH ? (g + (c * p) / q) / (1 - 2 * g) + c * eps : marginFractionFor(p) + eps
  // `capA` is a closed-form estimate; the rounding of the short side (`dimsForLongSide`) and of
  // the margin (`guardMarginsFor`) can make the true maximum `capA + 1`. Probing `capA + 1`
  // first — the loop below steps back down if it does not actually fit — finds that true maximum
  // throughout the realistic parameter band (aspects 8x8..192x192, overscan 0.05-0.5, maxSize
  // 32-1024: zero under-shoots across 6.86M combinations swept, pre-§4.2). Outside that band a
  // bounded shortfall is possible: at a degenerate aspect where `dimsForLongSide`'s short side
  // floors at 1 texel, the margin decouples from `aLong` and the closed form can under-shoot by
  // two, not one — a second upward probe is not worth the extra step for a case this far outside
  // real usage. `max(front) <= maxSize` still holds for every input regardless: the loop only
  // returns a size it has itself verified fits.
  const capA = Math.floor(o.maxSize / (1 + 2 * longFraction))
  let aLong = o.exact ? srcLong : Math.min(o.artworkLongSide ?? Number.POSITIVE_INFINITY, capA + 1)
  for (;;) {
    if (aLong < 1) {
      return new SheetError(
        `paperSheet: maxSize ${o.maxSize} leaves no artwork inside the reserved margin ` +
          `(overscan ${p.toFixed(3)}, spec 8.6)`,
      )
    }
    const artwork = dimsForLongSide(aLong, o.srcW, o.srcH)
    const margins = guardMarginsFor({ artwork, overscan: p })
    const front = { w: artwork.w + 2 * margins.x, h: artwork.h + 2 * margins.y }
    if (o.exact || Math.max(front.w, front.h) <= o.maxSize) {
      return { artwork, marginX: margins.x, marginY: margins.y, front }
    }
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
