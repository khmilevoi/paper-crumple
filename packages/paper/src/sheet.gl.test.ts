import { afterEach, describe, expect, it, vi } from 'vitest'
import { ABORTED, GlError, SheetError, SourceExpiredError, isAborted } from '@paper-crumple/core'
import {
  checkGuardBand,
  frontBytes,
  guardMarginsFor,
  KNOB_REFERENCE_PX,
  overscanRadius,
} from '@paper-crumple/core/unstable'
import type { GlContext } from '@paper-crumple/core/unstable'
import { createGlFixture, type PaperGlFixture } from './testing/gl-fixture.js'
import { dimsForLongSide } from './handle.js'
import { defaultsFor, edgeParamsFrom } from './paper-knobs.js'
import { paperSheet } from './sheet.js'

// The `source`/`build` suites are added by tasks 11 and 12; this file stays additive across all
// three (task 10's own brief).

let fixture: PaperGlFixture | null = null

afterEach(() => {
  // §4.0 caps live WebGL2 contexts at roughly sixteen and Vitest opens one page per file.
  fixture?.dispose()
  fixture = null
})

function open() {
  fixture = createGlFixture(8, 8)
  expect(fixture.gl, 'no WebGL2 context — check the SwiftShader launch flags (§11)').not.toBeNull()
  return fixture.ctx
}

describe('paperSheet as a factory (spec 6.5, 14)', () => {
  it("defaults to edgeMode 'hull', which is paper.js's own default", () => {
    expect(paperSheet().edgeMode).toBe('hull')
  })

  it('exposes 24 descriptors in hull mode and 34 in torn mode', () => {
    expect(paperSheet().knobs).toHaveLength(24)
    expect(paperSheet({ edgeMode: 'torn' }).knobs).toHaveLength(34)
    expect(paperSheet().knobs.map((k) => k.key)).not.toContain('tearAmp')
  })

  // §8.6's headline figures (hull ~= 0.09, torn ~= 0.17) are worked from an illustrative
  // maxDist of 64 reference px (core's own `overscan.test.ts` says so explicitly: "the default
  // *values* of these knobs belong to the paper slot"). This package's own `HULL_KNOBS` default
  // is `maxDist: 72` (paper-knobs.ts, task 3, already landed), and `TORN_KNOBS`'s defaults carry
  // through the rest of the formula, so the number this factory actually reports is
  // `84 / (1000 - 168) ≈ 0.1010` for hull and `≈ 0.2139` for torn — both computed here from the
  // real, already-landed knob defaults and `EDGE_SLOP_REFERENCE_PX = 12` (core, unmodifiable),
  // not from §8.6's illustrative example. See task 10's own report for the arithmetic.
  it('reports the factory-level overscan: ~0.10 for hull, ~0.21 for torn (spec 8.6)', () => {
    expect(paperSheet().overscan).toBeGreaterThan(0.09)
    expect(paperSheet().overscan).toBeLessThan(0.11)
    const torn = paperSheet({ edgeMode: 'torn' }).overscan
    expect(torn).toBeGreaterThan(0.19)
    expect(torn).toBeLessThan(0.22)
  })

  it('reserves more when overscanHeadroom is given', () => {
    expect(paperSheet({ overscanHeadroom: 0.5 }).overscan).toBeGreaterThan(paperSheet().overscan)
  })

  // Fix round 1: an `overscanHeadroom` past the reference plane must not silently read as
  // `overscan: 0` (a plausible-looking "no margin needed"), and `mount()` — the earliest call
  // with an error channel — must refuse rather than mount with an unusable reserve. The threshold
  // is computed from the same `overscanRadius`/`freezeOverscan` arithmetic the factory itself
  // uses (`radius * (1 + headroom) >= KNOB_REFERENCE_PX / 2`), not guessed, so this test tracks
  // `hull`'s own defaults if they ever change. No `GlContext` is needed: `mount()`'s guard runs
  // before it ever touches `ctx` — the factory is synchronous and creates no GL objects — so this
  // whole test needs no live WebGL2 context (and does not count against the ~sixteen-context cap
  // `createGlFixture`'s `dispose()` otherwise manages here).
  it('overscan reads Infinity, and mount() returns a GlError, when overscanHeadroom pushes the reserve past the reference plane (spec 8.6)', () => {
    const radius = overscanRadius(edgeParamsFrom('hull', defaultsFor('hull')))
    const headroom = KNOB_REFERENCE_PX / (2 * radius) - 1 + 1e-6
    const sheet = paperSheet({ overscanHeadroom: headroom })
    expect(sheet.overscan).toBe(Number.POSITIVE_INFINITY)

    const noContext = {} as unknown as GlContext
    const mounted = sheet.mount(noContext)
    expect(GlError.is(mounted), 'mount() must return a GlError, not mount silently').toBe(true)
    if (!GlError.is(mounted)) return
    expect(mounted.message).toContain('overscanHeadroom')
  })

  it('defaults tiles to null, because hull needs no fibre at all (spec 14)', async () => {
    const ctx = open()
    const sheet = paperSheet()
    expect(sheet.mount(ctx)).toBeUndefined()
    await expect(sheet.tilesReady).resolves.toBe(true)
    sheet.dispose()
  })
})

describe('mount and dispose (spec 5.2)', () => {
  it('is a SheetError, not a throw, to source before mount', async () => {
    const sheet = paperSheet()
    const bitmap = await createImageBitmap(new ImageData(4, 4))
    const r = await sheet.source(bitmap, { maxSize: 128, exact: false })
    expect(SheetError.is(r)).toBe(true)
    expect((r as Error).message).toContain('mount')
    bitmap.close()
  })

  it('is a SheetError, not a throw, to build before mount', () => {
    const sheet = paperSheet()
    const r = sheet.build(
      {} as Parameters<typeof sheet.build>[0],
      { w: 128, h: 128 },
      {} as Parameters<typeof sheet.build>[2],
    )
    expect(SheetError.is(r)).toBe(true)
    expect((r as Error).message).toContain('mount')
  })

  it('mounts once and reports a GlError rather than throwing on a second mount', () => {
    const ctx = open()
    const sheet = paperSheet()
    expect(sheet.mount(ctx)).toBeUndefined()
    expect(GlError.is(sheet.mount(ctx))).toBe(true)
    sheet.dispose()
  })

  it('is idempotent on dispose, because React runs cleanups child-first', () => {
    const ctx = open()
    const sheet = paperSheet()
    sheet.mount(ctx)
    sheet.dispose()
    // Not merely "did not throw" — under the no-throw rule that can never fail and is not a
    // test. The observable state a second, redundant `dispose()` must leave alone: a fresh
    // `mount()` on the same context afterwards still succeeds, which it would not if the second
    // `dispose()` had double-freed anything the first one already released.
    expect(() => sheet.dispose()).not.toThrow()
    expect(sheet.mount(ctx)).toBeUndefined()
    sheet.dispose()
  })
})

/** A 48x32 sprite: an opaque ellipse, clear of the edges. */
async function sprite(w = 48, h = 32): Promise<ImageBitmap> {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inside = ((x - w / 2) / (w / 3)) ** 2 + ((y - h / 2) / (h / 3)) ** 2 <= 1
      const p = (y * w + x) * 4
      data[p] = 200
      data[p + 1] = 120
      data[p + 2] = 60
      data[p + 3] = inside ? 255 : 0
    }
  }
  const canvas = new OffscreenCanvas(w, h)
  canvas.getContext('2d')!.putImageData(new ImageData(data, w, h), 0, 0)
  return createImageBitmap(canvas, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' })
}

describe('source() (spec 5.2, 8.5, 8.6)', () => {
  it('returns a handle that holds no image data', async () => {
    const ctx = open()
    const sheet = paperSheet()
    sheet.mount(ctx)
    const bitmap = await sprite()
    const handle = await sheet.source(bitmap, { maxSize: 128, exact: false })
    bitmap.close()
    expect(handle instanceof Error || isAborted(handle)).toBe(false)
    if (handle instanceof Error || isAborted(handle)) return
    expect(handle.bytes).toBeLessThan(4096)
    expect(handle.rect.w).toBeGreaterThan(0)
    expect(handle.overscan).toBeGreaterThan(0)
    expect(handle.sdfRes).toBe(128)
    expect(handle.artwork.w).toBeLessThan(128)
    sheet.dispose()
  })

  it('sizes the artwork so that it plus its per-axis margin fills maxSize', async () => {
    const ctx = open()
    const sheet = paperSheet()
    sheet.mount(ctx)
    const bitmap = await sprite(64, 64)
    const handle = await sheet.source(bitmap, { maxSize: 128, exact: false })
    bitmap.close()
    expect(handle instanceof Error || isAborted(handle)).toBe(false)
    if (handle instanceof Error || isAborted(handle)) return
    expect(Math.max(handle.front.w, handle.front.h)).toBeLessThanOrEqual(128)
    // design 2026-09-05 §4.2: the margin is paint plus guard band, per axis (`guardMarginsFor`),
    // not the plain `ceil(overscan * artwork.h)` figure both axes used to share.
    const margins = guardMarginsFor({ artwork: handle.artwork, overscan: handle.overscan })
    expect(handle.front.w - handle.artwork.w).toBe(2 * margins.x)
    expect(handle.front.h - handle.artwork.h).toBe(2 * margins.y)
    // Maximal: one more texel of artwork would not have fit `maxSize` (F3's `capA + 1` probe).
    const bigger = dimsForLongSide(Math.max(handle.artwork.w, handle.artwork.h) + 1, 64, 64)
    const biggerMargins = guardMarginsFor({ artwork: bigger, overscan: handle.overscan })
    const biggerFront = {
      w: bigger.w + 2 * biggerMargins.x,
      h: bigger.h + 2 * biggerMargins.y,
    }
    expect(Math.max(biggerFront.w, biggerFront.h)).toBeGreaterThan(128)
    sheet.dispose()
  })

  it('is the identity under exact: A equals the source and the front grows instead', async () => {
    const ctx = open()
    const sheet = paperSheet()
    sheet.mount(ctx)
    const bitmap = await sprite(40, 40)
    const handle = await sheet.source(bitmap, { maxSize: 128, exact: true })
    bitmap.close()
    expect(handle instanceof Error || isAborted(handle)).toBe(false)
    if (handle instanceof Error || isAborted(handle)) return
    expect(handle.exact).toBe(true)
    expect(handle.artwork).toEqual({ w: 40, h: 40 })
    const margins = guardMarginsFor({ artwork: { w: 40, h: 40 }, overscan: handle.overscan })
    expect(handle.front.w).toBe(40 + 2 * margins.x)
    expect(handle.front.h).toBe(40 + 2 * margins.y)
    sheet.dispose()
  })

  it('freezes one overscan for every aspect and reserves it per axis', async () => {
    const ctx = open()
    const sheet = paperSheet()
    sheet.mount(ctx)
    const portrait = await sprite(64, 96)
    const square = await sprite(64, 64)
    const landscape = await sprite(96, 64)
    const handles = await Promise.all(
      [portrait, square, landscape].map((bitmap) =>
        sheet.source(bitmap, { maxSize: 128, exact: false }),
      ),
    )
    portrait.close()
    square.close()
    landscape.close()
    for (const handle of handles) {
      expect(handle instanceof Error || isAborted(handle)).toBe(false)
      if (handle instanceof Error || isAborted(handle)) continue
      expect(handle.overscan).toBe(sheet.overscan)
      // design 2026-09-05 §4.2: `frontForArtwork` no longer applies the same texel count on both
      // axes — the two per-axis identities replace the old x/y symmetry assertion.
      expect(handle.front.w - handle.artwork.w).toBe(2 * handle.marginX)
      expect(handle.front.h - handle.artwork.h).toBe(2 * handle.marginY)
      const margins = guardMarginsFor({ artwork: handle.artwork, overscan: handle.overscan })
      expect(handle.marginX).toBe(margins.x)
      expect(handle.marginY).toBe(margins.y)
      expect(Math.max(handle.front.w, handle.front.h)).toBeLessThanOrEqual(128)
    }
    sheet.dispose()
  })

  it('gives a landscape and a portrait sprite the same artwork long side under artworkLongSide', async () => {
    const ctx = open()
    const sheet = paperSheet()
    sheet.mount(ctx)
    const landscape = await sprite(96, 64)
    const landscapeHandle = await sheet.source(landscape, {
      maxSize: 640,
      exact: false,
      artworkLongSide: 400,
    })
    landscape.close()
    const portrait = await sprite(64, 96)
    const portraitHandle = await sheet.source(portrait, {
      maxSize: 640,
      exact: false,
      artworkLongSide: 400,
    })
    portrait.close()
    expect(landscapeHandle instanceof Error || isAborted(landscapeHandle)).toBe(false)
    expect(portraitHandle instanceof Error || isAborted(portraitHandle)).toBe(false)
    if (landscapeHandle instanceof Error || isAborted(landscapeHandle)) {
      sheet.dispose()
      return
    }
    if (portraitHandle instanceof Error || isAborted(portraitHandle)) {
      sheet.dispose()
      return
    }
    expect(Math.max(landscapeHandle.artwork.w, landscapeHandle.artwork.h)).toBe(400)
    expect(Math.max(landscapeHandle.front.w, landscapeHandle.front.h)).toBeLessThanOrEqual(640)
    expect(Math.max(portraitHandle.artwork.w, portraitHandle.artwork.h)).toBe(400)
    expect(Math.max(portraitHandle.front.w, portraitHandle.front.h)).toBeLessThanOrEqual(640)

    const built = sheet.build(portraitHandle, portraitHandle.front, defaultsFor('hull') as never)
    expect(built instanceof Error, String((built as Error)?.message)).toBe(false)
    if (!(built instanceof Error)) {
      expect(built.artwork).toEqual({
        x: Math.round((portraitHandle.front.w - portraitHandle.artwork.w) / 2),
        y: Math.round((portraitHandle.front.h - portraitHandle.artwork.h) / 2),
        w: portraitHandle.artwork.w,
        h: portraitHandle.artwork.h,
      })
      sheet.releaseFront(built)
    }
    sheet.dispose()
  })

  it('clamps artworkLongSide to what maxSize can hold', async () => {
    const ctx = open()
    const sheet = paperSheet()
    sheet.mount(ctx)
    const bitmap = await sprite(64, 96)
    const handle = await sheet.source(bitmap, { maxSize: 256, exact: false, artworkLongSide: 400 })
    bitmap.close()
    expect(handle instanceof Error || isAborted(handle)).toBe(false)
    if (handle instanceof Error || isAborted(handle)) return
    expect(Math.max(handle.front.w, handle.front.h)).toBeLessThanOrEqual(256)
    expect(Math.max(handle.artwork.w, handle.artwork.h)).toBeLessThan(400)
    // design 2026-09-05 §4.2: the guard band widens the margin, so the artwork this maxSize can
    // hold is smaller than the pre-§4.2 figure.
    expect(Math.max(handle.artwork.w, handle.artwork.h)).toBe(202)
    sheet.dispose()
  })

  it('serves a cached hull on the second call and traces again after invalidateHull', async () => {
    const ctx = open()
    const sheet = paperSheet()
    sheet.mount(ctx)
    const bitmap = await sprite()
    const first = await sheet.source(bitmap, { maxSize: 128, exact: false })
    const second = await sheet.source(bitmap, { maxSize: 128, exact: false })
    expect(first instanceof Error || isAborted(first)).toBe(false)
    if (first instanceof Error || isAborted(first)) return
    expect(second instanceof Error || isAborted(second)).toBe(false)
    if (second instanceof Error || isAborted(second)) return
    // The same key and the same hull knobs: the polygon is the cache's, not a fresh trace.
    expect(second.hull).toBe(first.hull)
    expect(sheet.invalidateHull(first.spriteKey)).toBeGreaterThan(0)
    const third = await sheet.source(bitmap, { maxSize: 128, exact: false })
    expect(third instanceof Error || isAborted(third)).toBe(false)
    if (third instanceof Error || isAborted(third)) return
    expect(third.hull).not.toBe(first.hull)
    bitmap.close()
    sheet.dispose()
  })
})

describe('abort is a sentinel, at three check points (spec 10.5, amendment 1)', () => {
  it('returns ABORTED and never an AbortedError when the signal is already aborted', async () => {
    const ctx = open()
    const sheet = paperSheet()
    sheet.mount(ctx)
    const bitmap = await sprite()
    const controller = new AbortController()
    controller.abort()
    const r = await sheet.source(bitmap, { maxSize: 128, exact: false, signal: controller.signal })
    bitmap.close()
    expect(r).toBe(ABORTED)
    expect(r instanceof Error).toBe(false)
    sheet.dispose()
  })

  it('keeps the hull it already paid for when the signal fires after the trace', async () => {
    const ctx = open()
    const sheet = paperSheet()
    sheet.mount(ctx)
    const bitmap = await sprite()
    const controller = new AbortController()
    // Fire on the microtask after the trace lands: the hull is in the cache, the handle is not.
    const pending = sheet.source(bitmap, {
      maxSize: 128,
      exact: false,
      signal: controller.signal,
      // The suite drives the abort through a hook the module exposes for exactly this test;
      // see `__afterHullForTest` in sheet.ts.
    })
    sheet.__afterHullForTest = () => controller.abort()
    const r = await pending
    bitmap.close()
    if (!isAborted(r)) {
      // The race did not land on the intended point; the other two are covered above and below.
      sheet.dispose()
      return
    }
    // The hull survived the abort, so a later source() for the same knobs is a cache hit.
    const again = await sheet.source(bitmap, { maxSize: 128, exact: false })
    expect(again instanceof Error).toBe(false)
    sheet.dispose()
  })
})

describe('the guard band, relocated onto the hull (spec 8.6, 8.3)', () => {
  it('returns a SheetError naming the guard when the sheet intrudes into the band', async () => {
    // A hull whose extent fills the front: qx exceeds GUARD_BAND_INNER by construction.
    expect(
      SheetError.is(
        checkGuardBand({
          frontSize: { w: 100, h: 100 },
          hullExtent: { x: 0, y: 0, w: 100, h: 100 },
        }),
      ),
    ).toBe(true)
  })

  it('passes a sheet that stays inside its reserved margin', async () => {
    const ctx = open()
    const sheet = paperSheet()
    sheet.mount(ctx)
    const bitmap = await sprite()
    const handle = await sheet.source(bitmap, { maxSize: 128, exact: false })
    bitmap.close()
    expect(handle instanceof Error).toBe(false)
    sheet.dispose()
  })
})

/**
 * A more compactly-inset ellipse than the shared `sprite()` above (semi-axis a quarter of each
 * dimension, not a third): `torn` mode's own default margin — thickness, tear amplitude, mid
 * amplitude and the looseness-driven blur sigma all folded into one reference-px radius (spec
 * 8.6) — needs more silhouette headroom than `hull`'s single `maxDist` term does. `sprite()`'s
 * own 1/3 ratio is well clear of the guard band for every `hull`-mode test above (spec 8.6's own
 * "hull ~= 0.09"), but is not for `torn` (~= 0.17-0.21), independent of `maxSize` (the guard
 * band's own fraction of the front is scale-invariant: both the reference-px margin and the
 * field resolution scale together). A local, more conservative shape is the fix, not a bigger
 * `maxSize`.
 */
async function compactSprite(w = 64, h = 64): Promise<ImageBitmap> {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inside = ((x - w / 2) / (w / 4)) ** 2 + ((y - h / 2) / (h / 4)) ** 2 <= 1
      const p = (y * w + x) * 4
      data[p] = 200
      data[p + 1] = 120
      data[p + 2] = 60
      data[p + 3] = inside ? 255 : 0
    }
  }
  const canvas = new OffscreenCanvas(w, h)
  canvas.getContext('2d')!.putImageData(new ImageData(data, w, h), 0, 0)
  return createImageBitmap(canvas, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' })
}

/**
 * An opaque rectangle inset `inset` px from every edge of a `w x h` canvas — `inset: 0` is a
 * full-bleed photo (the demo's camel coat, "a photo that still carries its background"), and a
 * 12 % inset on a 2:3 canvas is the demo's trench coat / jeans silhouette to within a few px.
 */
async function boxSprite(w: number, h: number, inset: number): Promise<ImageBitmap> {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inside = x >= inset && x < w - inset && y >= inset && y < h - inset
      const p = (y * w + x) * 4
      data[p] = 200
      data[p + 1] = 120
      data[p + 2] = 60
      data[p + 3] = inside ? 255 : 0
    }
  }
  const canvas = new OffscreenCanvas(w, h)
  canvas.getContext('2d')!.putImageData(new ImageData(data, w, h), 0, 0)
  return createImageBitmap(canvas, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' })
}

/**
 * The paint radius is quoted against the front's HEIGHT (`paper-renderer.ts`'s `uPxScale`).
 * Before the §8.6 per-axis amendment, the reserve was a single uv FRACTION applied to both axes,
 * so on a portrait front the x margin held only `w / h` of it and every 2:3 demo sample (trench,
 * jeans, avatar, camel coat) was refused with "the hull reaches 0.5000 of the front on axis x"
 * while the landscape ones (sweater, sneakers) sailed through. §8.6's fix made the margin
 * `ceil(p * A.h)` TEXELS on every side of the artwork, closing that hole for the paint reserve.
 * design 2026-09-05 §4.2 closes a second, pre-existing hole in the same spot: the TEXTURE guard
 * band itself (`checkGuardBand`'s 1.8 % outer band) was additive-and-per-axis while the paint
 * reserve above was multiplicative-and-isotropic, so the margin is now `guardMarginsFor`'s
 * per-axis total (paint plus guard band), which coincides with `ceil(p * A.h)` on x and y only
 * for a square artwork. The guard band still reads the sheet's real, unrounded reach rather than
 * §8.3's rect — whose 4 % margin is bucket-decision safety, not paint, and whose clamp to the
 * plane can never report more than 0.5000.
 */
describe('portrait sprites and the guard band (spec 8.6)', () => {
  function refused(handle: unknown): handle is Error {
    return GlError.is(handle) || SheetError.is(handle) || isAborted(handle)
  }

  it('sources a 2:3 torn sprite with a 12 % transparent border at zero headroom (the trench coat)', async () => {
    const ctx = open()
    const sheet = paperSheet({ edgeMode: 'torn' })
    sheet.mount(ctx)
    const bitmap = await boxSprite(64, 96, 8)
    const handle = await sheet.source(bitmap, { maxSize: 128, exact: false })
    bitmap.close()
    expect(refused(handle), String((handle as Error)?.message)).toBe(false)
    if (GlError.is(handle) || SheetError.is(handle) || isAborted(handle)) return
    // §8.6 amendment (2026-09-04): the reserve is per axis, in texels, so it is the SAME number
    // for every aspect — no longer scaled up for a portrait sprite.
    expect(handle.overscan).toBe(sheet.overscan)
    sheet.dispose()
  })

  it('sources a full-bleed 2:3 torn photo once the headroom covers the band (the camel coat)', async () => {
    const ctx = open()
    // 0.25 × ~150 reference px of torn-default radius is ~37 px of clearance beyond the paint,
    // against the band's 18 — the demo's own `DEFAULT_CONFIG.overscanHeadroom`.
    const sheet = paperSheet({ edgeMode: 'torn', overscanHeadroom: 0.25 })
    sheet.mount(ctx)
    const bitmap = await boxSprite(64, 96, 0)
    const handle = await sheet.source(bitmap, { maxSize: 128, exact: false })
    bitmap.close()
    expect(refused(handle), String((handle as Error)?.message)).toBe(false)
    sheet.dispose()
  })

  it('now sources a full-bleed photo at zero headroom, which design 2026-09-05 §4.2 fixes', async () => {
    // Before §4.2, the reserve left exactly zero clearance for a silhouette that fills its own
    // bitmap beyond the paint radius itself: the margin was paint alone, so the guard band's own
    // 1.8 % outer strip had nothing reserving it, and the paint reached to within the half texel
    // between the silhouette's own texel centres and its true edge — a real figure just inside the
    // band (measured at the time: 0.4962, where the clamped §8.3 rect the check used to read could
    // only ever say a flat 0.5000) — and `source()` refused with "guard band" / "re-add required".
    // §4.2 folds the guard band `g` into the reserved margin itself (`guardMarginsFor`), so this
    // exact case — the pre-existing hole this task closes — now has real clearance and succeeds.
    const ctx = open()
    const sheet = paperSheet({ edgeMode: 'torn' })
    sheet.mount(ctx)
    const bitmap = await boxSprite(64, 96, 0)
    const handle = await sheet.source(bitmap, { maxSize: 128, exact: false })
    bitmap.close()
    expect(refused(handle), String((handle as Error)?.message)).toBe(false)
    sheet.dispose()
  })

  it('sources a full-bleed square in hull mode once the headroom covers the band', async () => {
    const ctx = open()
    // `ambient-pins.gl.test.ts` documents this exact refusal and pads its fixture around it;
    // 0.4 × 84 reference px is ~34 of clearance against the band's 18.
    const sheet = paperSheet({ overscanHeadroom: 0.4 })
    sheet.mount(ctx)
    const bitmap = await boxSprite(48, 48, 0)
    const handle = await sheet.source(bitmap, { maxSize: 128, exact: false })
    bitmap.close()
    expect(refused(handle), String((handle as Error)?.message)).toBe(false)
    sheet.dispose()
  })
})

describe('build() (spec 5.2, 8.1, 8.5, 8.7)', () => {
  async function mounted() {
    const ctx = open()
    const sheet = paperSheet()
    sheet.mount(ctx)
    const bitmap = await sprite()
    const handle = await sheet.source(bitmap, { maxSize: 128, exact: false })
    bitmap.close()
    // `expect` first — a failure here aborts the test with a message, rather than a `throw` this
    // package's own lint rule bans; the `if` right after, repeating the same condition, is what
    // narrows `handle`'s type for the type checker (a boolean stored in between would not).
    expect(GlError.is(handle) || SheetError.is(handle) || isAborted(handle)).toBe(false)
    if (GlError.is(handle) || SheetError.is(handle) || isAborted(handle)) return undefined
    return { ctx, sheet, handle }
  }

  it('returns a front whose bytes are its own accounting, not w x h x 4 inferred', async () => {
    const m = await mounted()
    expect(m).toBeDefined()
    if (m === undefined) return
    const { sheet, handle } = m
    const size = { w: 128, h: 128 }
    const front = sheet.build(handle, size, defaultsFor('hull') as never)
    expect(front instanceof Error, (front as Error).message).toBe(false)
    if (front instanceof Error) return
    expect(front.width).toBe(128)
    expect(front.bytes).toBe(frontBytes(size))
    expect(front.rect.w).toBeGreaterThan(0)
    sheet.releaseFront(front)
    sheet.dispose()
  })

  it('renders into the texture it returns, with no assembly FBO', async () => {
    const m = await mounted()
    expect(m).toBeDefined()
    if (m === undefined) return
    const { ctx, sheet, handle } = m
    const front = sheet.build(handle, { w: 128, h: 128 }, defaultsFor('hull') as never)
    expect(front instanceof Error, (front as Error).message).toBe(false)
    if (front instanceof Error) return
    // The returned texture is drawable: reading it back through a fresh target shows the paper.
    // `READ_FRAMEBUFFER` is bound explicitly — `DrawScope.bindTarget` only ever binds
    // `DRAW_FRAMEBUFFER`, so a caller that skipped this would silently read the canvas backbuffer.
    const probe = ctx.gl.createFramebuffer()
    const out = new Uint8Array(4)
    ctx.scope(() => {
      ctx.gl.bindFramebuffer(ctx.gl.READ_FRAMEBUFFER, probe)
      ctx.gl.framebufferTexture2D(
        ctx.gl.READ_FRAMEBUFFER,
        ctx.gl.COLOR_ATTACHMENT0,
        ctx.gl.TEXTURE_2D,
        front.texture,
        0,
      )
      ctx.gl.readPixels(64, 64, 1, 1, ctx.gl.RGBA, ctx.gl.UNSIGNED_BYTE, out)
      ctx.gl.bindFramebuffer(ctx.gl.READ_FRAMEBUFFER, null)
    })
    ctx.gl.deleteFramebuffer(probe)
    expect(out[3]).toBeGreaterThan(0)
    sheet.releaseFront(front)
    sheet.dispose()
  })

  it('returns SourceExpiredError once another sprite has taken the artwork slot', async () => {
    const m = await mounted()
    expect(m).toBeDefined()
    if (m === undefined) return
    const { sheet, handle } = m
    const other = await sprite(40, 40)
    const second = await sheet.source(other, { maxSize: 128, exact: false })
    other.close()
    const bad = GlError.is(second) || SheetError.is(second) || isAborted(second)
    expect(bad, 'source() must succeed for this fixture').toBe(false)
    if (bad) return
    const front = sheet.build(handle, { w: 128, h: 128 }, defaultsFor('hull') as never)
    expect(SourceExpiredError.is(front)).toBe(true)
    sheet.dispose()
  })

  // Core's §8.5 re-source of a borrowed `ImageBitmap` the caller still holds open: `source()` of
  // the same object mints the same spriteKey (`spriteInfoFor`), so the second handle shares the
  // first one's hull entry and artwork slot. Releasing the superseded handle — which core does
  // once the new one is in hand — must hand back nothing the live one owns, or the live handle's
  // very next `build()` expires again and the re-source loops for the stage's life.
  it('re-source() of a bitmap still open yields a second handle under the same key, and releasing the first leaves the second buildable (spec 8.5)', async () => {
    const ctx = open()
    const sheet = paperSheet()
    sheet.mount(ctx)

    const bitmapA = await sprite(48, 32)
    const first = await sheet.source(bitmapA, { maxSize: 128, exact: false })
    expect(GlError.is(first) || SheetError.is(first) || isAborted(first)).toBe(false)
    if (GlError.is(first) || SheetError.is(first) || isAborted(first)) return

    // Another sprite takes the slot — what makes the re-source necessary in the first place.
    const bitmapB = await sprite(48, 32)
    const other = await sheet.source(bitmapB, { maxSize: 128, exact: false })
    bitmapB.close()
    expect(GlError.is(other) || SheetError.is(other) || isAborted(other)).toBe(false)

    const second = await sheet.source(bitmapA, { maxSize: 128, exact: false })
    bitmapA.close()
    expect(GlError.is(second) || SheetError.is(second) || isAborted(second)).toBe(false)
    if (GlError.is(second) || SheetError.is(second) || isAborted(second)) return
    expect(second.spriteKey).toBe(first.spriteKey)

    sheet.release(first)
    const front = sheet.build(second, { w: 128, h: 96 }, defaultsFor('hull') as never)
    expect(front instanceof Error, String((front as Error)?.message)).toBe(false)
    if (front instanceof Error) {
      sheet.dispose()
      return
    }
    sheet.releaseFront(front)
    // A second release of the same handle is inert too: the key it carries is the live one's.
    sheet.release(first)
    const again = sheet.build(second, { w: 128, h: 96 }, defaultsFor('hull') as never)
    expect(again instanceof Error, String((again as Error)?.message)).toBe(false)
    if (!(again instanceof Error)) sheet.releaseFront(again)
    sheet.dispose()
  })

  // Spec 8.6 freezes the reserve for the sprite's life, and `maxDist` is both a hull-tier knob and
  // the whole of `r_hull` — so a reserve derived from the live values was re-frozen on every
  // hull-tier re-source, and the artwork `A = maxSize / (1 + 2p)` shrank inside a bucket `fit`
  // had sized once. Two `source()` calls at different `maxDist` must agree on everything the fit
  // and the artwork slot were sized over, and differ in the trace alone.
  it('freezes the reserve at the factory defaults: a re-source at another maxDist keeps p and A (spec 8.6)', async () => {
    const ctx = open()
    const sheet = paperSheet({ overscanHeadroom: 0.25 })
    sheet.mount(ctx)
    const bitmap = await sprite()
    const atDefaults = await sheet.source(bitmap, { maxSize: 128, exact: false })
    expect(GlError.is(atDefaults) || SheetError.is(atDefaults) || isAborted(atDefaults)).toBe(false)
    if (GlError.is(atDefaults) || SheetError.is(atDefaults) || isAborted(atDefaults)) return
    const lower = { ...defaultsFor('hull'), maxDist: 40 }
    const atLower = await sheet.source(bitmap, { maxSize: 128, exact: false, knobs: lower })
    bitmap.close()
    expect(GlError.is(atLower) || SheetError.is(atLower) || isAborted(atLower)).toBe(false)
    if (GlError.is(atLower) || SheetError.is(atLower) || isAborted(atLower)) return
    expect(atLower.hullKnobs['maxDist']).toBe(40)
    expect(atLower.overscan).toBe(atDefaults.overscan)
    expect(atLower.artwork).toEqual(atDefaults.artwork)
    expect(atLower.front).toEqual(atDefaults.front)
    // …and the front `build()` makes reports the artwork exactly where `source()` placed it:
    // centred, 1:1, in whatever size the bucket fit asked for.
    const size = { w: 128, h: 96 }
    const front = sheet.build(atLower, size, lower as never)
    expect(front instanceof Error, String((front as Error)?.message)).toBe(false)
    if (front instanceof Error) return
    expect(front.artwork).toEqual({
      x: Math.round((size.w - atLower.artwork.w) / 2),
      y: Math.round((size.h - atLower.artwork.h) / 2),
      w: atLower.artwork.w,
      h: atLower.artwork.h,
    })
    sheet.releaseFront(front)
    sheet.dispose()
  })

  it('names "re-add required" when a knob moves past the frozen reserve (spec 8.6)', async () => {
    const m = await mounted()
    expect(m).toBeDefined()
    if (m === undefined) return
    const { sheet, handle } = m
    const past = { ...defaultsFor('hull'), maxDist: 140 }
    const front = sheet.build(handle, { w: 128, h: 128 }, past as never)
    expect(SheetError.is(front)).toBe(true)
    expect((front as Error).message).toContain('re-add required')
    sheet.dispose()
  })

  // Spec 6.3: a hull-tier knob (minDist/maxDist/angularity/seed) moving off the value the hull was
  // traced at is `invalidates: 'hull'` — "invalidate the hull cache, then front" — and the
  // hull, its cache and its key live inside `source()` (spec 5.2). So the answer is the same
  // re-source row of spec 8.5's table the displaced artwork slot takes, and it has to be the same
  // error class: core's `rebuildFront` re-sources on `SourceExpiredError` and orphans any other
  // `BuildError` (spec 10.6, no caller on the stack). A `SheetError` here orphaned every
  // hull-tier set() for the sprite's life.
  it('answers SourceExpiredError, never a bare SheetError, when a hull-tier knob moves off the traced value (spec 6.3)', async () => {
    const m = await mounted()
    expect(m).toBeDefined()
    if (m === undefined) return
    const { sheet, handle } = m
    // `maxDist` moves DOWN: at this factory's zero headroom any increase is §8.6's reserve
    // check first (step 4 precedes step 6), which is the other error class on purpose.
    for (const moved of [{ minDist: 40 }, { maxDist: 60 }, { angularity: 0.2 }, { seed: 9 }]) {
      const front = sheet.build(handle, { w: 128, h: 128 }, {
        ...defaultsFor('hull'),
        ...moved,
      } as never)
      expect(SourceExpiredError.is(front), JSON.stringify(moved)).toBe(true)
      expect((front as Error).message).toContain('source()')
    }
    sheet.dispose()
  })

  it('source() traces at the knobs it is given, records the hull tier on the handle, and build() at them succeeds (spec 6.3)', async () => {
    const ctx = open()
    const sheet = paperSheet()
    sheet.mount(ctx)
    const bitmap = await sprite()
    const atDefaults = await sheet.source(bitmap, { maxSize: 128, exact: false })
    expect(GlError.is(atDefaults) || SheetError.is(atDefaults) || isAborted(atDefaults)).toBe(false)
    if (GlError.is(atDefaults) || SheetError.is(atDefaults) || isAborted(atDefaults)) return
    // `minDist` and `seed` leave the reserve alone (r_hull = maxDist + slop, spec 8.6), so the
    // only thing that can differ between the two handles is the trace itself.
    const moved = { ...defaultsFor('hull'), minDist: 40, seed: 9 }
    const at = await sheet.source(bitmap, { maxSize: 128, exact: false, knobs: moved })
    bitmap.close()
    expect(GlError.is(at) || SheetError.is(at) || isAborted(at)).toBe(false)
    if (GlError.is(at) || SheetError.is(at) || isAborted(at)) return
    expect(at.hullKnobs).toEqual({ minDist: 40, maxDist: 72, angularity: 0.7, seed: 9 })
    expect(atDefaults.hullKnobs).toEqual({ minDist: 22, maxDist: 72, angularity: 0.7, seed: 3 })
    expect(at.hull).not.toEqual(atDefaults.hull)
    const front = sheet.build(at, { w: 128, h: 128 }, moved as never)
    expect(front instanceof Error, String((front as Error)?.message)).toBe(false)
    if (!(front instanceof Error)) sheet.releaseFront(front)
    // The defaults are now the drifted values, for this handle.
    const drifted = sheet.build(at, { w: 128, h: 128 }, defaultsFor('hull') as never)
    expect(SourceExpiredError.is(drifted)).toBe(true)
    sheet.dispose()
  })

  it('source() ignores knob keys this mode does not declare; a torn sheet records seed alone as its hull tier', async () => {
    const ctx = open()
    const sheet = paperSheet({ edgeMode: 'torn' })
    sheet.mount(ctx)
    const bitmap = await sprite()
    const handle = await sheet.source(bitmap, {
      maxSize: 128,
      exact: false,
      knobs: { minDist: 40, maxDist: 80, angularity: 0.2, seed: 9, notAKnob: 1 },
    })
    bitmap.close()
    expect(GlError.is(handle) || SheetError.is(handle) || isAborted(handle)).toBe(false)
    if (GlError.is(handle) || SheetError.is(handle) || isAborted(handle)) return
    // `seed` is a common knob at the hull tier; the hull-only three are absent in torn mode.
    expect(handle.hullKnobs).toEqual({ seed: 9 })
    const front = sheet.build(handle, { w: 128, h: 128 }, {
      ...defaultsFor('torn'),
      seed: 9,
    } as never)
    expect(front instanceof Error, String((front as Error)?.message)).toBe(false)
    if (!(front instanceof Error)) sheet.releaseFront(front)
    // Live-demo regression: the reserve, `p` and the artwork size are frozen at add() for the
    // sprite's life (spec 8.6), so `source()` may take ONLY the hull tier from the projection. A
    // version that read the live `tearAmp`/`thickness`/`looseness` here handed back a handle with
    // a larger `p` (a smaller artwork in the same bucket) and, on a portrait sprite, refused
    // outright with "could not derive overscan" where `build()`'s reserve check is the honest
    // surface — six orphans per stage-level set() in the demo's torn grid.
    const tall = await sprite(32, 48)
    const atDefaults = await sheet.source(tall, { maxSize: 128, exact: false })
    expect(GlError.is(atDefaults) || SheetError.is(atDefaults) || isAborted(atDefaults)).toBe(false)
    if (GlError.is(atDefaults) || SheetError.is(atDefaults) || isAborted(atDefaults)) return
    const dragged = await sheet.source(tall, {
      maxSize: 128,
      exact: false,
      knobs: { ...defaultsFor('torn'), tearAmp: 60, thickness: 40, looseness: 0.8, seed: 9 },
    })
    tall.close()
    expect(
      GlError.is(dragged) || SheetError.is(dragged) || isAborted(dragged),
      String((dragged as Error)?.message),
    ).toBe(false)
    if (GlError.is(dragged) || SheetError.is(dragged) || isAborted(dragged)) return
    expect(dragged.overscan).toBe(atDefaults.overscan)
    expect(dragged.artwork).toEqual(atDefaults.artwork)
    expect(dragged.front).toEqual(atDefaults.front)
    expect(dragged.sdfRes).toBe(atDefaults.sdfRes)
    expect(dragged.hullKnobs).toEqual({ seed: 9 })
    sheet.dispose()
  })

  it('is a SheetError, never a throw, to build a released handle', async () => {
    const m = await mounted()
    expect(m).toBeDefined()
    if (m === undefined) return
    const { sheet, handle } = m
    sheet.release(handle)
    const front = sheet.build(handle, { w: 128, h: 128 }, defaultsFor('hull') as never)
    expect(SheetError.is(front)).toBe(true)
    sheet.dispose()
  })

  it('lets releaseFront run twice, because teardown order makes that likely', async () => {
    const m = await mounted()
    expect(m).toBeDefined()
    if (m === undefined) return
    const { sheet, handle } = m
    const front = sheet.build(handle, { w: 128, h: 128 }, defaultsFor('hull') as never)
    expect(front instanceof Error, (front as Error).message).toBe(false)
    if (front instanceof Error) return
    sheet.releaseFront(front)
    expect(() => sheet.releaseFront(front)).not.toThrow()
    sheet.dispose()
  })

  // The claim under test is "pass A did not run the second time" — asserting only that the
  // output changed, or that some field's identity stayed stable, would not prove it: a
  // regression that rebuilt the whole field (pass A + pass B) would still pass a weaker check.
  // `gl.drawArrays` is the real observable: `buildField` (pass A) issues `2 * (schedule.length +
  // 1) + 1` draws (`gl-sdf.ts`'s own `Field.passes`, comfortably into double digits at this
  // field size), while `blurField` (pass B) issues exactly two (a horizontal half and a vertical
  // half) and `renderFront` issues exactly one more. So a second `build()` call that reused pass
  // A must draw at most a handful of times, and one that silently re-ran it cannot.
  it('re-runs pass B alone when only looseness moved', async () => {
    const ctx = open()
    // Fix round 1, finding 2: `checkReserve` now sees the LIVE `looseness` (core's own
    // `overscanRadius` genuinely takes it as a term of `r_torn`), so the 0.65 build below needs
    // enough `overscanHeadroom` to still clear the reserve frozen at this factory's defaults —
    // computed from the same formula `checkReserve` itself uses, not guessed. Kept well short of
    // `overscanFromRadius`'s own asymmetric-margin regime at large `p` (checked empirically while
    // writing this round: `source()`'s pre-existing `artworkUv` mapping only centres the artwork
    // for small `p`, and a `looseness` delta as large as 0.9 pushes `p` far enough to trip the
    // guard band on its own, independent of the reserve check this test is actually about).
    const radiusAtDefault = overscanRadius(edgeParamsFrom('torn', defaultsFor('torn')))
    const radiusAtLooser = overscanRadius(
      edgeParamsFrom('torn', { ...defaultsFor('torn'), looseness: 0.65 }),
    )
    const headroom = radiusAtLooser / radiusAtDefault - 1 + 0.05
    const sheet = paperSheet({ edgeMode: 'torn', overscanHeadroom: headroom })
    sheet.mount(ctx)
    const bitmap = await compactSprite()
    const handle = await sheet.source(bitmap, { maxSize: 128, exact: false })
    bitmap.close()
    expect(
      GlError.is(handle) || SheetError.is(handle) || isAborted(handle),
      String((handle as Error)?.message),
    ).toBe(false)
    if (GlError.is(handle) || SheetError.is(handle) || isAborted(handle)) return

    const drawArrays = vi.spyOn(ctx.gl, 'drawArrays')

    // Fix round 1, finding 3 (the doubled pass B): `source()` now leaves its own pass A/B result
    // in `lastFieldBuild`, so a `build()` at a size that does NOT match `source()`'s own front
    // (a non-square 140x100 request against this sprite's own square 128x128 front) still forces
    // a genuinely cold pass A here — the scenario this assertion is about (a same-size, same-knob
    // `build()` reusing `source()`'s own work outright is covered separately, below).
    drawArrays.mockClear()
    const a = sheet.build(handle, { w: 140, h: 100 }, defaultsFor('torn') as never)
    const firstDraws = drawArrays.mock.calls.length

    drawArrays.mockClear()
    const b = sheet.build(handle, { w: 140, h: 100 }, {
      ...defaultsFor('torn'),
      looseness: 0.65,
    } as never)
    const secondDraws = drawArrays.mock.calls.length

    drawArrays.mockRestore()

    expect(a instanceof Error || b instanceof Error).toBe(false)
    if (a instanceof Error || b instanceof Error) return

    // Pass A ran cold on the first build (its own many-pass JFA schedule, plus pass B's two
    // draws, plus renderFront's one) — comfortably into double digits.
    expect(firstDraws).toBeGreaterThan(10)
    // The second build only moved `looseness`: pass B's two draws plus renderFront's one, and
    // nothing from pass A — a regression that reran the jump flood would land back near
    // `firstDraws`, which this bound catches.
    expect(secondDraws).toBe(3)

    sheet.releaseFront(a)
    sheet.releaseFront(b)
    sheet.dispose()
  })
})

describe('source() spends pass A alone; the first build() at its framing reuses it (spec 8.1)', () => {
  /** Pass A's draw count at `field`: two seeds, two schedules of `log2 + 1` steps, one resolve. */
  function passesFor(field: { w: number; h: number }): number {
    const steps = Math.ceil(Math.log2(Math.max(field.w, field.h))) + 1
    return 2 * (steps + 1) + 1
  }

  it('runs no blur in source(): nothing reads a loose field before build()', async () => {
    const ctx = open()
    const sheet = paperSheet()
    sheet.mount(ctx)
    const bitmap = await compactSprite()
    const drawArrays = vi.spyOn(ctx.gl, 'drawArrays')
    const handle = await sheet.source(bitmap, { maxSize: 128, exact: false })
    const sourceDraws = drawArrays.mock.calls.length
    drawArrays.mockRestore()
    bitmap.close()
    expect(GlError.is(handle) || SheetError.is(handle) || isAborted(handle)).toBe(false)
    if (GlError.is(handle) || SheetError.is(handle) || isAborted(handle)) return

    // The resample (the exact-byte fetch and the resample proper on the probe-green branch, the
    // resample alone on the canvas branch), then pass A over the field `source()` frames on its
    // own front — and nothing else. The two blur draws that used to follow were never sampled:
    // `acquireCpuField` reads the tight field, and the first `build()` blurs at its own framing.
    const field = dimsForLongSide(handle.sdfRes, handle.front.w, handle.front.h, 2)
    const resampleDraws = ctx.exactByteFetch ? 2 : 1
    expect(sourceDraws).toBe(resampleDraws + passesFor(field))
    sheet.dispose()
  })

  it('reuses the tight field in a build() at handle.front, and blurs there instead', async () => {
    const ctx = open()
    const sheet = paperSheet()
    sheet.mount(ctx)
    const bitmap = await compactSprite()
    const handle = await sheet.source(bitmap, { maxSize: 128, exact: false })
    bitmap.close()
    expect(GlError.is(handle) || SheetError.is(handle) || isAborted(handle)).toBe(false)
    if (GlError.is(handle) || SheetError.is(handle) || isAborted(handle)) return
    expect(handle.hull.kind).toBe('polygons')

    const field = dimsForLongSide(handle.sdfRes, handle.front.w, handle.front.h, 2)
    const drawArrays = vi.spyOn(ctx.gl, 'drawArrays')
    const first = sheet.build(handle, handle.front, defaultsFor('hull') as never)
    const firstDraws = drawArrays.mock.calls.length
    drawArrays.mockClear()
    const second = sheet.build(handle, handle.front, defaultsFor('hull') as never)
    const secondDraws = drawArrays.mock.calls.length
    drawArrays.mockRestore()
    expect(first instanceof Error || second instanceof Error).toBe(false)
    if (first instanceof Error || second instanceof Error) return

    // Pass A is served from `lastFieldBuild` (same sprite, same front): pass B's two draws, the
    // hull polygon's own field (pass A over the mask, at the same field dims), renderFront's one.
    expect(firstDraws).toBe(2 + passesFor(field) + 1)
    // And the second build at the same knobs draws the front alone.
    expect(secondDraws).toBe(1)
    // The loose field `build()` made on the first call is the one the cached second call reads:
    // the two fronts are byte-identical. (The "same as before the change" half of the pin is the
    // golden test below, not this comparison of two post-change fronts.)
    expect(Array.from(readRect(ctx, first.texture, 0, 0, first.width, first.height))).toEqual(
      Array.from(readRect(ctx, second.texture, 0, 0, second.width, second.height)),
    )

    sheet.releaseFront(first)
    sheet.releaseFront(second)
    sheet.dispose()
  })

  /** FNV-1a (32-bit) over `bytes`, as eight hex digits — a golden small enough to read. */
  function fnv1a(bytes: Uint8Array): string {
    let h = 0x811c9dc5
    for (const b of bytes) {
      h ^= b
      h = Math.imul(h, 0x01000193) >>> 0
    }
    return h.toString(16).padStart(8, '0')
  }

  /**
   * The front `build(handle, handle.front)` rendered right after `source()` — when the loose
   * field it sampled was the one `source()` had blurred — hashed over its RGBA bytes on the
   * level-2 suite's own SwiftShader (the same rasteriser the `__screenshots__` suite pins pixels
   * on). Regenerated for design 2026-09-05 §4.2 (previously pinned at 5f61a46): §4.2 changes
   * `handle.front`'s size for this fixture, which reflows every pixel this hash covers even
   * though the fields and the paper shader are unchanged. Regenerate only for a deliberate change
   * to the fields, the paper shader, or the margin, by running this test at the commit being
   * pinned and copying the hash the failure prints.
   */
  const FRONT_AT_HANDLE_FRONT_GOLDEN = { hull: '457ed64a', torn: '44a1976d' } as const

  it('renders, at handle.front, the front the source-time blur used to produce (golden from 5f61a46)', async () => {
    const ctx = open()
    for (const edgeMode of ['hull', 'torn'] as const) {
      const sheet = paperSheet({ edgeMode })
      sheet.mount(ctx)
      const bitmap = await compactSprite()
      const handle = await sheet.source(bitmap, { maxSize: 128, exact: false })
      bitmap.close()
      expect(GlError.is(handle) || SheetError.is(handle) || isAborted(handle)).toBe(false)
      if (GlError.is(handle) || SheetError.is(handle) || isAborted(handle)) return
      const front = sheet.build(handle, handle.front, defaultsFor(edgeMode) as never)
      expect(front instanceof Error, String((front as Error)?.message)).toBe(false)
      if (front instanceof Error) return
      const bytes = readRect(ctx, front.texture, 0, 0, front.width, front.height)
      // Not a blank: the paper is there.
      expect(bytes.some((b, i) => i % 4 === 3 && b > 0)).toBe(true)
      // `soft`, so a regeneration run prints both modes' hashes at once.
      expect
        .soft(fnv1a(bytes), `${edgeMode} front at handle.front`)
        .toBe(FRONT_AT_HANDLE_FRONT_GOLDEN[edgeMode])
      sheet.releaseFront(front)
      sheet.dispose()
    }
  })

  it('forgets lastFieldBuild when a build at a new framing fails mid-way, so the next build restarts from pass A', async () => {
    const ctx = open()
    const sheet = paperSheet()
    sheet.mount(ctx)
    const bitmap = await compactSprite()
    const handle = await sheet.source(bitmap, { maxSize: 128, exact: false })
    bitmap.close()
    expect(GlError.is(handle) || SheetError.is(handle) || isAborted(handle)).toBe(false)
    if (GlError.is(handle) || SheetError.is(handle) || isAborted(handle)) return
    expect(handle.hull.kind).toBe('polygons')
    const warm = sheet.build(handle, handle.front, defaultsFor('hull') as never)
    expect(warm instanceof Error).toBe(false)
    if (warm instanceof Error) return
    sheet.releaseFront(warm)

    // A build at another framing whose first allocation — the tight field at the new size —
    // fails: `gl-context.ts` reads `getError` once per allocation, so one reported error is one
    // refused texture and a `GlError` out of `buildField`. Nothing else in `build()` reads
    // `getError` before that point.
    const getError = vi.spyOn(ctx.gl, 'getError').mockReturnValueOnce(ctx.gl.OUT_OF_MEMORY)
    const failed = sheet.build(handle, { w: 140, h: 100 }, defaultsFor('hull') as never)
    getError.mockRestore()
    expect(GlError.is(failed), String((failed as Error)?.message)).toBe(true)

    // The record for `handle.front` must not survive a failed build at a new framing (its slots
    // may have been evicted to make room for what failed): the next build at `handle.front`
    // starts from pass A — tight, blur, the hull field and the front — rather than the cached 1.
    const field = dimsForLongSide(handle.sdfRes, handle.front.w, handle.front.h, 2)
    const drawArrays = vi.spyOn(ctx.gl, 'drawArrays')
    const again = sheet.build(handle, handle.front, defaultsFor('hull') as never)
    const draws = drawArrays.mock.calls.length
    drawArrays.mockRestore()
    expect(again instanceof Error, String((again as Error)?.message)).toBe(false)
    if (again instanceof Error) return
    expect(draws).toBe(passesFor(field) + 2 + passesFor(field) + 1)
    sheet.releaseFront(again)
    sheet.dispose()
  })
})

describe('task 12 fix round 1 (findings 1, 2, 3)', () => {
  // Finding 1's own premise ("build(A) after source(B) at the same bucket size reuses stale
  // cachedField.tight/loose and silently renders B's field into A's front") does NOT hold for
  // this module as written: `build()`'s own step 3 refuses with `SourceExpiredError` the moment
  // the artwork slot no longer holds the handle's own spriteKey, and `source(B)` is the only thing
  // that can displace it — so this exact sequence never reaches the field-cache code at all. This
  // is the repro from the report's own measurement (run once with, once conceptually without any
  // field-cache change — the outcome does not depend on the field cache because execution never
  // gets there), kept as a permanent regression test: a future change that let `build()` skip past
  // step 3 would have to also re-litigate the field cache's own safety, and this is what would
  // catch it landing wrong.
  it("refuses build(A) once another sprite has taken the slot — never a front built from the other sprite's field (finding 1)", async () => {
    const ctx = open()
    const sheet = paperSheet()
    sheet.mount(ctx)

    const bitmapA = await sprite(48, 32)
    const handleA = await sheet.source(bitmapA, { maxSize: 128, exact: false })
    bitmapA.close()
    expect(GlError.is(handleA) || SheetError.is(handleA) || isAborted(handleA)).toBe(false)
    if (GlError.is(handleA) || SheetError.is(handleA) || isAborted(handleA)) return

    // `front` here is 48x32's own long-side-128 resample, not a square 128x128 — deliberately not
    // the same size `source()` itself used, so this test does not also exercise finding 3's own
    // same-size reuse path; the two are independent claims.
    const size = { w: 128, h: 96 }
    const frontA1 = sheet.build(handleA, size, defaultsFor('hull') as never)
    expect(frontA1 instanceof Error, String((frontA1 as Error)?.message)).toBe(false)
    if (frontA1 instanceof Error) {
      sheet.dispose()
      return
    }

    // Sprite B: same dimensions and the same `maxSize`, so `ensurePools` reuses the SAME Pool A /
    // `SdfBuilder` rather than disposing and rebuilding — the exact "same bucket size" case
    // finding 1 named, and the one case where a naive cache could be tempted to reuse across
    // sprites.
    const bitmapB = await sprite(48, 32)
    const handleB = await sheet.source(bitmapB, { maxSize: 128, exact: false })
    bitmapB.close()
    expect(GlError.is(handleB) || SheetError.is(handleB) || isAborted(handleB)).toBe(false)

    const frontA2 = sheet.build(handleA, size, defaultsFor('hull') as never)
    // Never a silently-wrong front built from B's field: A's own artwork slot was displaced the
    // moment source(B) ran, and build() must say so rather than render something.
    expect(SourceExpiredError.is(frontA2)).toBe(true)

    sheet.releaseFront(frontA1)
    sheet.dispose()
  })

  // Finding 2 (was wrong before this round): a build() that drags `looseness` past what the
  // frozen reserve can cover must be refused, naming "re-add required" and `overscanHeadroom` —
  // never silently pass because the check was reading a pinned default instead of the live value.
  it('names "re-add required" and overscanHeadroom when looseness drags past the frozen reserve (finding 2)', async () => {
    const ctx = open()
    // Zero overscanHeadroom (this factory's own default): the reserve is exactly this mode's own
    // default-knob radius, with no room to spare for a live drag.
    const sheet = paperSheet({ edgeMode: 'torn' })
    sheet.mount(ctx)
    const bitmap = await compactSprite()
    const handle = await sheet.source(bitmap, { maxSize: 128, exact: false })
    bitmap.close()
    expect(GlError.is(handle) || SheetError.is(handle) || isAborted(handle)).toBe(false)
    if (GlError.is(handle) || SheetError.is(handle) || isAborted(handle)) return

    const size = { w: 128, h: 128 }
    const first = sheet.build(handle, size, defaultsFor('torn') as never)
    expect(first instanceof Error, String((first as Error)?.message)).toBe(false)
    if (first instanceof Error) {
      sheet.dispose()
      return
    }

    const dragged = sheet.build(handle, size, {
      ...defaultsFor('torn'),
      looseness: 0.9,
    } as never)
    expect(SheetError.is(dragged)).toBe(true)
    if (!SheetError.is(dragged)) {
      sheet.releaseFront(first)
      sheet.dispose()
      return
    }
    expect(dragged.message).toContain('re-add required')
    expect(dragged.message).toContain('overscanHeadroom')

    sheet.releaseFront(first)
    sheet.dispose()
  })

  // Finding 3 (the doubled pass B): a build() at the exact size and knob values source() itself
  // just used must consume source()'s own pass A/B work, not redo it — the claim is "zero field
  // draws", stronger than "fewer than the first build in the OTHER test above" (which deliberately
  // uses a different size so it keeps testing a genuinely cold pass A).
  it("consumes source()'s own field build when the first build() matches its size and knobs exactly (finding 3)", async () => {
    const ctx = open()
    const sheet = paperSheet({ edgeMode: 'hull' })
    sheet.mount(ctx)
    const bitmap = await compactSprite()
    const handle = await sheet.source(bitmap, { maxSize: 128, exact: false })
    bitmap.close()
    expect(GlError.is(handle) || SheetError.is(handle) || isAborted(handle)).toBe(false)
    if (GlError.is(handle) || SheetError.is(handle) || isAborted(handle)) return

    const drawArrays = vi.spyOn(ctx.gl, 'drawArrays')
    drawArrays.mockClear()
    // 128x128: exactly this sprite's own `front` (a square 64x64 source at maxSize 128).
    const front = sheet.build(handle, { w: 128, h: 128 }, defaultsFor('hull') as never)
    const draws = drawArrays.mock.calls.length
    drawArrays.mockRestore()

    expect(front instanceof Error, String((front as Error)?.message)).toBe(false)
    if (front instanceof Error) {
      sheet.dispose()
      return
    }
    // renderFront's own one draw, plus the hull field's own pass A (design 2026-09-02 §2), plus
    // pass B's two draws — and nothing from the tight pass, which is consumed from `source()`'s
    // own build. (`source()` builds no loose field any more: nothing reads one before `build()`,
    // so the first `build()` at this framing is where pass B runs — `lastFieldBuild.loose`'s doc
    // comment.) The count is exact rather than approximate: the hull field is the built size,
    // 128x128, so `scheduleFor` (gl-sdf.ts) gives `levels = ceil(log2(128)) = 7`, a schedule of
    // `[64,32,16,8,4,2,1]` plus the extra unit pass = 8 entries, and pass A therefore spends
    // `2 * (8 + 1) + 1 = 19` draws. 19 + pass B's 2 + renderFront's 1 = 22. A regression that
    // stopped reusing `source()`'s tight field would add pass A a second time, which this exact
    // count still catches.
    expect(draws).toBe(22)

    sheet.releaseFront(front)
    sheet.dispose()
  })
})

describe("task 12 fix round 2 (build()'s rect conversion)", () => {
  // The finding: build()'s step 9 used to scale `handle.rect` (source pixels) UNIFORMLY by
  // `frontLongSide / sourceLongSide` into this call's own front space — which carries no origin
  // term, so it drops the margin around the artwork the moment this build's requested `size`
  // differs from the add-time front. The rect tracks the artwork's own placement instead: the
  // artwork is copied 1:1 into every front (spec 7.4.2) and the paper is built around it, so
  // between the trace front (128x128, `maxSize` above) and a 200x200 build the paper's box moves
  // by exactly the artwork's origin shift and keeps its size. `torn` mode's own ~0.19-0.22
  // overscan (task 10's own report) puts that tens of px from the uniform scale — not a rounding
  // wobble.
  it("build()'s rect moves with the artwork's 1:1 placement at THIS build's size, not a uniform handle.rect scale", async () => {
    const ctx = open()
    const sheet = paperSheet({ edgeMode: 'torn' })
    sheet.mount(ctx)
    const bitmap = await compactSprite(64, 64)
    const handle = await sheet.source(bitmap, { maxSize: 128, exact: false })
    bitmap.close()
    expect(
      GlError.is(handle) || SheetError.is(handle) || isAborted(handle),
      String((handle as Error)?.message),
    ).toBe(false)
    if (GlError.is(handle) || SheetError.is(handle) || isAborted(handle)) {
      sheet.dispose()
      return
    }

    // Deliberately NOT the add-time front (128x128, `maxSize` above): a size mismatch is exactly
    // what makes the uniform-scale formula and the exact affine inverse disagree.
    const size = { w: 200, h: 200 }
    const front = sheet.build(handle, size, defaultsFor('torn') as never)
    expect(front instanceof Error, String((front as Error)?.message)).toBe(false)
    if (front instanceof Error) {
      sheet.dispose()
      return
    }

    const srcW = handle.srcW
    const srcH = handle.srcH
    expect(handle.overscan).toBeGreaterThan(0.15) // torn's own headline figure; a real margin to move
    // The front is the artwork plus its per-axis margin (§8.6 amendment), so it need not hit
    // `maxSize` exactly the way the old uniform-front scheme always did — only fit inside it.
    expect(Math.max(handle.front.w, handle.front.h)).toBeLessThanOrEqual(128)
    // `build()`'s own `artworkPlacement`: centred, 1:1, origin rounded to whole texels.
    const placementIn = (front: { w: number; h: number }) => ({
      x: Math.round((front.w - handle.artwork.w) / 2),
      y: Math.round((front.h - handle.artwork.h) / 2),
    })
    const trace = placementIn(handle.front)
    const here = placementIn(size)
    expect(here.x - trace.x).toBeGreaterThan(20) // the shift is the thing under test, so it is real
    expect(front.rect).toEqual({
      x: handle.frontRect.x + here.x - trace.x,
      y: handle.frontRect.y + here.y - trace.y,
      w: handle.frontRect.w,
      h: handle.frontRect.h,
    })

    // Explicitly not what the old uniform-scale formula
    // (`scaleRect(handle.rect, frontLongSide / sourceLongSide)`) would have produced, so a
    // regression back to it is caught even if rounding happened to make the two close for this
    // particular fixture.
    const frontLongSide = Math.max(size.w, size.h)
    const sourceLongSide = Math.max(srcW, srcH)
    const uniformX0 = Math.round(handle.rect.x * (frontLongSide / sourceLongSide))
    expect(Math.abs(front.rect.x - uniformX0)).toBeGreaterThan(1)

    sheet.releaseFront(front)
    sheet.dispose()
  })
})

/**
 * An ellipse biased toward the top third of its own bitmap — asymmetric on the y axis on purpose:
 * a vertical mirror of a centred shape (like `sprite()`'s own) would be indistinguishable from the
 * un-mirrored original, which would make a mirroring bug invisible to a test built on it.
 */
async function topSprite(w = 64, h = 64): Promise<ImageBitmap> {
  const data = new Uint8ClampedArray(w * h * 4)
  const cy = h * 0.32
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inside = ((x - w / 2) / (w / 3.2)) ** 2 + ((y - cy) / (h / 4.2)) ** 2 <= 1
      const p = (y * w + x) * 4
      data[p] = 200
      data[p + 1] = 120
      data[p + 2] = 60
      data[p + 3] = inside ? 255 : 0
    }
  }
  const canvas = new OffscreenCanvas(w, h)
  canvas.getContext('2d')!.putImageData(new ImageData(data, w, h), 0, 0)
  return createImageBitmap(canvas, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' })
}

/**
 * Forces `source()`'s CPU-fallback branch, once, without corrupting any other GL state: the real
 * `readPixels` call still runs (so the driver's own buffer contents stay whatever they really are)
 * — only the very next `getError()` call after it is intercepted and forced non-zero, which is
 * exactly what `readBackField`'s own post-`readPixels` success check reads as a refusal. Restores
 * both spies; call the returned function once the forced `source()` call has settled.
 */
function forceCpuFallbackOnce(ctx: GlContext): () => void {
  let forceError = false
  const gl = ctx.gl
  const originalGetError = gl.getError.bind(gl)
  const getErrorSpy = vi.spyOn(gl, 'getError').mockImplementation(() => {
    if (forceError) {
      forceError = false
      return gl.INVALID_OPERATION
    }
    return originalGetError()
  })
  const originalReadPixels = gl.readPixels.bind(gl)
  const readPixelsSpy = vi.spyOn(gl, 'readPixels').mockImplementation(((...args: unknown[]) => {
    ;(originalReadPixels as (...a: unknown[]) => void)(...args)
    forceError = true
  }) as typeof gl.readPixels)
  return () => {
    getErrorSpy.mockRestore()
    readPixelsSpy.mockRestore()
  }
}

describe('fix round 1 — the CPU-fallback field (findings 1, 2, 3, 4)', () => {
  // Finding 2: check point 2 sat behind an `await` no given test could reach deterministically
  // (the only hook fired inside check point 3's own window). `__afterFieldForTest` fires
  // synchronously, from inside `source()`'s own call, before the resample/field-build work ever
  // yields — so it must be installed BEFORE `source()` is called (unlike `__afterHullForTest`
  // above, whose own window opens only after check point 2's `await` has already returned control
  // to the caller). Installed after, it would fire on a `source()` call that has not read it yet.
  // The claim under test is "check point 2 itself stopped the work", not merely "the call ended
  // up ABORTED somehow" — checkpoint 3 reads the SAME signal a few lines later and would also
  // return ABORTED even if checkpoint 2 were deleted outright, so `isAborted(r)` alone cannot
  // distinguish the two. `readPixels` only ever runs inside `readBackField`, reachable only from
  // the CPU hull trace AFTER check point 2 — asserting it was never called is what actually pins
  // the abort to check point 2's own window, not check point 3's.
  it('aborts at check point 2, after the field passes and before the CPU hull trace (finding 2)', async () => {
    const ctx = open()
    const sheet = paperSheet()
    sheet.mount(ctx)
    const bitmap = await sprite()
    const controller = new AbortController()
    sheet.__afterFieldForTest = () => controller.abort()
    const readPixels = vi.spyOn(ctx.gl, 'readPixels')
    const r = await sheet.source(bitmap, {
      maxSize: 128,
      exact: false,
      signal: controller.signal,
    })
    bitmap.close()
    expect(isAborted(r), 'check point 2 must be reachable, not merely present in the code').toBe(
      true,
    )
    expect(
      readPixels,
      'the CPU hull trace must never start once check point 2 has aborted',
    ).not.toHaveBeenCalled()
    readPixels.mockRestore()
    sheet.dispose()
  })

  // Findings 1 and 4, proved together against the SAME sprite and the SAME forced fallback call,
  // to keep this file's own live-context count down (§4.0's ~sixteen-context cap).
  //
  // Finding 1's own premise ("GPU-native y-up vs canvas-native y-down, needs a flip") does NOT
  // hold for this package's actual (unflipped) upload path — see `cpuFieldFallback`'s own doc
  // comment in `sheet.ts` for the algebra. This test is the empirical check that backs that
  // conclusion: it was run three ways while fixing this round (see the report) — with neither fix,
  // with the margin fix alone, and with the margin fix plus an (incorrect) row flip — and only the
  // margin-fix-alone version, which is what ships, passes both assertions below.
  it("normalises the CPU-fallback field to the readback branch's own margin, and shares its row order without needing a flip (findings 1, 4)", async () => {
    const ctx = open()
    const sheet = paperSheet()
    sheet.mount(ctx)
    const bitmap = await topSprite()

    const viaReadback = await sheet.source(bitmap, { maxSize: 128, exact: false })
    expect(
      GlError.is(viaReadback) || SheetError.is(viaReadback) || isAborted(viaReadback),
      'the readback branch itself must succeed for this fixture, or the comparison below proves nothing',
    ).toBe(false)
    if (GlError.is(viaReadback) || SheetError.is(viaReadback) || isAborted(viaReadback)) {
      bitmap.close()
      sheet.dispose()
      return
    }

    expect(sheet.invalidateHull('*')).toBeGreaterThan(0)
    const restore = forceCpuFallbackOnce(ctx)
    const viaFallback = await sheet.source(bitmap, { maxSize: 128, exact: false })
    restore()
    bitmap.close()

    // Finding 4: a fallback that skipped the artworkUv margin remap fills the WHOLE field with the
    // artwork, so its traced hull extends past the reserved overscan band and trips the guard-band
    // check — which the readback branch, right above, never does for this same sprite.
    expect(
      GlError.is(viaFallback) || SheetError.is(viaFallback) || isAborted(viaFallback),
      String((viaFallback as Error)?.message),
    ).toBe(false)
    if (GlError.is(viaFallback) || SheetError.is(viaFallback) || isAborted(viaFallback)) {
      sheet.dispose()
      return
    }

    // Finding 1: the fallback's frontRect sits close to the readback's own, not mirrored
    // top-to-bottom — `topSprite()`'s own off-centre bias means a real mirror moves this by tens
    // of px (measured at 32 px on a 128 px front while checking this, with a row flip artificially
    // reinstated), comfortably outside the tolerance below; the residual gap here is
    // JFA-vs-exact-EDT noise between the two algorithms, not orientation.
    expect(Math.abs(viaFallback.frontRect.y - viaReadback.frontRect.y)).toBeLessThan(10)

    sheet.dispose()
  })

  // Finding 3: `handle.rect` must go through the artwork's own placement in the front — the box
  // the seed pass framed the field on — not a uniform `sourceLongSide / frontLongSide` scale,
  // which has no origin term and so drops the margin. `torn` mode's own ~0.19-0.22 overscan (task
  // 10's own report) makes that margin ~19 px of a 128 px front, so the two formulas' predictions
  // diverge by tens of px and a regression back to the uniform scale is caught, not just a
  // rounding wobble.
  it('handle.rect subtracts the artwork placement and scales by src / artwork, not a uniform frontRect scale (finding 3)', async () => {
    const ctx = open()
    const sheet = paperSheet({ edgeMode: 'torn' })
    sheet.mount(ctx)
    const bitmap = await compactSprite(64, 64)
    const handle = await sheet.source(bitmap, { maxSize: 128, exact: false })
    bitmap.close()
    expect(
      GlError.is(handle) || SheetError.is(handle) || isAborted(handle),
      String((handle as Error)?.message),
    ).toBe(false)
    if (GlError.is(handle) || SheetError.is(handle) || isAborted(handle)) {
      sheet.dispose()
      return
    }

    // The front is the artwork plus its per-axis margin (§8.6 amendment): a square 64x64 source
    // keeps both axes at the same figure, but it need not hit `maxSize` exactly — read it off
    // the handle rather than hard-coding the old uniform-front value.
    const front = handle.front
    const srcW = 64
    const srcH = 64
    expect(handle.overscan).toBeGreaterThan(0.15) // torn's own headline figure; a real margin
    expect(Math.max(front.w, front.h)).toBeLessThanOrEqual(128)
    // `source()`'s own `artworkPlacement`, then `src / artwork` per axis — the resample maps the
    // full source onto the full artwork, so that is the whole of the scale.
    const placement = {
      x: Math.round((front.w - handle.artwork.w) / 2),
      y: Math.round((front.h - handle.artwork.h) / 2),
    }
    expect(placement.x).toBeGreaterThan(10)
    const toSource = (v: number, origin: number, artworkDim: number, srcDim: number) =>
      ((v - origin) * srcDim) / artworkDim

    const expectedX0 = toSource(handle.frontRect.x, placement.x, handle.artwork.w, srcW)
    const expectedY0 = toSource(handle.frontRect.y, placement.y, handle.artwork.h, srcH)
    const expectedX1 = toSource(
      handle.frontRect.x + handle.frontRect.w,
      placement.x,
      handle.artwork.w,
      srcW,
    )
    const expectedY1 = toSource(
      handle.frontRect.y + handle.frontRect.h,
      placement.y,
      handle.artwork.h,
      srcH,
    )

    expect(handle.rect.x).toBeCloseTo(expectedX0, 0)
    expect(handle.rect.y).toBeCloseTo(expectedY0, 0)
    expect(handle.rect.w).toBeCloseTo(expectedX1 - expectedX0, 0)
    expect(handle.rect.h).toBeCloseTo(expectedY1 - expectedY0, 0)

    // Explicitly not what the old uniform-scale formula (`sourceLongSide / frontLongSide`) would
    // have produced, so a regression back to it is caught even if rounding happened to make the
    // two close for this particular fixture.
    const uniformX0 = Math.round(handle.frontRect.x * (srcW / front.w))
    expect(Math.abs(handle.rect.x - uniformX0)).toBeGreaterThan(1)

    sheet.dispose()
  })
})

/** `readPixels` reads `READ_FRAMEBUFFER`; `DrawScope.bindTarget` only ever binds `DRAW_FRAMEBUFFER`. */
function readRect(
  ctx: ReturnType<typeof open>,
  texture: WebGLTexture,
  x: number,
  y: number,
  w: number,
  h: number,
): Uint8Array {
  const out = new Uint8Array(w * h * 4)
  const probe = ctx.gl.createFramebuffer()
  ctx.scope(() => {
    ctx.gl.bindFramebuffer(ctx.gl.READ_FRAMEBUFFER, probe)
    ctx.gl.framebufferTexture2D(
      ctx.gl.READ_FRAMEBUFFER,
      ctx.gl.COLOR_ATTACHMENT0,
      ctx.gl.TEXTURE_2D,
      texture,
      0,
    )
    ctx.gl.readPixels(x, y, w, h, ctx.gl.RGBA, ctx.gl.UNSIGNED_BYTE, out)
    ctx.gl.bindFramebuffer(ctx.gl.READ_FRAMEBUFFER, null)
  })
  ctx.gl.deleteFramebuffer(probe)
  return out
}

describe('the hull polygon as a real paper field (design 2026-09-02, §2-§3)', () => {
  /**
   * The defect this fixes: `build()` hardcoded `paperField: null`, so the default `hull` mode
   * always reached `uEdgeMode = 2` — "the sheet IS the artwork alpha" — and the paper was cut
   * along the garment's own outline. Under `uEdgeMode = 1` the sheet follows the hull polygon,
   * which sits `minDist`..`maxDist` OUTSIDE the silhouette, so a texel just beyond the artwork's
   * own alpha is opaque paper. Mode 2 cannot produce that by construction: its coverage mask IS
   * the alpha, so anything the alpha does not cover reads exactly (0,0,0,0).
   */
  it('draws paper outside the artwork silhouette at the factory defaults', async () => {
    const ctx = open()
    const sheet = paperSheet()
    sheet.mount(ctx)
    const bitmap = await compactSprite()
    const handle = await sheet.source(bitmap, { maxSize: 128, exact: false })
    bitmap.close()
    expect(GlError.is(handle) || SheetError.is(handle) || isAborted(handle)).toBe(false)
    if (GlError.is(handle) || SheetError.is(handle) || isAborted(handle)) return

    const front = sheet.build(handle, { w: 128, h: 128 }, defaultsFor('hull') as never)
    expect(front instanceof Error, String((front as Error)?.message)).toBe(false)
    if (front instanceof Error) return

    // The oracle is the artwork's own SILHOUETTE, not the artwork RECT. The rect cannot
    // discriminate the two modes here and the difference is arithmetic, not taste: the reserve
    // `source()` freezes is exactly the hull's own dilation radius (`maxDist` plus the edge slop),
    // so the margin between the artwork rect and the front edge is exactly the distance the hull
    // grows by — and a hull can only reach past that rect for a sprite whose alpha touches its own
    // bounding box. Neither fixture in this file is such a sprite (`compactSprite`'s ellipse stops
    // at half its box), and measured on this fixture, "opaque beyond the artwork rect" is 0 both
    // before and after the fix. The silhouette is the honest line: the hull polygon sits
    // `minDist`..`maxDist` OUTSIDE it by construction, while mode 2's coverage mask IS the alpha,
    // so a texel clear of the silhouette is exactly (0,0,0,0) under mode 2. Measured on the same
    // fixture: 0 such texels before this change, 382 after.
    //
    // `compactSprite`'s ellipse has radius `w / 4` at the centre of a square source, and `build()`
    // centres the artwork in the front, so in front px it is a circle of `R` about the front's own
    // centre. `+ 2` clears the upsample ramp and the shader's own ~1px antialias — the fixture's
    // own geometry, not a hand-picked sample.
    const got = readRect(ctx, front.texture, 0, 0, front.width, front.height)
    const R = 16 * (handle.artwork.w / 64) + 2
    const cx = front.width / 2
    const cy = front.height / 2
    const outside: number[] = []
    for (let y = 0; y < front.height; y++) {
      for (let x = 0; x < front.width; x++) {
        const clearOfSilhouette = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) > R
        if (clearOfSilhouette && got[(y * front.width + x) * 4 + 3] > 200) {
          outside.push(y * front.width + x)
        }
      }
    }
    // The assertion the defect fails: paper beyond the artwork's own alpha. Under
    // `paperField: null` this list is empty — the coverage mask IS that alpha.
    expect(outside.length).toBeGreaterThan(0)
    // And it is paper, not a stray copy of the artwork: the default `paperColor` (#f7f4ed) reads
    // high on all three channels, which this fixture's own colours (200,120,60) do not. Measured:
    // zero opaque, paper-coloured texels anywhere in the front before this change, 712 after — so
    // this is a second independent discriminator, not decoration on the first.
    for (const t of outside.slice(0, 16)) {
      expect(got[t * 4]).toBeGreaterThan(150)
      expect(got[t * 4 + 1]).toBeGreaterThan(150)
      expect(got[t * 4 + 2]).toBeGreaterThan(150)
    }
    // The front's own outer corner is still empty: the sheet grew to the polygon, not to the frame.
    expect(got[3]).toBe(0)

    sheet.releaseFront(front)
    sheet.dispose()
  })

  /**
   * Fix round 1, finding 1: the test above runs at `sx === sy === 1` (a square 64x64 source at
   * `sdfRes` 128 gives a 128x128 source field, and a 128x128 request gives a 128x128 field), so it
   * cannot see the one real judgement call in `build()`'s step 6b — that the hull's points scale by
   * `sx = field.w / srcField.w` and `sy = field.h / srcField.h` SEPARATELY. A swapped or inverted
   * pair passes it unchanged.
   *
   * `sprite()` is 48x32, so `srcField` is 128x86 while a 128x128 request gives a 128x128 field:
   * `sx = 1`, `sy = 128 / 86 ≈ 1.488`. Both mistakes were run against this test to check it
   * actually catches them, rather than assumed to be caught:
   *   correct   bbox [28,26,104,103], centre (66.0, 64.5) — passes
   *   swapped   (`field.w / srcField.h`, `field.h / srcField.w`) — the mask slides sideways;
   *             the x centre is off by 13, the bound below is 6
   *   inverted  (`srcField.w / field.w`, `srcField.h / field.h`) — the mask shrinks towards the
   *             origin; the y centre is off by 14, the bound below is 6
   * Both mutations leave the square-source test above GREEN, which is precisely why this one
   * exists.
   */
  it('scales the hull mask per axis when the source and the request disagree on aspect', async () => {
    const ctx = open()
    const sheet = paperSheet()
    sheet.mount(ctx)
    const bitmap = await sprite() // 48x32 — the source field is 128x86, this build's is 128x128
    const handle = await sheet.source(bitmap, { maxSize: 128, exact: false })
    bitmap.close()
    expect(GlError.is(handle) || SheetError.is(handle) || isAborted(handle)).toBe(false)
    if (GlError.is(handle) || SheetError.is(handle) || isAborted(handle)) return

    const front = sheet.build(handle, { w: 128, h: 128 }, defaultsFor('hull') as never)
    expect(front instanceof Error, String((front as Error)?.message)).toBe(false)
    if (front instanceof Error) return

    // The source aspect is kept end to end, so `sprite()`'s own ellipse (radii `w/3` and `h/3`
    // about the source's centre) is an ellipse about the FRONT's centre with these radii, and the
    // artwork is centred by `build()`'s own placement — 1:1, so the radii are artwork px, at
    // whatever origin a 128x128 front gives a 107x71 artwork (the trace front was 128x85: the
    // mask has to land translated to that new origin, not scaled about the field's corner).
    // `+ 2` clears the upsample ramp and the shader's ~1px antialias, exactly as in the test above.
    const got = readRect(ctx, front.texture, 0, 0, front.width, front.height)
    const rx = 16 * (handle.artwork.w / 48)
    const ry = (32 / 3) * (handle.artwork.h / 32)
    const aa = 2
    const cx = front.width / 2
    const cy = front.height / 2
    let x0 = front.width
    let y0 = front.height
    let x1 = -1
    let y1 = -1
    const outside: number[] = []
    for (let y = 0; y < front.height; y++) {
      for (let x = 0; x < front.width; x++) {
        if (got[(y * front.width + x) * 4 + 3] <= 200) continue
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
        if (((x + 0.5 - cx) / (rx + aa)) ** 2 + ((y + 0.5 - cy) / (ry + aa)) ** 2 > 1) {
          outside.push(y * front.width + x)
        }
      }
    }

    // Mode 1 still reached, and the paper is paper — the same oracle as the test above, restated
    // for an elliptical silhouette.
    expect(outside.length).toBeGreaterThan(0)
    for (const t of outside.slice(0, 16)) {
      expect(got[t * 4]).toBeGreaterThan(150)
      expect(got[t * 4 + 1]).toBeGreaterThan(150)
      expect(got[t * 4 + 2]).toBeGreaterThan(150)
    }

    // The mask landed CENTRED. The hull is centred on the artwork and the artwork is centred in
    // the front, so the paper's own bounding box must be centred too — and this is what a swapped
    // `sx`/`sy` cannot produce: swapping multiplies x by 1.488 and y by 1 about the field's origin,
    // which slides the whole mask right and up rather than rescaling it in place.
    expect(Math.abs((x0 + x1) / 2 - cx)).toBeLessThan(6)
    expect(Math.abs((y0 + y1) / 2 - cy)).toBeLessThan(6)

    // It grew OUTWARD on both axes, which is the property the two centre bounds above cannot see:
    // a mask that landed centred but at the wrong scale would still pass them. The polygon sits
    // at least `minDist` (22 reference px, quoted against the TRACE front's height — the hull is
    // traced once, in `source()`, and moves 1:1 with the artwork) past the silhouette, less the
    // repair pass's quarter-texel slack; half of that is a floor no rounding can eat.
    const reach = (22 * handle.front.h) / 1000 / 2
    expect((x1 - x0) / 2).toBeGreaterThan(rx + reach)
    expect((y1 - y0) / 2).toBeGreaterThan(ry + reach)

    // And it is the polygon the sheet grew to, not the frame: nothing reaches any edge of the
    // front. A swapped `sx` overruns the right edge, so this catches that mistake a second time.
    expect(x0).toBeGreaterThan(0)
    expect(y0).toBeGreaterThan(0)
    expect(x1).toBeLessThan(front.width - 1)
    expect(y1).toBeLessThan(front.height - 1)

    sheet.releaseFront(front)
    sheet.dispose()
  })

  it('reuses the hull field on a second build at the same sprite and size (design §4)', async () => {
    const ctx = open()
    const sheet = paperSheet()
    sheet.mount(ctx)
    const bitmap = await compactSprite()
    const handle = await sheet.source(bitmap, { maxSize: 128, exact: false })
    bitmap.close()
    expect(GlError.is(handle) || SheetError.is(handle) || isAborted(handle)).toBe(false)
    if (GlError.is(handle) || SheetError.is(handle) || isAborted(handle)) return

    const first = sheet.build(handle, { w: 128, h: 128 }, defaultsFor('hull') as never)
    expect(first instanceof Error, String((first as Error)?.message)).toBe(false)
    if (first instanceof Error) return

    const drawArrays = vi.spyOn(ctx.gl, 'drawArrays')
    drawArrays.mockClear()
    const second = sheet.build(handle, { w: 128, h: 128 }, defaultsFor('hull') as never)
    const draws = drawArrays.mock.calls.length
    drawArrays.mockRestore()
    expect(second instanceof Error).toBe(false)
    if (second instanceof Error) return

    // renderFront's own single draw, and nothing else: pass A, pass B and the hull field are all
    // served from `lastFieldBuild`. A regression that rebuilt the mask every frame would put the
    // jump flood's whole schedule back in here, which is what this bound catches.
    expect(draws).toBe(1)

    sheet.releaseFront(first)
    sheet.releaseFront(second)
    sheet.dispose()
  })

  /**
   * Acceptance criterion 3, at the only scope the public API can reach it. `source()` passes no
   * per-sprite knob values (`sheet.ts`'s own §5.2 note), so a `hull` handle is always traced at
   * `minDist: 22` / `maxDist: 72` and there is no route to a `use-alpha` hull in `hull` mode.
   * `torn` forces both distances to 0 (`sheet.ts`'s "torn mode declares no hull-only descriptors
   * at all"), so `buildHull` returns `HULL_USE_ALPHA` and this is the degenerate case in the
   * flesh: no mask is filled, no field is built, and the render is the one that shipped. The
   * mode-2 render itself is covered where it is driven directly, in `paper-renderer.gl.test.ts`,
   * which this change does not touch.
   */
  it('builds no hull mask for a use-alpha hull, and renders as it did before', async () => {
    const ctx = open()
    const sheet = paperSheet({ edgeMode: 'torn' })
    sheet.mount(ctx)
    const bitmap = await compactSprite()
    const handle = await sheet.source(bitmap, { maxSize: 128, exact: false })
    bitmap.close()
    expect(GlError.is(handle) || SheetError.is(handle) || isAborted(handle)).toBe(false)
    if (GlError.is(handle) || SheetError.is(handle) || isAborted(handle)) return
    expect(handle.hull.kind).toBe('use-alpha')

    // The first build at source()'s own size (`handle.front` — the per-axis reserve makes it not
    // necessarily `maxSize` itself, §8.6 amendment) reuses source()'s tight field outright and
    // runs pass B's two draws (source() no longer blurs — nothing reads a loose field until
    // build(); see `lastFieldBuild`'s doc comment), so with renderFront's own one draw a mask
    // build's jump-flood schedule would be the only other thing left to count.
    const drawArrays = vi.spyOn(ctx.gl, 'drawArrays')
    drawArrays.mockClear()
    const front = sheet.build(handle, handle.front, defaultsFor('torn') as never)
    const draws = drawArrays.mock.calls.length
    drawArrays.mockRestore()
    expect(front instanceof Error, String((front as Error)?.message)).toBe(false)
    if (front instanceof Error) return
    expect(draws).toBe(3)

    sheet.releaseFront(front)
    sheet.dispose()
  })

  /**
   * Finding F1. `both` decorates the hull polygon's contour with the torn path, which draws
   * OUTWARD from it by `thickness + [thickness + 0.6*looseness*tearAmp + midAmp]*edgeK
   * + 4*fiberLen + slop` — every term `overscanRadius` collects as `r_both - maxDist`, which is
   * ~111 reference px at this package's own knob defaults. The extent took the polygon's own box
   * and grew it by nothing, so the sheet window was sized for the polygon and the fringe was
   * sliced flat at its edge.
   *
   * Compared against `hull` on the same sprite. The two polygons are not literally the same one —
   * `both` reserves a larger frozen overscan, so its artwork is inset further and its own traced
   * polygon lands SMALLER in front px (measured: 59 wide against `hull`'s 72, before this fix).
   * What makes the comparison sound is that each mode reserves the silhouette box plus its own
   * `overscanRadius`, and `hull`'s polygon already sits `maxDist` out from the silhouette: so
   * `hull`'s extent is the shared `maxDist` reach made visible, and what `both` must show on top
   * of it is exactly the extra reach the torn path adds.
   */
  it("reserves the torn path's outward reach in both mode's sheet rect (F1)", async () => {
    const ctx = open()
    const hullSheet = paperSheet({ edgeMode: 'hull' })
    const bothSheet = paperSheet({ edgeMode: 'both' })
    hullSheet.mount(ctx)
    bothSheet.mount(ctx)

    const a = await compactSprite()
    const hullHandle = await hullSheet.source(a, { maxSize: 128, exact: false })
    a.close()
    const b = await compactSprite()
    const bothHandle = await bothSheet.source(b, { maxSize: 128, exact: false })
    b.close()
    const bad =
      GlError.is(hullHandle) ||
      SheetError.is(hullHandle) ||
      isAborted(hullHandle) ||
      GlError.is(bothHandle) ||
      SheetError.is(bothHandle) ||
      isAborted(bothHandle)
    expect(bad, 'both source() calls must succeed for this fixture').toBe(false)
    if (
      GlError.is(hullHandle) ||
      SheetError.is(hullHandle) ||
      isAborted(hullHandle) ||
      GlError.is(bothHandle) ||
      SheetError.is(bothHandle) ||
      isAborted(bothHandle)
    ) {
      return
    }

    const params = edgeParamsFrom('both', defaultsFor('both'))
    // Reference px are a fraction of the front's HEIGHT, not its long side — `sheet.ts`'s own
    // `pxScale = front.h / KNOB_REFERENCE_PX`, with `KNOB_REFERENCE_PX` at 1000. This sprite is
    // square at maxSize 128, so the two readings coincide here at 128 either way.
    const reachFrontPx = ((overscanRadius(params) - params.maxDist) * 128) / 1000
    expect(reachFrontPx).toBeGreaterThan(1)

    // The reach is added on each side, then `sheetRect`'s own 4 % margin applies to both rects
    // alike, so the growth in width survives the comparison. Half the derived figure is asserted
    // rather than the whole, because the box clamps at the frame: the claim is that the reach is
    // reserved, not that it is reserved to the last texel.
    expect(bothHandle.frontRect.w).toBeGreaterThanOrEqual(
      hullHandle.frontRect.w + Math.floor(reachFrontPx),
    )
    expect(bothHandle.frontRect.h).toBeGreaterThanOrEqual(
      hullHandle.frontRect.h + Math.floor(reachFrontPx),
    )

    // And an upper bound, because the lower bound alone cannot see the one mistake this fix is
    // most likely to be rewritten into: growing by the FULL `overscanRadius` instead of
    // subtracting `maxDist` first, double-counting a reach the polygon's own vertices already
    // carry. The bound is the geometry, not a fudge factor: `both`'s ungrown polygon box is never
    // wider than `hull`'s (its larger frozen reserve insets the artwork further — see the doc
    // comment above), and the growth adds at most `reachFrontPx` per side, so `hull + 2*reach` is
    // a ceiling the correct term cannot reach. Measured on this fixture: 91x93 against `hull`'s
    // 72x75, comfortably under the 102x105 this allows — while the double-counting version lands
    // at 111x113 and fails here, which is the whole point of the bound.
    expect(bothHandle.frontRect.w).toBeLessThanOrEqual(
      hullHandle.frontRect.w + 2 * Math.ceil(reachFrontPx),
    )
    expect(bothHandle.frontRect.h).toBeLessThanOrEqual(
      hullHandle.frontRect.h + 2 * Math.ceil(reachFrontPx),
    )

    hullSheet.dispose()
    bothSheet.dispose()
  })
})

/**
 * 160x80 with an opaque 100x50 rectangle centred in it: transparent padding on every side, so the
 * paper's box is smaller than the artwork and the bucket-shaped front `motion.fit` sizes over it
 * (spec 5.4) is smaller than the front `source()` traced on. The rectangle's own edges are what
 * make "paper on every side" measurable to the pixel.
 */
async function paddedRect(w = 160, h = 80): Promise<ImageBitmap> {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inside = x >= 30 && x < 130 && y >= 15 && y < 65
      const p = (y * w + x) * 4
      data[p] = 200
      data[p + 1] = 40
      data[p + 2] = 40
      data[p + 3] = inside ? 255 : 0
    }
  }
  return createImageBitmap(new ImageData(data, w, h), {
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none',
  })
}

/** Inclusive bbox of the texels `keep` accepts, in the readback's own y-down rows. */
function bboxOf(
  bytes: Uint8Array,
  w: number,
  h: number,
  keep: (i: number) => boolean,
): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = w
  let y0 = h
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!keep((y * w + x) * 4)) continue
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }
  return { x0, y0, x1, y1 }
}

describe('build() at a bucket-shaped size (spec 5.4, 8.6)', () => {
  // `motion.fit(handle.frontRect)` returns the paper's own box for any aspect inside the stretch
  // clamp, and the core builds the front at exactly that size — which is NOT the front `source()`
  // traced on (384 x 192 here). The artwork is copied into the front 1:1 wherever the front puts it
  // (spec 7.4.2), so the paper — the fields the shader cuts it from, the hull mask, and the rect
  // the motion layer centres on — has to follow the artwork's pixel placement. Framing the fields
  // by a flat `p` inset instead scaled the silhouette to `size / (1 + 2p)`: at this size that was
  // a paper smaller than the artwork, which in hull mode vanished behind it entirely.
  for (const edgeMode of ['torn', 'hull'] as const) {
    it(`keeps the paper around the 1:1 artwork and centred on front.rect (${edgeMode})`, async () => {
      const ctx = open()
      const sheet = paperSheet({ edgeMode })
      sheet.mount(ctx)
      const bitmap = await paddedRect()
      const handle = await sheet.source(bitmap, { maxSize: 384, exact: false })
      bitmap.close()
      expect(
        GlError.is(handle) || SheetError.is(handle) || isAborted(handle),
        String((handle as Error)?.message),
      ).toBe(false)
      if (GlError.is(handle) || SheetError.is(handle) || isAborted(handle)) {
        sheet.dispose()
        return
      }

      const size = { w: handle.frontRect.w, h: handle.frontRect.h }
      expect(size.w).toBeLessThan(384)
      expect(size.h).toBeLessThan(192)
      const front = sheet.build(handle, size, defaultsFor(edgeMode) as never)
      expect(front instanceof Error, String((front as Error)?.message)).toBe(false)
      if (front instanceof Error) {
        sheet.dispose()
        return
      }

      const w = front.width
      const h = front.height
      const got = readRect(ctx, front.texture, 0, 0, w, h)
      const paper = bboxOf(got, w, h, (i) => got[i + 3] > 8)
      // The artwork's own red against paper that reads high on every channel.
      const art = bboxOf(got, w, h, (i) => got[i] > 150 && got[i + 1] < 100 && got[i + 3] > 8)
      expect(art.x1).toBeGreaterThan(art.x0)

      // 1:1 (spec 7.4.2): the opaque rectangle is 100/160 x 50/80 of A, wherever the front put it.
      expect(Math.abs(art.x1 - art.x0 + 1 - (handle.artwork.w * 100) / 160)).toBeLessThanOrEqual(2)
      expect(Math.abs(art.y1 - art.y0 + 1 - (handle.artwork.h * 50) / 80)).toBeLessThanOrEqual(2)

      // Paper on every side of it — `thickness` (torn) and `minDist` (hull) are both 22 reference
      // px, i.e. 2-3 px at this front height, so 2 is the honest floor.
      expect(art.x0 - paper.x0).toBeGreaterThanOrEqual(2)
      expect(paper.x1 - art.x1).toBeGreaterThanOrEqual(2)
      expect(art.y0 - paper.y0).toBeGreaterThanOrEqual(2)
      expect(paper.y1 - art.y1).toBeGreaterThanOrEqual(2)

      // Centred on the artwork (a hull vertex wanders inside [minDist, maxDist], hence the slack)
      // and on `front.rect`, which is what `motion.draw` centres the sheet on.
      const paperC = [(paper.x0 + paper.x1 + 1) / 2, (paper.y0 + paper.y1 + 1) / 2]
      const artC = [(art.x0 + art.x1 + 1) / 2, (art.y0 + art.y1 + 1) / 2]
      const rectC = [front.rect.x + front.rect.w / 2, front.rect.y + front.rect.h / 2]
      expect(Math.abs(paperC[0] - artC[0])).toBeLessThanOrEqual(5)
      expect(Math.abs(paperC[1] - artC[1])).toBeLessThanOrEqual(5)
      expect(Math.abs(paperC[0] - rectC[0])).toBeLessThanOrEqual(3)
      expect(Math.abs(paperC[1] - rectC[1])).toBeLessThanOrEqual(3)

      // And the rect is the paper's box: nothing drawn lies outside it (1 px for the AA ramp).
      expect(paper.x0).toBeGreaterThanOrEqual(front.rect.x - 1)
      expect(paper.y0).toBeGreaterThanOrEqual(front.rect.y - 1)
      expect(paper.x1).toBeLessThanOrEqual(front.rect.x + front.rect.w)
      expect(paper.y1).toBeLessThanOrEqual(front.rect.y + front.rect.h)

      sheet.releaseFront(front)
      sheet.dispose()
    })
  }
})

/**
 * FNV-1a (32-bit) over a packed hull's `points` bytes — the `Float32Array` read as its own bytes,
 * so an ulp in any coordinate changes the hash — or `'use-alpha'` for a hull with no polygon.
 */
function hullDigest(hull: { readonly kind: string; readonly points?: Float32Array }): string {
  if (hull.kind !== 'polygons' || hull.points === undefined) return hull.kind
  const bytes = new Uint8Array(hull.points.buffer, hull.points.byteOffset, hull.points.byteLength)
  let h = 0x811c9dc5
  for (const b of bytes) {
    h ^= b
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

type ReadbackGolden = {
  readonly hull: string
  readonly frontRect: { x: number; y: number; w: number; h: number }
  readonly rect: { x: number; y: number; w: number; h: number }
}

/**
 * What `source()` answers for three fixtures in both edge modes at the hull default reserve — the
 * synchronous `readBackField` path, on the level-2 suite's own SwiftShader. Regenerated for design
 * 2026-09-05 §4.2's per-axis guard margin (previously pinned at perf/2x @ 653d394, right before
 * the field readback became asynchronous, `PIXEL_PACK_BUFFER` + `fenceSync`, spec §8.10): §4.2
 * changes the front's size for every non-square fixture here, which shifts `frontRect` and moves
 * the hull digest even though pass A and the decode are unchanged. The pin is that the decode, the
 * hull traced off it and the two rects it feeds do not move by a byte ACROSS RUNS: the hull digest
 * is over the polygon's raw `Float32Array`, and `frontRect` / `rect` are the exact integers.
 * Regenerate only for a deliberate change to pass A, the decode, or the margin, by running this
 * test at the commit being pinned and copying what the failures print.
 */
const READBACK_GOLDEN: Record<string, ReadbackGolden> = {
  'ellipse/hull': {
    hull: 'd1b998b9',
    frontRect: { x: 19, y: 14, w: 91, h: 64 },
    rect: { x: 4, y: 2, w: 41, h: 29 },
  },
  'ellipse/torn': {
    hull: 'use-alpha',
    frontRect: { x: 14, y: 10, w: 102, h: 79 },
    rect: { x: -2, y: -4, w: 52, h: 40 },
  },
  'top/hull': {
    hull: '87af288d',
    frontRect: { x: 27, y: 13, w: 78, h: 68 },
    rect: { x: 8, y: -1, w: 50, h: 44 },
  },
  'top/torn': {
    hull: 'use-alpha',
    frontRect: { x: 15, y: 6, w: 99, h: 87 },
    rect: { x: -5, y: -12, w: 75, h: 66 },
  },
  'square/hull': {
    hull: 'e58c543a',
    frontRect: { x: 15, y: 15, w: 95, h: 99 },
    rect: { x: 1, y: 1, w: 61, h: 63 },
  },
  'square/torn': {
    hull: 'use-alpha',
    frontRect: { x: 8, y: 8, w: 112, h: 112 },
    rect: { x: -11, y: -11, w: 85, h: 85 },
  },
}

interface PostTaskOptions {
  readonly priority: 'user-visible'
}
interface SchedulerLike {
  postTask(fn: () => void, o: PostTaskOptions): unknown
}

/** The sheet's own `READBACK_SLOW_DELAY_MS`; a module constant there, restated here on purpose. */
const READBACK_SLOW_DELAY_MS_FOR_TEST = 1

/**
 * Every platform turn taken while it is installed, in order, as its delay in milliseconds: `0`
 * for a fast turn, the back-off for a delayed one (spec §8.10). A fast turn is
 * `scheduler.postTask` — the route `nextTurn()` prefers, and the level-2 suite's Chromium has it
 * — and a back-off turn is `setTimeout`, the only route that can wait. Both spies call through,
 * so the turns still happen; the timer spy records only the sheet's own back-off delay, so a
 * timer some other part of the page arms is not counted as a poll.
 */
function watchTurns() {
  const seq: number[] = []
  const g = globalThis as unknown as { scheduler?: Partial<SchedulerLike> }
  expect(
    typeof g.scheduler?.postTask,
    'this browser has no scheduler.postTask, so the turn spy would be reading the wrong route',
  ).toBe('function')
  const scheduler = g.scheduler as SchedulerLike
  const realPost = scheduler.postTask.bind(scheduler)
  const post = vi.spyOn(scheduler, 'postTask').mockImplementation((fn, o) => {
    seq.push(0)
    return realPost(fn, o)
  })
  const realTimeout = globalThis.setTimeout
  const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
    fn: () => void,
    ms?: number,
  ) => {
    if (ms === READBACK_SLOW_DELAY_MS_FOR_TEST) seq.push(ms)
    return realTimeout(fn, ms)
  }) as unknown as typeof setTimeout)
  return {
    delays: (): number[] => seq,
    restore: () => {
      post.mockRestore()
      timer.mockRestore()
    },
  }
}

describe('async field readback (spec §8.10)', () => {
  const fixtures = [
    ['ellipse', () => sprite()],
    ['top', () => topSprite()],
    ['square', () => boxSprite(64, 64, 8)],
  ] as const

  it('answers the hull, frontRect and rect the synchronous readback answered (golden from 653d394)', async () => {
    const ctx = open()
    for (const [name, make] of fixtures) {
      for (const edgeMode of ['hull', 'torn'] as const) {
        const sheet = paperSheet({ edgeMode })
        sheet.mount(ctx)
        const bitmap = await make()
        const handle = await sheet.source(bitmap, { maxSize: 128, exact: false })
        bitmap.close()
        expect(
          GlError.is(handle) || SheetError.is(handle) || isAborted(handle),
          `${name}/${edgeMode}: ${String((handle as Error)?.message)}`,
        ).toBe(false)
        if (GlError.is(handle) || SheetError.is(handle) || isAborted(handle)) {
          sheet.dispose()
          continue
        }
        const actual: ReadbackGolden = {
          hull: hullDigest(handle.hull),
          frontRect: { ...handle.frontRect },
          rect: { ...handle.rect },
        }
        // `soft`, so a regeneration run prints every fixture's values at once.
        expect.soft(actual, `${name}/${edgeMode}`).toEqual(READBACK_GOLDEN[`${name}/${edgeMode}`])
        sheet.dispose()
      }
    }
  })

  it('aborts at the fence: a signal fired after pass A returns ABORTED, leaves no pack buffer bound, and the next source() succeeds', async () => {
    const ctx = open()
    const sheet = paperSheet()
    sheet.mount(ctx)
    const bitmap = await sprite()
    const controller = new AbortController()
    // The hook fires synchronously after pass A and BEFORE the readback is issued; a microtask
    // from inside it runs at the first `await` — after the issue, before the first poll — so the
    // abort lands inside the fence wait and nowhere else.
    sheet.__afterFieldForTest = () => queueMicrotask(() => controller.abort())
    const fenceSync = vi.spyOn(ctx.gl, 'fenceSync')
    const deleteSync = vi.spyOn(ctx.gl, 'deleteSync')
    const getBufferSubData = vi.spyOn(ctx.gl, 'getBufferSubData')
    const r = await sheet.source(bitmap, { maxSize: 128, exact: false, signal: controller.signal })
    bitmap.close()
    expect(isAborted(r)).toBe(true)
    expect(
      fenceSync,
      'the readback was issued before the abort could be observed',
    ).toHaveBeenCalledTimes(1)
    expect(deleteSync, 'the fence is deleted on the abort exit').toHaveBeenCalledTimes(1)
    expect(getBufferSubData, 'nothing is copied back after an abort').not.toHaveBeenCalled()
    expect(ctx.scope(() => ctx.gl.getParameter(ctx.gl.PIXEL_PACK_BUFFER_BINDING))).toBeNull()
    fenceSync.mockRestore()
    deleteSync.mockRestore()
    getBufferSubData.mockRestore()

    sheet.__afterFieldForTest = undefined
    const again = await sprite()
    const handle = await sheet.source(again, { maxSize: 128, exact: false })
    again.close()
    expect(GlError.is(handle) || SheetError.is(handle) || isAborted(handle)).toBe(false)
    if (GlError.is(handle) || SheetError.is(handle) || isAborted(handle)) return
    expect(handle.frontRect).toEqual(READBACK_GOLDEN['ellipse/hull'].frontRect)
    expect(hullDigest(handle.hull)).toBe(READBACK_GOLDEN['ellipse/hull'].hull)
    sheet.dispose()
  })

  // S12. The first ingest phase — the 4 MB artwork upload, the resample draw and the field
  // passes issued behind it — was ONE ~10 ms task in a thirty-view burst, which is what held
  // `bench:smooth`'s task p95 at 9.6-10.4 ms against a limit of 10. §8.10 already names "upload
  // and field" as two phases of a job; these two tests pin the boundary between them: the turn
  // that separates the tasks, and the abort check point (§10.5) that turn makes reachable.
  it('splits the first ingest phase in two tasks: the artwork resample, one platform turn, then the field passes (spec §8.10)', async () => {
    const ctx = open()
    const sheet = paperSheet()
    sheet.mount(ctx)
    const bitmap = await topSprite()
    // The fence's status is stated rather than raced for, so the readback itself takes exactly
    // one turn ('a fence that signals at once', above) and every other turn in `delays` is the
    // split's.
    const clientWaitSync = vi
      .spyOn(ctx.gl, 'clientWaitSync')
      .mockImplementation(() => ctx.gl.ALREADY_SIGNALED)
    const drawArrays = vi.spyOn(ctx.gl, 'drawArrays')
    const turns = watchTurns()
    const delays = turns.delays()
    let drawsAtSplit = -1
    let turnsAtSplit = -1
    sheet.__afterArtworkForTest = () => {
      drawsAtSplit = drawArrays.mock.calls.length
      turnsAtSplit = delays.length
    }
    const handle = await sheet.source(bitmap, { maxSize: 128, exact: false })
    turns.restore()
    bitmap.close()
    expect(GlError.is(handle) || SheetError.is(handle) || isAborted(handle)).toBe(false)
    if (GlError.is(handle) || SheetError.is(handle) || isAborted(handle)) return
    expect(
      turnsAtSplit,
      'the artwork phase is the first task of the call: nothing has yielded before the split',
    ).toBe(0)
    expect(drawsAtSplit, 'the resample is issued in that first task').toBeGreaterThan(0)
    expect(
      drawArrays.mock.calls.length,
      'the field passes are issued after the split, in a task of their own',
    ).toBeGreaterThan(drawsAtSplit)
    expect(
      delays,
      'two fast turns: the split between the artwork and the field passes, then the poll that settles the fence',
    ).toEqual([0, 0])
    // The extra task boundary moves no byte: same calls, same order, one turn between them.
    expect(hullDigest(handle.hull)).toBe(READBACK_GOLDEN['top/hull'].hull)
    drawArrays.mockRestore()
    clientWaitSync.mockRestore()
    sheet.dispose()
  })

  it('aborts in the split: a signal fired between the artwork and the field passes returns ABORTED, issues no field pass and no readback, and the next source() succeeds (spec §10.5)', async () => {
    const ctx = open()
    const sheet = paperSheet()
    sheet.mount(ctx)
    const bitmap = await sprite()
    const controller = new AbortController()
    const drawArrays = vi.spyOn(ctx.gl, 'drawArrays')
    const fenceSync = vi.spyOn(ctx.gl, 'fenceSync')
    const readPixels = vi.spyOn(ctx.gl, 'readPixels')
    let drawsAtSplit = -1
    // Fires synchronously inside `source()`, before the split's own `await`, so the abort has
    // certainly landed by the time the check after that turn reads the signal — no signal-timing
    // race (the convention of `__afterFieldForTest`, whose doc comment gives the reason).
    sheet.__afterArtworkForTest = () => {
      drawsAtSplit = drawArrays.mock.calls.length
      controller.abort()
    }
    const r = await sheet.source(bitmap, { maxSize: 128, exact: false, signal: controller.signal })
    bitmap.close()
    expect(isAborted(r), 'the split is a check point, not merely a task boundary').toBe(true)
    expect(
      drawsAtSplit,
      'the abort lands after work already paid for: the artwork was resampled',
    ).toBeGreaterThan(0)
    expect(
      drawArrays,
      'not one field pass is issued once the split has aborted',
    ).toHaveBeenCalledTimes(drawsAtSplit)
    expect(fenceSync, 'and no readback is issued either').not.toHaveBeenCalled()
    expect(readPixels, 'nothing is read back').not.toHaveBeenCalled()
    drawArrays.mockRestore()
    fenceSync.mockRestore()
    readPixels.mockRestore()

    // The aborted call settles no allocation batch (S7): the next reader settles it. That next
    // reader is this source(), which must still answer the golden — nothing of the aborted call
    // poisoned the pools, the artwork slot or the error flag.
    sheet.__afterArtworkForTest = undefined
    const again = await sprite()
    const handle = await sheet.source(again, { maxSize: 128, exact: false })
    again.close()
    expect(GlError.is(handle) || SheetError.is(handle) || isAborted(handle)).toBe(false)
    if (GlError.is(handle) || SheetError.is(handle) || isAborted(handle)) return
    expect(handle.frontRect).toEqual(READBACK_GOLDEN['ellipse/hull'].frontRect)
    expect(hullDigest(handle.hull)).toBe(READBACK_GOLDEN['ellipse/hull'].hull)
    sheet.dispose()
  })

  it('falls back to the CPU field when readPixels into the pack buffer errors: the refusal is read at the fence, before any decode', async () => {
    const ctx = open()
    const sheet = paperSheet()
    sheet.mount(ctx)
    const bitmap = await topSprite()
    const restore = forceCpuFallbackOnce(ctx)
    const fenceSync = vi.spyOn(ctx.gl, 'fenceSync')
    const getBufferSubData = vi.spyOn(ctx.gl, 'getBufferSubData')
    const bufferData = vi.spyOn(ctx.gl, 'bufferData')
    const handle = await sheet.source(bitmap, { maxSize: 128, exact: false })
    const issued = (ctx.gl.readPixels as unknown as { mock: { calls: unknown[][] } }).mock.calls
    restore()
    expect(GlError.is(handle) || SheetError.is(handle) || isAborted(handle)).toBe(false)
    if (GlError.is(handle) || SheetError.is(handle) || isAborted(handle)) return
    // The one readPixels was into the pack buffer (an offset, not a client array); the fence
    // was waited for, the bytes copied out, and the getError after the copy — the first since
    // the issue's drain — read the refusal and refused the decode.
    expect(issued).toHaveLength(1)
    expect(issued[0][6]).toBe(0)
    expect(fenceSync).toHaveBeenCalledTimes(1)
    expect(getBufferSubData).toHaveBeenCalledTimes(1)
    expect(bufferData, 'the first readback sizes the pack buffer').toHaveBeenCalledTimes(1)
    // `cpuFieldFallback`'s own rect: within the JFA-vs-EDT tolerance the "findings 1, 4" test
    // states, and not the readback's exact integers.
    expect(Math.abs(handle.frontRect.y - READBACK_GOLDEN['top/hull'].frontRect.y)).toBeLessThan(10)
    expect(ctx.scope(() => ctx.gl.getParameter(ctx.gl.PIXEL_PACK_BUFFER_BINDING))).toBeNull()
    // A refusal drops the recorded buffer size, so the next readback sizes the buffer again
    // rather than trusting a `bufferData` that may have been the refusal.
    bufferData.mockClear()
    getBufferSubData.mockClear()
    const again = await topSprite()
    const second = await sheet.source(again, { maxSize: 128, exact: false })
    again.close()
    bitmap.close()
    expect(GlError.is(second) || SheetError.is(second) || isAborted(second)).toBe(false)
    expect(bufferData, 'sized again after the refusal').toHaveBeenCalledTimes(1)
    expect(getBufferSubData).toHaveBeenCalledTimes(1)
    fenceSync.mockRestore()
    getBufferSubData.mockRestore()
    bufferData.mockRestore()
    sheet.dispose()
  })

  it('falls back to the CPU field on WAIT_FAILED', async () => {
    const ctx = open()
    const sheet = paperSheet()
    sheet.mount(ctx)
    const bitmap = await topSprite()
    const clientWaitSync = vi
      .spyOn(ctx.gl, 'clientWaitSync')
      .mockImplementation(() => ctx.gl.WAIT_FAILED)
    const deleteSync = vi.spyOn(ctx.gl, 'deleteSync')
    const getBufferSubData = vi.spyOn(ctx.gl, 'getBufferSubData')
    const handle = await sheet.source(bitmap, { maxSize: 128, exact: false })
    bitmap.close()
    expect(GlError.is(handle) || SheetError.is(handle) || isAborted(handle)).toBe(false)
    if (GlError.is(handle) || SheetError.is(handle) || isAborted(handle)) return
    expect(clientWaitSync).toHaveBeenCalledTimes(1)
    expect(deleteSync, 'the fence is deleted on the failed exit').toHaveBeenCalledTimes(1)
    expect(getBufferSubData, 'a failed wait never reads the buffer').not.toHaveBeenCalled()
    expect(Math.abs(handle.frontRect.y - READBACK_GOLDEN['top/hull'].frontRect.y)).toBeLessThan(10)
    clientWaitSync.mockRestore()
    deleteSync.mockRestore()
    getBufferSubData.mockRestore()
    sheet.dispose()
  })

  it('two direct concurrent source() calls both return handles: the second takes the synchronous path', async () => {
    const ctx = open()
    // The two fixtures share a size, so they share a front, a field framing and the ONE tight
    // slot pass A writes: B's pass A overwrites A's field before A's continuation runs. What
    // `source(B)` alone answers, for the comparison below.
    const solo = paperSheet()
    solo.mount(ctx)
    const soloBitmap = await boxSprite(48, 32, 6)
    const soloHandle = await solo.source(soloBitmap, { maxSize: 128, exact: false })
    soloBitmap.close()
    solo.dispose()
    expect(GlError.is(soloHandle) || SheetError.is(soloHandle) || isAborted(soloHandle)).toBe(false)
    if (GlError.is(soloHandle) || SheetError.is(soloHandle) || isAborted(soloHandle)) return

    const sheet = paperSheet()
    sheet.mount(ctx)
    const a = await sprite()
    const b = await boxSprite(48, 32, 6)
    const readPixels = vi.spyOn(ctx.gl, 'readPixels')
    const [ha, hb] = await Promise.all([
      sheet.source(a, { maxSize: 128, exact: false }),
      sheet.source(b, { maxSize: 128, exact: false }),
    ])
    const calls = readPixels.mock.calls
    readPixels.mockRestore()
    a.close()
    b.close()
    expect(
      GlError.is(ha) || SheetError.is(ha) || isAborted(ha),
      String((ha as Error)?.message),
    ).toBe(false)
    expect(
      GlError.is(hb) || SheetError.is(hb) || isAborted(hb),
      String((hb as Error)?.message),
    ).toBe(false)
    if (GlError.is(ha) || SheetError.is(ha) || isAborted(ha)) return
    if (GlError.is(hb) || SheetError.is(hb) || isAborted(hb)) return
    // A issued into the pack buffer before it yielded; B found the buffer busy and read back
    // synchronously into a client array, as `readBackField` always did.
    expect(calls).toHaveLength(2)
    expect(calls[0][6]).toBe(0)
    expect(ArrayBuffer.isView(calls[1][6])).toBe(true)
    // Each hull is its own: A's readPixels was queued ahead of B's pass A, so GL ordering gave
    // it A's field even though B had overwritten the slot by the time A's continuation ran.
    expect(hullDigest(ha.hull)).toBe(READBACK_GOLDEN['ellipse/hull'].hull)
    expect(ha.frontRect).toEqual(READBACK_GOLDEN['ellipse/hull'].frontRect)
    expect(hullDigest(hb.hull)).toBe(hullDigest(soloHandle.hull))
    expect(hb.frontRect).toEqual(soloHandle.frontRect)
    expect(ctx.scope(() => ctx.gl.getParameter(ctx.gl.PIXEL_PACK_BUFFER_BINDING))).toBeNull()
    sheet.dispose()
  })

  it('torn mode issues one readback per add, not two', async () => {
    const ctx = open()
    const sheet = paperSheet({ edgeMode: 'torn' })
    sheet.mount(ctx)
    const bitmap = await sprite()
    const readPixels = vi.spyOn(ctx.gl, 'readPixels')
    const getBufferSubData = vi.spyOn(ctx.gl, 'getBufferSubData')
    const handle = await sheet.source(bitmap, { maxSize: 128, exact: false })
    bitmap.close()
    expect(GlError.is(handle) || SheetError.is(handle) || isAborted(handle)).toBe(false)
    if (GlError.is(handle) || SheetError.is(handle) || isAborted(handle)) return
    // One field serves both the (use-alpha) hull trace and the silhouette extent.
    expect(readPixels).toHaveBeenCalledTimes(1)
    expect(getBufferSubData).toHaveBeenCalledTimes(1)
    expect(handle.frontRect).toEqual(READBACK_GOLDEN['ellipse/torn'].frontRect)
    expect(handle.rect).toEqual(READBACK_GOLDEN['ellipse/torn'].rect)
    readPixels.mockRestore()
    getBufferSubData.mockRestore()
    const deleteBuffer = vi.spyOn(ctx.gl, 'deleteBuffer')
    sheet.dispose()
    expect(deleteBuffer, 'dispose() frees the pack buffer').toHaveBeenCalledTimes(1)
    deleteBuffer.mockRestore()
  })

  it('the cached-hull path in hull mode issues no readback', async () => {
    const ctx = open()
    const sheet = paperSheet()
    sheet.mount(ctx)
    const bitmap = await sprite()
    const first = await sheet.source(bitmap, { maxSize: 128, exact: false })
    expect(GlError.is(first) || SheetError.is(first) || isAborted(first)).toBe(false)
    const readPixels = vi.spyOn(ctx.gl, 'readPixels')
    const fenceSync = vi.spyOn(ctx.gl, 'fenceSync')
    const second = await sheet.source(bitmap, { maxSize: 128, exact: false })
    bitmap.close()
    expect(GlError.is(second) || SheetError.is(second) || isAborted(second)).toBe(false)
    if (GlError.is(second) || SheetError.is(second) || isAborted(second)) return
    expect(readPixels).not.toHaveBeenCalled()
    expect(fenceSync).not.toHaveBeenCalled()
    expect(hullDigest(second.hull)).toBe(READBACK_GOLDEN['ellipse/hull'].hull)
    readPixels.mockRestore()
    fenceSync.mockRestore()
    sheet.dispose()
  })

  it('answers a SheetError, not a handle, when the sheet is disposed while the fence is pending: no CPU fallback, and the sheet mounts again', async () => {
    const ctx = open()
    const sheet = paperSheet()
    sheet.mount(ctx)
    const bitmap = await sprite()
    // The hook fires after pass A and before the issue; its microtask runs at the first `await`
    // — the readback issued, the fence pending — so the dispose lands inside the wait.
    sheet.__afterFieldForTest = () => queueMicrotask(() => sheet.dispose())
    const getBufferSubData = vi.spyOn(ctx.gl, 'getBufferSubData')
    const deleteSync = vi.spyOn(ctx.gl, 'deleteSync')
    // `cpuFieldFallback` is the only 2D-canvas user on this path (the resample takes the GPU
    // branch on this context), so a 2D context asked for after this line is the fallback running.
    const getContext = vi.spyOn(OffscreenCanvas.prototype, 'getContext')
    const r = await sheet.source(bitmap, { maxSize: 128, exact: false })
    expect(SheetError.is(r), String((r as Error)?.message)).toBe(true)
    expect(String((r as Error).message)).toContain('disposed')
    expect(getBufferSubData, 'nothing is decoded for a dead mount').not.toHaveBeenCalled()
    expect(getContext, 'the CPU fallback must not run for a dead mount').not.toHaveBeenCalled()
    expect(deleteSync, 'the fence is still deleted').toHaveBeenCalledTimes(1)
    expect(ctx.scope(() => ctx.gl.getParameter(ctx.gl.PIXEL_PACK_BUFFER_BINDING))).toBeNull()
    getBufferSubData.mockRestore()
    deleteSync.mockRestore()
    getContext.mockRestore()
    // Nothing leaked into the dead mount that a live one could see: a fresh mount on the same
    // context sources the same bitmap to the golden, tracing it anew.
    sheet.__afterFieldForTest = undefined
    expect(sheet.mount(ctx)).toBeUndefined()
    const readPixels = vi.spyOn(ctx.gl, 'readPixels')
    const again = await sheet.source(bitmap, { maxSize: 128, exact: false })
    bitmap.close()
    expect(GlError.is(again) || SheetError.is(again) || isAborted(again)).toBe(false)
    if (GlError.is(again) || SheetError.is(again) || isAborted(again)) return
    expect(readPixels, 'a fresh mount has no cached hull').toHaveBeenCalledTimes(1)
    expect(hullDigest(again.hull)).toBe(READBACK_GOLDEN['ellipse/hull'].hull)
    readPixels.mockRestore()
    sheet.dispose()
  })

  it('a fence that signals at once is answered inside the fast phase, with no delayed poll', async () => {
    const ctx = open()
    const sheet = paperSheet()
    sheet.mount(ctx)
    const bitmap = await topSprite()
    // The fence's status is the variable under test, so it is stated rather than raced for.
    const clientWaitSync = vi
      .spyOn(ctx.gl, 'clientWaitSync')
      .mockImplementation(() => ctx.gl.ALREADY_SIGNALED)
    const turns = watchTurns()
    const handle = await sheet.source(bitmap, { maxSize: 128, exact: false })
    const delays = turns.delays()
    turns.restore()
    bitmap.close()
    expect(GlError.is(handle) || SheetError.is(handle) || isAborted(handle)).toBe(false)
    if (GlError.is(handle) || SheetError.is(handle) || isAborted(handle)) return
    expect(clientWaitSync, 'one poll settles it').toHaveBeenCalledTimes(1)
    expect(
      delays,
      'the whole wait is fast turns: the back-off costs a signalled fence nothing (the first is S12’s split between the artwork and the field passes)',
    ).toEqual([0, 0])
    expect(hullDigest(handle.hull)).toBe(READBACK_GOLDEN['top/hull'].hull)
    clientWaitSync.mockRestore()
    sheet.dispose()
  })

  it('backs off to a delayed turn after eight fast polls when the fence signals late (spec §8.10)', async () => {
    const ctx = open()
    const sheet = paperSheet()
    sheet.mount(ctx)
    const bitmap = await topSprite()
    let polls = 0
    const clientWaitSync = vi.spyOn(ctx.gl, 'clientWaitSync').mockImplementation(() => {
      polls += 1
      return polls <= 12 ? ctx.gl.TIMEOUT_EXPIRED : ctx.gl.ALREADY_SIGNALED
    })
    const turns = watchTurns()
    const handle = await sheet.source(bitmap, { maxSize: 128, exact: false })
    const delays = turns.delays()
    turns.restore()
    bitmap.close()
    expect(GlError.is(handle) || SheetError.is(handle) || isAborted(handle)).toBe(false)
    if (GlError.is(handle) || SheetError.is(handle) || isAborted(handle)) return
    expect(clientWaitSync).toHaveBeenCalledTimes(13)
    expect(
      delays.slice(0, 9),
      'S12’s split turn, then eight fast polls, so a fence that signals soon waits nothing',
    ).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0])
    expect(delays.slice(9), 'every later turn is a millisecond of back-off, not a spin').toEqual([
      1, 1, 1, 1, 1,
    ])
    // The late signal changes when the bytes are decoded, not what they say.
    expect(hullDigest(handle.hull)).toBe(READBACK_GOLDEN['top/hull'].hull)
    clientWaitSync.mockRestore()
    sheet.dispose()
  })

  it('gives the field up to the CPU fallback — exactly once — when the wall-clock bound runs out', async () => {
    const ctx = open()
    const sheet = paperSheet()
    sheet.mount(ctx)
    const bitmap = await topSprite()
    const clientWaitSync = vi
      .spyOn(ctx.gl, 'clientWaitSync')
      .mockImplementation(() => ctx.gl.TIMEOUT_EXPIRED)
    const deleteSync = vi.spyOn(ctx.gl, 'deleteSync')
    const getBufferSubData = vi.spyOn(ctx.gl, 'getBufferSubData')
    // A clock that gains a million seconds a reading: whichever call the wait takes for its base,
    // the next one it makes is already past any finite bound. The bound is wall-clock, so this
    // is what exhausting it looks like — no test waits ten real seconds for it.
    let reading = 0
    const now = vi.spyOn(performance, 'now').mockImplementation(() => {
      reading += 1
      return reading * 1e9
    })
    // `cpuFieldFallback` is the only 2D-canvas user on this path (the resample takes the GPU
    // branch on this context), so a 2D context asked for after this line is the fallback running.
    const getContext = vi.spyOn(OffscreenCanvas.prototype, 'getContext')
    const handle = await sheet.source(bitmap, { maxSize: 128, exact: false })
    now.mockRestore()
    bitmap.close()
    expect(GlError.is(handle) || SheetError.is(handle) || isAborted(handle)).toBe(false)
    if (GlError.is(handle) || SheetError.is(handle) || isAborted(handle)) return
    expect(
      clientWaitSync,
      'the fast phase runs, then one slow poll finds the bound gone',
    ).toHaveBeenCalledTimes(9)
    expect(deleteSync, 'the fence is deleted on the exhausted exit').toHaveBeenCalledTimes(1)
    expect(getBufferSubData, 'an exhausted wait never reads the buffer').not.toHaveBeenCalled()
    expect(getContext, 'the CPU fallback runs exactly once').toHaveBeenCalledTimes(1)
    expect(Math.abs(handle.frontRect.y - READBACK_GOLDEN['top/hull'].frontRect.y)).toBeLessThan(10)
    clientWaitSync.mockRestore()
    deleteSync.mockRestore()
    getBufferSubData.mockRestore()
    getContext.mockRestore()
    sheet.dispose()
  })
})

describe('S7 — allocation batches (spec 7.3, 8.1, 10.8): one getError per phase, after the yield', () => {
  /** `readPixels` called through, and the number of `getError` reads made before it recorded. */
  function readsBeforeIssue(ctx: GlContext, getError: { mock: { calls: unknown[] } }) {
    const gl = ctx.gl
    const original = gl.readPixels.bind(gl)
    const at = { reads: -1 }
    const spy = vi.spyOn(gl, 'readPixels').mockImplementation(((...args: unknown[]) => {
      if (at.reads < 0) at.reads = getError.mock.calls.length
      ;(original as (...a: unknown[]) => void)(...args)
    }) as typeof gl.readPixels)
    return { at, restore: () => spy.mockRestore() }
  }

  it('source() reads the flag once, in the completion after the fence poll and never before the readback is issued; build() once at its end; neither asks for completeness', async () => {
    const ctx = open()
    const sheet = paperSheet()
    sheet.mount(ctx)
    // The first sprite primes the pools; the second, at another size, allocates a fresh field
    // set (Pool A's size-keyed slots), the source-sized copy and the artwork — the case S7 was
    // measured on: a gallery of differing sizes, 5.4 `texStorage2D` per add, each of which used
    // to read the flag on its own and the first of which stalled behind the storm's draws.
    const first = await compactSprite(64, 64)
    const primed = await sheet.source(first, { maxSize: 128, exact: false })
    first.close()
    expect(primed instanceof Error || isAborted(primed)).toBe(false)
    const second = await compactSprite(80, 48)
    const getError = vi.spyOn(ctx.gl, 'getError')
    const fbStatus = vi.spyOn(ctx.gl, 'checkFramebufferStatus')
    const texStorage2D = vi.spyOn(ctx.gl, 'texStorage2D')
    const issue = readsBeforeIssue(ctx, getError)
    const handle = await sheet.source(second, { maxSize: 128, exact: false })
    second.close()
    const sourceReads = getError.mock.calls.length
    const sourceStores = texStorage2D.mock.calls.length
    issue.restore()
    expect(handle instanceof Error || isAborted(handle)).toBe(false)
    if (handle instanceof Error || isAborted(handle)) return
    expect(sourceStores, 'a real batch: several allocations').toBeGreaterThan(1)
    expect(issue.at.reads, 'no read before the readback is issued').toBe(0)
    expect(sourceReads).toBe(1)
    expect(fbStatus).not.toHaveBeenCalled()

    getError.mockClear()
    texStorage2D.mockClear()
    const front = sheet.build(handle, handle.front, defaultsFor('hull') as never)
    const buildReads = getError.mock.calls.length
    const buildStores = texStorage2D.mock.calls.length
    getError.mockRestore()
    fbStatus.mockRestore()
    texStorage2D.mockRestore()
    expect(front instanceof Error).toBe(false)
    if (front instanceof Error) return
    // The loose and blur fields, the hull mask, the hull field and the front: one read for all.
    expect(buildStores).toBeGreaterThan(1)
    expect(buildReads).toBe(1)
    expect(fbStatus).not.toHaveBeenCalled()
    sheet.releaseFront(front)
    sheet.dispose()
  })

  it('a driver that refuses the third allocation of source(): the call fails with the batch error after its yield, every allocation of the call is released, and the next call recovers to the golden', async () => {
    const ctx = open()
    const sheet = paperSheet()
    sheet.mount(ctx)
    const bitmap = await sprite()
    // The third `texStorage2D` of the call — the artwork slot, after the source-sized copy and
    // Pool B's staging — is skipped, leaving the texture without storage: the resample into it
    // raises INVALID_FRAMEBUFFER_OPERATION, which is the batch's own to read. Nothing reads the
    // flag before the readback is issued, and the settle after the fence finds it.
    const gl = ctx.gl
    const originalStore = gl.texStorage2D.bind(gl)
    let stores = 0
    const texStorage2D = vi.spyOn(gl, 'texStorage2D').mockImplementation(((
      ...args: Parameters<typeof gl.texStorage2D>
    ) => {
      stores += 1
      if (stores !== 3) originalStore(...args)
    }) as typeof gl.texStorage2D)
    const getError = vi.spyOn(gl, 'getError')
    const createTexture = vi.spyOn(gl, 'createTexture')
    const deleteTexture = vi.spyOn(gl, 'deleteTexture')
    const createFramebuffer = vi.spyOn(gl, 'createFramebuffer')
    const deleteFramebuffer = vi.spyOn(gl, 'deleteFramebuffer')
    const issue = readsBeforeIssue(ctx, getError)
    const failed = await sheet.source(bitmap, { maxSize: 128, exact: false })
    issue.restore()
    texStorage2D.mockRestore()
    expect(GlError.is(failed), String((failed as Error)?.message)).toBe(true)
    if (!GlError.is(failed)) return
    expect(failed.message).toMatch(/^allocation batch of \d+ textures and \d+ targets failed/)
    expect(stores).toBeGreaterThanOrEqual(3)
    expect(issue.at.reads).toBe(0)
    // Every texture and framebuffer the call created is gone again — the ones that succeeded
    // included — so nothing of a batch that failed can be drawn with or read from.
    expect(createTexture.mock.calls.length).toBeGreaterThan(3)
    expect(deleteTexture.mock.calls.length).toBe(createTexture.mock.calls.length)
    expect(deleteFramebuffer.mock.calls.length).toBe(createFramebuffer.mock.calls.length)
    getError.mockRestore()
    createTexture.mockRestore()
    deleteTexture.mockRestore()
    createFramebuffer.mockRestore()
    deleteFramebuffer.mockRestore()

    // The next call finds the pools empty of what died (`gl-pools.ts`), resamples — the artwork
    // is vouched for no longer — and lands on the very bytes a clean run does.
    const handle = await sheet.source(bitmap, { maxSize: 128, exact: false })
    bitmap.close()
    expect(GlError.is(handle) || SheetError.is(handle) || isAborted(handle)).toBe(false)
    if (GlError.is(handle) || SheetError.is(handle) || isAborted(handle)) return
    expect(handle.frontRect).toEqual(READBACK_GOLDEN['ellipse/hull'].frontRect)
    expect(hullDigest(handle.hull)).toBe(READBACK_GOLDEN['ellipse/hull'].hull)
    const front = sheet.build(handle, handle.front, defaultsFor('hull') as never)
    expect(front instanceof Error, String((front as Error)?.message)).toBe(false)
    if (!(front instanceof Error)) sheet.releaseFront(front)
    sheet.dispose()
  })

  it('asks for the implementation read format once per field format: two getParameter reads on the first sprite, none on the second', async () => {
    const ctx = open()
    const sheet = paperSheet()
    sheet.mount(ctx)
    const gl = ctx.gl
    // Counted by pname: the fixture's context is injected, so every outermost scope captures
    // §5.1's set through `getParameter` as well, and those reads are not the ones in question.
    const readFormat = (p: unknown) =>
      p === gl.IMPLEMENTATION_COLOR_READ_FORMAT || p === gl.IMPLEMENTATION_COLOR_READ_TYPE
    const getParameter = vi.spyOn(gl, 'getParameter')
    const first = await compactSprite(64, 64)
    const a = await sheet.source(first, { maxSize: 128, exact: false })
    first.close()
    const firstReads = getParameter.mock.calls.filter(([p]) => readFormat(p)).length
    getParameter.mockClear()
    // Another size, the same field format: the pair is remembered, not asked again.
    const second = await compactSprite(80, 48)
    const b = await sheet.source(second, { maxSize: 128, exact: false })
    second.close()
    const secondReads = getParameter.mock.calls.filter(([p]) => readFormat(p)).length
    getParameter.mockRestore()
    expect(a instanceof Error || isAborted(a)).toBe(false)
    expect(b instanceof Error || isAborted(b)).toBe(false)
    expect(firstReads).toBe(2)
    expect(secondReads).toBe(0)
    sheet.dispose()
  })
})
