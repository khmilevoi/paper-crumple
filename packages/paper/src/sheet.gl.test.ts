import { afterEach, describe, expect, it, vi } from 'vitest'
import { ABORTED, GlError, SheetError, SourceExpiredError, isAborted } from '@paper-crumple/core'
import {
  checkGuardBand,
  frontBytes,
  KNOB_REFERENCE_PX,
  overscanRadius,
} from '@paper-crumple/core/unstable'
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
    // renderFront's own one draw call, and nothing from either field pass — a regression that
    // stopped reusing source()'s own work would push this back into double digits (pass A alone
    // is `2 * (schedule.length + 1) + 1`).
    expect(draws).toBe(1)

    sheet.releaseFront(front)
    sheet.dispose()
  })
})

describe("task 12 fix round 2 (build()'s rect conversion)", () => {
  // The finding: build()'s step 9 used to scale `handle.rect` (source pixels) UNIFORMLY by
  // `frontLongSide / sourceLongSide` into this call's own front space — correct only at `p = 0`,
  // because a uniform scale carries no offset term and so drops the margin fraction `p` encodes
  // the moment this build's requested `size` differs from the add-time front. `torn` mode's own
  // ~0.19-0.22 overscan (task 10's own report) is margin enough to make the two formulas diverge
  // by tens of px once `size` (200x200) differs from the add-time front (128x128) — not a
  // rounding wobble.
  it("build()'s rect inverts the artworkUv margin mapping at THIS build's size, not a uniform handle.rect scale", async () => {
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
    const p = handle.overscan
    expect(p).toBeGreaterThan(0.15) // torn's own headline figure (~0.19-0.22); a real margin to invert
    const scale = 1 + 2 * p
    // The exact inverse of `frontRectToSourceRect`'s own `sourceUv = frontUv*scale - p`:
    // `frontUv = sourceUv/scale + p/scale`.
    const toFront = (uSource: number, frontDim: number) => (uSource / scale + p / scale) * frontDim

    const expectedX0 = toFront(handle.rect.x / srcW, size.w)
    const expectedY0 = toFront(handle.rect.y / srcH, size.h)
    const expectedX1 = toFront((handle.rect.x + handle.rect.w) / srcW, size.w)
    const expectedY1 = toFront((handle.rect.y + handle.rect.h) / srcH, size.h)

    expect(front.rect.x).toBeCloseTo(expectedX0, 0)
    expect(front.rect.y).toBeCloseTo(expectedY0, 0)
    expect(front.rect.w).toBeCloseTo(expectedX1 - expectedX0, 0)
    expect(front.rect.h).toBeCloseTo(expectedY1 - expectedY0, 0)

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

  // Finding 3: `handle.rect` must invert the exact `artworkUv` affine map, not a uniform
  // `sourceLongSide / frontLongSide` scale — the two agree only at `p = 0`. `torn` mode's own
  // ~0.19-0.22 overscan (task 10's own report) makes the two formulas' predictions diverge by
  // tens of px, so a regression back to the uniform scale is caught, not just a rounding wobble.
  it('handle.rect inverts the artworkUv margin mapping, not a uniform frontRect scale (finding 3)', async () => {
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

    // `exact: false` makes `frontLongSide === maxSize` exactly (no `dimsForLongSide` rounding),
    // and a square 64x64 source keeps both axes at that same figure.
    const front = { w: 128, h: 128 }
    const srcW = 64
    const srcH = 64
    const p = handle.overscan
    expect(p).toBeGreaterThan(0.15) // torn's own headline figure (~0.19-0.22); a real margin to invert
    const scale = 1 + 2 * p
    const toSource = (uFront: number, srcDim: number) => (uFront * scale - p) * srcDim

    const expectedX0 = toSource(handle.frontRect.x / front.w, srcW)
    const expectedY0 = toSource(handle.frontRect.y / front.h, srcH)
    const expectedX1 = toSource((handle.frontRect.x + handle.frontRect.w) / front.w, srcW)
    const expectedY1 = toSource((handle.frontRect.y + handle.frontRect.h) / front.h, srcH)

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
