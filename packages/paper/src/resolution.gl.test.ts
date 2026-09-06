/**
 * # `artworkCssPx` end to end (§8.6 amendment, 2026-09-04)
 *
 * The unit-level tests (`handle.test.ts`'s `frontForArtwork`, `sheet.gl.test.ts`'s per-axis
 * reserve, `stage.test.ts`'s `derives the surface and the artwork request from artworkCssPx`)
 * each pin one link of the chain from `paperStage({ artworkCssPx })` to `view.frame.artwork`.
 * This file drives the real chain end to end, against a real `paperSheet()`: build a stage with
 * `artworkCssPx`, add a 2:3 and a 3:2 sprite, and assert both land at the same artwork resolution
 * — the swap-regression this whole change exists to fix.
 *
 * The motion slot is a stub: `@paper-crumple/motion` does not resolve from this package and this
 * seam has nothing to do with it (same rationale as `resupply-seam.gl.test.ts`).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { frontCapFor, isAborted, paperStage } from '@paper-crumple/core'
import type { DrawResult, KnobDescriptor, MotionSource, Rect } from '@paper-crumple/core'
import type { MotionClip, MotionFit } from '@paper-crumple/core/unstable'
import type { EdgeSpec } from '@paper-crumple/core/unstable'
import { optionsFor, paperSheet } from './sheet.js'

/**
 * design 2026-09-05 §6's default cell. `EdgeMode` is gone; `hull` was this cell by its descriptor
 * set (§2.4's 24 keys).
 */
const SMOOTH_CLEAN: EdgeSpec = { shape: 'smooth', finish: 'clean', widthUnit: 'px' }

const live: Array<{ dispose(): void }> = []
afterEach(() => {
  while (live.length > 0) live.pop()?.dispose()
})

/**
 * A `MotionSource` stub — copied, not imported, from `@paper-crumple/core`'s own
 * `testing/fake-slots.ts` `fakeMotion` shape (`testing/` is not a package export). `fit` reports
 * the front at the rect it is asked to fit, rounded up: enough for the stage's own bucket-size
 * bookkeeping without pulling in the real bucket table.
 */
function stubMotion(): MotionSource {
  return {
    knobs: [] as readonly KnobDescriptor[],
    mount: () => undefined,
    fit: (rect: Rect) =>
      ({
        frontSize: { w: Math.ceil(rect.w), h: Math.ceil(rect.h) },
        sortKey: 'x',
      }) as unknown as MotionFit,
    load: async () => ({ frameCount: 2, keyFrames: [0] }) as unknown as MotionClip,
    draw: () => ({}) as DrawResult,
    release: () => {},
    dispose: () => {},
  } as unknown as MotionSource
}

/** An opaque rectangle at the given aspect — enough silhouette for `source()` to trace a hull on. */
async function bitmapAt(w: number, h: number): Promise<ImageBitmap> {
  const canvas = new OffscreenCanvas(w, h)
  const c2d = canvas.getContext('2d')!
  c2d.clearRect(0, 0, w, h)
  c2d.fillStyle = '#3aa06a'
  c2d.fillRect(Math.round(w * 0.1), Math.round(h * 0.1), Math.round(w * 0.8), Math.round(h * 0.8))
  return createImageBitmap(canvas, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' })
}

describe('artworkCssPx, end to end', () => {
  it('gives every sprite at least ceil(artworkCssPx x dpr) artwork texels, whatever its aspect', async () => {
    const sheet = paperSheet({ ...optionsFor(SMOOTH_CLEAN), overscanHeadroom: 0.25 })
    const stage = await paperStage({
      sheet,
      motion: stubMotion(),
      artworkCssPx: 120,
      present: 'blit',
    })
    if (stage instanceof Error || isAborted(stage)) return expect.fail(String(stage))
    live.push(stage)

    // Headless Chromium under the gl project reports devicePixelRatio === 1, but the test reads
    // it rather than assuming: `env.dpr` was not overridden here, so the stage reads the real one.
    const dpr = globalThis.devicePixelRatio
    const expected = Math.ceil(120 * dpr)
    expect(stage.surface.width).toBe(
      frontCapFor({ artworkLongSide: expected, overscan: sheet.overscan, cap: 2048 }),
    )

    const portrait = await bitmapAt(64, 96)
    const landscape = await bitmapAt(96, 64)
    const a = await stage.add(portrait, { key: 'portrait', pin: true })
    const b = await stage.add(landscape, { key: 'landscape', pin: true })
    if (a instanceof Error || isAborted(a)) return expect.fail(String(a))
    if (b instanceof Error || isAborted(b)) return expect.fail(String(b))

    const view = stage.view({ canvas: document.createElement('canvas') })
    if (view instanceof Error) return expect.fail(String(view))

    expect(view.show(a)).toBeUndefined()
    expect(view.frame).not.toBeNull()
    expect(Math.max(view.frame!.artwork.w, view.frame!.artwork.h)).toBe(expected)

    expect(view.show(b)).toBeUndefined()
    expect(view.frame).not.toBeNull()
    expect(Math.max(view.frame!.artwork.w, view.frame!.artwork.h)).toBe(expected)
  })

  it('reaches the full artwork resolution even where the pre-fix frontCapFor under-sized the surface (A=159, hull overscan 84/832)', async () => {
    // `artworkCssPx: 120` above (dpr 1) lands on A = 120, which the OLD `frontCapFor` formula
    // (`Math.ceil(A * (1 + 2 * p))`, verbatim what shipped in 3b57589 before the per-axis fix in
    // eaddcfd) also sized correctly — it is not a regression fixture. At the hull default reserve
    // (`overscanHeadroom: 0`, p = 84/832 = 0.10096153846153846), A = 159 is one, checked by
    // running both formulas directly (not just asserted here):
    //   - OLD `frontCapFor({ artworkLongSide: 159, overscan: 84/832, cap: 2048 })` -> 192
    //     (`ceil(159 * 1.2019...) = 192`, already a multiple of 64).
    //   - NEW (this codebase) -> 256 (`159 + 2 * ceil(84/832 * 159) = 193`, rounds up to 256).
    //   - Feeding the OLD, too-small 192 into `frontForArtwork` (unchanged by this fix) for a
    //     1:1 source returns only 158 artwork texels, one short of the 159 requested — the OLD
    //     surface genuinely could not deliver what `artworkCssPx` asked for. The 256-texel
    //     surface this fixed code builds returns the full 159.
    const sheet = paperSheet({ ...optionsFor(SMOOTH_CLEAN), overscanHeadroom: 0 })
    const stage = await paperStage({
      sheet,
      motion: stubMotion(),
      artworkCssPx: 159,
      present: 'blit',
    })
    if (stage instanceof Error || isAborted(stage)) return expect.fail(String(stage))
    live.push(stage)

    const dpr = globalThis.devicePixelRatio
    const expected = Math.ceil(159 * dpr)
    expect(stage.surface.width).toBe(
      frontCapFor({ artworkLongSide: expected, overscan: sheet.overscan, cap: 2048 }),
    )

    const square = await bitmapAt(96, 96)
    const a = await stage.add(square, { key: 'square', pin: true })
    if (a instanceof Error || isAborted(a)) return expect.fail(String(a))

    const view = stage.view({ canvas: document.createElement('canvas') })
    if (view instanceof Error) return expect.fail(String(view))

    expect(view.show(a)).toBeUndefined()
    expect(view.frame).not.toBeNull()
    expect(Math.max(view.frame!.artwork.w, view.frame!.artwork.h)).toBe(expected)
  })
})
