import { describe, expect, it } from 'vitest'
import { KnobError, SheetError } from '@paper-crumple/core'
import type { Size } from '@paper-crumple/core'
import { handleBytes } from '@paper-crumple/core/unstable'
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

  it('reserves the same number of texels on every side, for portrait, square and landscape', () => {
    const cases: Array<{ srcW: number; srcH: number; artwork: Size; margin: number; front: Size }> =
      [
        { srcW: 64, srcH: 96, artwork: { w: 71, h: 106 }, margin: 11, front: { w: 93, h: 128 } },
        { srcW: 64, srcH: 64, artwork: { w: 106, h: 106 }, margin: 11, front: { w: 128, h: 128 } },
        { srcW: 96, srcH: 64, artwork: { w: 112, h: 75 }, margin: 8, front: { w: 128, h: 91 } },
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
      expect(result.front.w - result.artwork.w).toBe(2 * result.margin)
      expect(result.front.h - result.artwork.h).toBe(2 * result.margin)
      expect(result.margin).toBe(Math.ceil(p * result.artwork.h))
      expect(result.artwork).toEqual(c.artwork)
      expect(result.margin).toBe(c.margin)
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
      const longMargin = Math.ceil(p * longArtwork.h)
      const longFront = {
        w: longArtwork.w + 2 * longMargin,
        h: longArtwork.h + 2 * longMargin,
      }
      expect(Math.max(longFront.w, longFront.h)).toBeGreaterThan(128)
    }
  })

  it('is maximal: capA + 1 is tried before stepping down, so the loop never leaves a spare texel on the table', () => {
    // Regression for the closed-form estimate under-shooting by exactly one texel: at the hull
    // overscan (p = 84/832), a 96x64 source's front cap `floor(maxSize / (1 + 2p·(64/96)))` is
    // one texel below the true maximum for these four `maxSize` values. Confirmed by hand:
    // 135 -> 118 (119 fits), 152 -> 133 (134 fits), 169 -> 148 (149 fits), 489 -> 430 (431 fits).
    for (const maxSize of [135, 152, 169, 489]) {
      const result = frontForArtwork({ overscan: p, srcW: 96, srcH: 64, maxSize, exact: false })
      expect(SheetError.is(result)).toBe(false)
      if (SheetError.is(result)) continue
      expect(Math.max(result.front.w, result.front.h)).toBeLessThanOrEqual(maxSize)

      // Maximality, computed directly (not through frontForArtwork's own clamp — see above).
      const longArtwork = dimsForLongSide(Math.max(result.artwork.w, result.artwork.h) + 1, 96, 64)
      const longMargin = Math.ceil(p * longArtwork.h)
      const longFront = {
        w: longArtwork.w + 2 * longMargin,
        h: longArtwork.h + 2 * longMargin,
      }
      expect(Math.max(longFront.w, longFront.h)).toBeGreaterThan(maxSize)
    }
  })

  it('honours artworkLongSide and clamps it to what maxSize can hold', () => {
    for (const { srcW, srcH, front } of [
      { srcW: 64, srcH: 96, front: { w: 349, h: 482 } },
      { srcW: 96, srcH: 64, front: { w: 454, h: 321 } },
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
    expect(clamped.artwork).toEqual({ w: 141, h: 212 })
    expect(clamped.margin).toBe(22)
    expect(clamped.front).toEqual({ w: 185, h: 256 })
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
    const margin = Math.ceil(p * 40)
    expect(result.margin).toBe(margin)
    expect(result.front).toEqual({ w: 40 + 2 * margin, h: 40 + 2 * margin })
  })

  it('returns a SheetError when nothing fits', () => {
    const result = frontForArtwork({ overscan: 0.5, srcW: 10, srcH: 10, maxSize: 1, exact: false })
    expect(SheetError.is(result)).toBe(true)
  })

  // F7: a non-finite input used to reach `aLong -= 1` as NaN, and `NaN < 1` is false, so the
  // `for (;;)` loop spins forever, synchronously — not reachable through `paperSheet()` today
  // (whose overscan is either finite or +Infinity, and +Infinity already returns a clean
  // SheetError above `frontForArtwork`), but this function is exported, so a guard is required
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
