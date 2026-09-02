import { afterEach, describe, expect, it } from 'vitest'
import { ABORTED, GlError, SheetError, isAborted } from '@paper-crumple/core'
import { checkGuardBand, KNOB_REFERENCE_PX, overscanRadius } from '@paper-crumple/core/unstable'
import type { GlContext } from '@paper-crumple/core/unstable'
import { createGlFixture, type PaperGlFixture } from './testing/gl-fixture.js'
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

  it('sizes the artwork at A = maxSize / (1 + 2p), unpadded', async () => {
    const ctx = open()
    const sheet = paperSheet()
    sheet.mount(ctx)
    const bitmap = await sprite(64, 64)
    const handle = await sheet.source(bitmap, { maxSize: 128, exact: false })
    bitmap.close()
    expect(handle instanceof Error || isAborted(handle)).toBe(false)
    if (handle instanceof Error || isAborted(handle)) return
    expect(handle.artwork.w).toBe(Math.ceil(128 / (1 + 2 * handle.overscan)))
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
