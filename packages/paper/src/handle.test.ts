import { describe, expect, it } from 'vitest'
import { KnobError, SheetError } from '@paper-crumple/core'
import type { Size } from '@paper-crumple/core'
import {
  checkGuardBand,
  guardMarginsFor,
  handleBytes,
  KNOB_REFERENCE_PX,
} from '@paper-crumple/core/unstable'
import type { EdgeParams } from '@paper-crumple/core/unstable'
import { packPolygons } from './hull-shape.js'
import {
  checkReserve,
  dimsForLongSide,
  freezeOverscan,
  frontForArtwork,
  handleFactsFor,
} from './handle.js'
import type { PaperSheetHandle } from './handle.js'

const hullDefaults: EdgeParams = {
  mode: 'hull',
  maxDist: 72,
  thickness: 0,
  looseness: 0,
  tearAmp: 0,
  midAmp: 0,
  fiberLen: 0,
}

/** ~40 vertices, which is what a 2 600 px perimeter yields at the default angularity (spec 8.5). */
function fortyVertexHull() {
  const loop: [number, number][] = []
  for (let i = 0; i < 40; i++) {
    const t = (i / 40) * Math.PI * 2
    loop.push([128 + 100 * Math.cos(t), 128 + 100 * Math.sin(t)])
  }
  return packPolygons([loop], 0, 1)
}

function handleAt(srcW: number, srcH: number): PaperSheetHandle {
  return {
    spriteKey: 'k',
    rect: { x: 10, y: 10, w: srcW - 20, h: srcH - 20 },
    frontRect: { x: 2, y: 2, w: 380, h: 380 },
    front: { w: 384, h: 384 },
    artwork: { w: 326, h: 326 },
    marginX: 29,
    marginY: 29,
    overscan: 0.09,
    sdfRes: 192,
    srcW,
    srcH,
    aspect: srcW / srcH,
    exact: false,
    edgeMode: 'hull',
    hull: fortyVertexHull(),
    hullKnobs: { minDist: 22, maxDist: 72, angularity: 0.7, seed: 3 },
    alive: true,
    bytes: 0,
  }
}

describe('the handle holds no image data (spec 8.5, 11)', () => {
  // Spec 8.5 itemises "about 704 B for the ~40 vertices" and a ~1 712 B total, but that is not
  // reproducible from the shipped code: P8's `packPolygons` stores interleaved x, y in a
  // `Float32Array` at 8 B/vertex (not the spec's implied rate) plus a `Uint32Array` of component
  // offsets, so the 40-vertex single-loop fixture is 328 B and the whole handle is 728 B. The
  // code is authoritative over the spec's arithmetic; this is a regression pin on that figure.
  it('costs exactly 728 B and stays under 4 096', () => {
    const bytes = handleBytes(handleFactsFor(handleAt(998, 951)))
    expect(bytes).toBe(728)
    expect(bytes).toBeLessThan(4096)
  })

  it('is independent of source dimensions, which is what would have caught the 45 MB', () => {
    const small = handleBytes(handleFactsFor(handleAt(128, 128)))
    const huge = handleBytes(handleFactsFor(handleAt(4000, 4000)))
    expect(huge).toBe(small)
  })

  it('carries the packed polygon and nothing that scales with the artwork', () => {
    const facts = handleFactsFor(handleAt(998, 951))
    expect(facts.hull).toHaveLength(2)
    expect(facts.hull[0].byteLength).toBe(40 * 2 * 4)
  })
})

describe('freezeOverscan (spec 8.6)', () => {
  // §8.6's "Defaults: hull ~ 0.09" is reachable only from maxDist = 64 - exactly the input
  // core's own overscan.test.ts picks to reproduce that sentence. The spike ships
  // DEFAULT_PARAMS.maxDist = 72, so r = maxDist + slop = 72 + 12 = 84 and
  // p = r / (1000 - 2r) = 84 / 832 ~= 0.10096. This asserts the true derived default.
  it('derives the hull default at about 0.10', () => {
    const reserve = freezeOverscan(hullDefaults, 0)
    expect(KnobError.is(reserve)).toBe(false)
    if (KnobError.is(reserve)) return
    expect(reserve.overscan).toBeGreaterThan(0.08)
    expect(reserve.overscan).toBeLessThan(0.11)
  })

  it('adds headroom to the frozen radius rather than to the overscan', () => {
    const plain = freezeOverscan(hullDefaults, 0)
    const roomy = freezeOverscan(hullDefaults, 0.5)
    expect(KnobError.is(plain)).toBe(false)
    expect(KnobError.is(roomy)).toBe(false)
    if (KnobError.is(plain) || KnobError.is(roomy)) return
    expect(roomy.radius).toBeCloseTo(plain.radius * 1.5, 6)
    expect(roomy.overscan).toBeGreaterThan(plain.overscan)
  })

  it('returns a KnobError rather than NaN when the radius cannot fit the reference plane', () => {
    expect(KnobError.is(freezeOverscan({ ...hullDefaults, maxDist: 600 }, 0))).toBe(true)
  })
})

/** `freezeOverscan(hullDefaults, 0)`'s `overscan`, non-throwing (spec 10.8: no boundary throws). */
function hullOverscan(): number {
  const reserve = freezeOverscan(hullDefaults, 0)
  return KnobError.is(reserve) ? Number.NaN : reserve.overscan
}

describe('frontForArtwork (spec 8.6, per axis)', () => {
  const p = hullOverscan()

  it('derives a finite reserve from the hull defaults (precondition for every case below)', () => {
    expect(Number.isFinite(p)).toBe(true)
  })

  it('reserves a per-axis margin, coinciding on a square and diverging off it, for portrait, square and landscape', () => {
    // design 2026-09-05 §4.2 supersedes the pre-§4.2 uniform-margin figures this test used to
    // pin: the margin is now paint plus guard band, per axis, so it is no longer a single
    // `ceil(overscan * artwork.h)` on every side.
    const cases: Array<{
      srcW: number
      srcH: number
      artwork: Size
      marginX: number
      marginY: number
      front: Size
    }> = [
      {
        srcW: 64,
        srcH: 96,
        artwork: { w: 67, h: 100 },
        marginX: 13,
        marginY: 14,
        front: { w: 93, h: 128 },
      },
      {
        srcW: 64,
        srcH: 64,
        artwork: { w: 100, h: 100 },
        marginX: 14,
        marginY: 14,
        front: { w: 128, h: 128 },
      },
      {
        srcW: 96,
        srcH: 64,
        artwork: { w: 107, h: 71 },
        marginX: 10,
        marginY: 10,
        front: { w: 127, h: 91 },
      },
    ]
    for (const c of cases) {
      const result = frontForArtwork({
        overscan: p,
        srcW: c.srcW,
        srcH: c.srcH,
        maxSize: 128,
        exact: false,
      })
      expect(SheetError.is(result)).toBe(false)
      if (SheetError.is(result)) continue
      expect(Math.max(result.front.w, result.front.h)).toBeLessThanOrEqual(128)
      expect(result.front.w - result.artwork.w).toBe(2 * result.marginX)
      expect(result.front.h - result.artwork.h).toBe(2 * result.marginY)
      const margins = guardMarginsFor({ artwork: result.artwork, overscan: p })
      expect(result.marginX).toBe(margins.x)
      expect(result.marginY).toBe(margins.y)
      expect(result.artwork).toEqual(c.artwork)
      expect(result.marginX).toBe(c.marginX)
      expect(result.marginY).toBe(c.marginY)
      expect(result.front).toEqual(c.front)

      // Maximality: one more texel on the long side would not fit `maxSize`. Computed directly
      // from the margin formula, NOT by calling `frontForArtwork` again with
      // `artworkLongSide: got + 1` — that call internally clamps to `min(got + 1, capA)`, so it
      // would report the requested size fits even when `got` was one texel short of the true
      // maximum (see the regression test below, which pins exactly that bug).
      const longArtwork = dimsForLongSide(
        Math.max(result.artwork.w, result.artwork.h) + 1,
        c.srcW,
        c.srcH,
      )
      const longMargins = guardMarginsFor({ artwork: longArtwork, overscan: p })
      const longFront = {
        w: longArtwork.w + 2 * longMargins.x,
        h: longArtwork.h + 2 * longMargins.y,
      }
      expect(Math.max(longFront.w, longFront.h)).toBeGreaterThan(128)
    }
  })

  it('is maximal at these realistic parameters: capA + 1 is tried before stepping down, finding the texel the closed form alone would leave on the table', () => {
    // Regression for the closed-form estimate under-shooting by exactly one texel, now measured
    // against `guardMarginsFor`'s per-axis margin (design 2026-09-05 §4.2) rather than the
    // pre-§4.2 uniform one.
    for (const maxSize of [135, 152, 169, 489]) {
      const result = frontForArtwork({ overscan: p, srcW: 96, srcH: 64, maxSize, exact: false })
      expect(SheetError.is(result)).toBe(false)
      if (SheetError.is(result)) continue
      expect(Math.max(result.front.w, result.front.h)).toBeLessThanOrEqual(maxSize)

      // Maximality, computed directly (not through frontForArtwork's own clamp — see above).
      const longArtwork = dimsForLongSide(Math.max(result.artwork.w, result.artwork.h) + 1, 96, 64)
      const longMargins = guardMarginsFor({ artwork: longArtwork, overscan: p })
      const longFront = {
        w: longArtwork.w + 2 * longMargins.x,
        h: longArtwork.h + 2 * longMargins.y,
      }
      expect(Math.max(longFront.w, longFront.h)).toBeGreaterThan(maxSize)
    }
  })

  it('honours artworkLongSide and clamps it to what maxSize can hold', () => {
    // design 2026-09-05 §4.2: larger fronts than the pre-§4.2 figures, since the margin now
    // includes the guard band on top of paint.
    for (const { srcW, srcH, front } of [
      { srcW: 64, srcH: 96, front: { w: 367, h: 506 } },
      { srcW: 96, srcH: 64, front: { w: 476, h: 337 } },
    ]) {
      const result = frontForArtwork({
        overscan: p,
        srcW,
        srcH,
        maxSize: 640,
        exact: false,
        artworkLongSide: 400,
      })
      expect(SheetError.is(result)).toBe(false)
      if (SheetError.is(result)) continue
      expect(Math.max(result.artwork.w, result.artwork.h)).toBe(400)
      expect(result.front).toEqual(front)
    }

    const clamped = frontForArtwork({
      overscan: p,
      srcW: 64,
      srcH: 96,
      maxSize: 256,
      exact: false,
      artworkLongSide: 400,
    })
    expect(SheetError.is(clamped)).toBe(false)
    if (SheetError.is(clamped)) return
    expect(Math.max(clamped.front.w, clamped.front.h)).toBeLessThanOrEqual(256)
    expect(clamped.artwork).toEqual({ w: 135, h: 202 })
    expect(clamped.marginX).toBe(26)
    expect(clamped.marginY).toBe(27)
    expect(clamped.front).toEqual({ w: 187, h: 256 })
  })

  it('under exact keeps the source and ignores maxSize and artworkLongSide', () => {
    const result = frontForArtwork({
      overscan: p,
      srcW: 40,
      srcH: 40,
      maxSize: 16,
      exact: true,
      artworkLongSide: 8,
    })
    expect(SheetError.is(result)).toBe(false)
    if (SheetError.is(result)) return
    expect(result.artwork).toEqual({ w: 40, h: 40 })
    const margins = guardMarginsFor({ artwork: { w: 40, h: 40 }, overscan: p })
    expect(result.marginX).toBe(margins.x)
    expect(result.marginY).toBe(margins.y)
    expect(result.front).toEqual({ w: 40 + 2 * margins.x, h: 40 + 2 * margins.y })
  })

  it('returns a SheetError when nothing fits', () => {
    const result = frontForArtwork({ overscan: 0.5, srcW: 10, srcH: 10, maxSize: 1, exact: false })
    expect(SheetError.is(result)).toBe(true)
  })

  // F7: a non-finite input used to reach `aLong -= 1` as NaN, and `NaN < 1` is false, so the
  // `for (;;)` loop spins forever, synchronously — not reachable through `paperSheet()` today
  // (whose overscan is either finite and non-negative or +Infinity, and +Infinity already
  // returns a clean SheetError above `frontForArtwork`; `srcW`/`srcH`/`maxSize` are always
  // finite and positive), but `frontForArtwork` itself is reachable by anyone importing it
  // directly from the package's internals (it is not part of `index.ts`'s public surface — that
  // is `SourceOptions.artworkLongSide`, guarded separately below), so a guard is required
  // regardless. Every case here must return promptly rather than hang.
  it('fails cleanly, rather than looping forever, on a non-finite overscan/srcW/srcH/maxSize', () => {
    expect(
      SheetError.is(
        frontForArtwork({ overscan: NaN, srcW: 10, srcH: 10, maxSize: 20, exact: false }),
      ),
    ).toBe(true)
    expect(
      SheetError.is(
        frontForArtwork({ overscan: p, srcW: NaN, srcH: 10, maxSize: 20, exact: false }),
      ),
    ).toBe(true)
    expect(
      SheetError.is(
        frontForArtwork({ overscan: p, srcW: 10, srcH: NaN, maxSize: 20, exact: false }),
      ),
    ).toBe(true)
    expect(
      SheetError.is(
        frontForArtwork({ overscan: p, srcW: 10, srcH: 10, maxSize: NaN, exact: false }),
      ),
    ).toBe(true)
    expect(
      SheetError.is(
        frontForArtwork({ overscan: Infinity, srcW: 10, srcH: 10, maxSize: 20, exact: false }),
      ),
    ).toBe(true)
  })

  // The finiteness guard alone left two more hangs reachable, both reproduced under `timeout`
  // (exit 124) before this guard existed:
  //   - `srcW: 0, srcH: 0` — finite, but `a = Math.min(1, 0 / 0)` is `NaN`, so `capA` and every
  //     `aLong` are `NaN` too, and `NaN < 1` is false.
  //   - `overscan: -0.5` on a square source — finite, but `1 + 2 x overscan x a === 0`, so
  //     `capA === Infinity`, `margin === -Infinity`, `artwork`/`front` are `NaN`, and
  //     `Infinity - 1 === Infinity` never reaches `aLong < 1`.
  // Both must return a `SheetError` promptly, exactly like the non-finite cases above — this
  // test cannot itself contain an input that hangs: vitest cannot interrupt a synchronous
  // infinite loop, so a hanging case here would hang the whole runner instead of failing it.
  it('fails cleanly, rather than looping forever, on a zero srcW/srcH or a negative overscan', () => {
    expect(
      SheetError.is(frontForArtwork({ overscan: p, srcW: 0, srcH: 0, maxSize: 128, exact: false })),
    ).toBe(true)
    expect(
      SheetError.is(
        frontForArtwork({ overscan: -0.5, srcW: 10, srcH: 10, maxSize: 20, exact: false }),
      ),
    ).toBe(true)
  })

  it('rejects a fractional, zero or non-finite artworkLongSide (a public, unvalidated SourceOptions field)', () => {
    for (const artworkLongSide of [10.5, 0, -1, NaN, Infinity]) {
      const result = frontForArtwork({
        overscan: p,
        srcW: 64,
        srcH: 64,
        maxSize: 128,
        exact: false,
        artworkLongSide,
      })
      expect(SheetError.is(result)).toBe(true)
    }
  })

  it('reserves a wider x margin than y on a landscape source (design 2026-09-05 §4.2)', () => {
    const framing = frontForArtwork({
      overscan: 0.132731,
      srcW: 1200,
      srcH: 400,
      maxSize: 1024,
      exact: false,
    })
    expect(framing).not.toBeInstanceOf(SheetError)
    if (framing instanceof Error) return
    expect(framing.marginX).toBeGreaterThan(framing.marginY)
    expect(framing.front.w).toBe(framing.artwork.w + 2 * framing.marginX)
    expect(framing.front.h).toBe(framing.artwork.h + 2 * framing.marginY)
    expect(Math.max(framing.front.w, framing.front.h)).toBeLessThanOrEqual(1024)
    // The probe must follow the LONG axis: with the y fraction it lands on 770 here (R14),
    // not the 902 the correct long-axis fraction finds.
    expect(framing.artwork.w).toBeGreaterThanOrEqual(900)
  })

  it('never leaves a whole texel of artwork on the table on any aspect', () => {
    // The loop only steps down, so an under-sized `capA` is unrecoverable. Sweep both orientations
    // and assert that one more texel of artwork would NOT have fitted.
    for (const [srcW, srcH] of [
      [800, 800],
      [1200, 400],
      [2400, 800],
      [400, 1600],
      [531, 271],
    ]) {
      const framing = frontForArtwork({
        overscan: 0.132731,
        srcW,
        srcH,
        maxSize: 1024,
        exact: false,
      })
      expect(framing, `${srcW}x${srcH}: ${String((framing as Error)?.message)}`).not.toBeInstanceOf(
        SheetError,
      )
      if (framing instanceof Error) continue
      const aLong = Math.max(framing.artwork.w, framing.artwork.h)
      const bigger = dimsForLongSide(aLong + 1, srcW, srcH)
      const m = guardMarginsFor({ artwork: bigger, overscan: 0.132731 })
      expect(
        Math.max(bigger.w + 2 * m.x, bigger.h + 2 * m.y),
        `${srcW}x${srcH} left a texel unused`,
      ).toBeGreaterThan(1024)
    }
  })

  it('leaves the guard band clear for every aspect it frames', () => {
    for (const [srcW, srcH] of [
      [800, 800],
      [1200, 400],
      [400, 1600],
      [531, 271],
      [433, 768],
    ]) {
      const framing = frontForArtwork({
        overscan: 0.132731,
        srcW,
        srcH,
        maxSize: 1024,
        exact: false,
      })
      expect(framing).not.toBeInstanceOf(SheetError)
      if (framing instanceof Error) continue
      const rho = (105 * framing.front.h) / KNOB_REFERENCE_PX
      const check = checkGuardBand({
        frontSize: framing.front,
        hullExtent: {
          x: framing.marginX - rho,
          y: framing.marginY - rho,
          w: framing.artwork.w + 2 * rho,
          h: framing.artwork.h + 2 * rho,
        },
      })
      expect(check, `${srcW}x${srcH}: ${String(check?.message)}`).toBeUndefined()
    }
  })
})

describe('checkReserve (spec 8.6)', () => {
  it('passes a knob that moves inside the reserve', () => {
    const reserve = freezeOverscan(hullDefaults, 0.5)
    expect(KnobError.is(reserve)).toBe(false)
    if (KnobError.is(reserve)) return
    expect(checkReserve(reserve, { ...hullDefaults, maxDist: 80 })).toBeUndefined()
  })

  it('names "re-add required" rather than clamping when a knob leaves it', () => {
    const reserve = freezeOverscan(hullDefaults, 0)
    expect(KnobError.is(reserve)).toBe(false)
    if (KnobError.is(reserve)) return
    const err = checkReserve(reserve, { ...hullDefaults, maxDist: 140 })
    expect(SheetError.is(err)).toBe(true)
    expect(err?.message).toContain('re-add required')
    expect(err?.message).toContain('overscanHeadroom')
  })
})
