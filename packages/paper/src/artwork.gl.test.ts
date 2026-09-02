import { afterEach, describe, expect, it } from 'vitest'
import { GlError } from '@paper-crumple/core'
import { createScratchPools, identityResample, poolABytes } from '@paper-crumple/core/unstable'
import type { ScratchPools } from '@paper-crumple/core/unstable'
import { createGlFixture, type PaperGlFixture } from './testing/gl-fixture.js'
import { createResampler } from './artwork.js'

let fixture: PaperGlFixture | null = null
let pools: ScratchPools | null = null

afterEach(() => {
  pools?.dispose()
  pools = null
  // §4.0 caps live WebGL2 contexts at roughly sixteen and Vitest opens one page per file.
  fixture?.dispose()
  fixture = null
})

const SRC = { w: 24, h: 16 }

/**
 * A deterministic non-trivial source: a gradient with a hard alpha edge.
 *
 * Typed as `Uint8ClampedArray<ArrayBuffer>`, not the bare (TS 5.7+ default) `Uint8ClampedArray`:
 * `new Uint8ClampedArray(n)` always backs onto a fresh, non-shared `ArrayBuffer`, so this is the
 * accurate generic parameter, not a widening — `ImageData`'s constructor below requires exactly
 * this (its `ImageDataArray` excludes `SharedArrayBuffer`-backed views).
 */
function sourceBytes(): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(SRC.w * SRC.h * 4)
  for (let y = 0; y < SRC.h; y++) {
    for (let x = 0; x < SRC.w; x++) {
      const p = (y * SRC.w + x) * 4
      out[p] = (x * 11) % 256
      out[p + 1] = (y * 17) % 256
      out[p + 2] = (x * y * 3) % 256
      out[p + 3] = x < 4 || x > 19 ? 0 : 255
    }
  }
  return out
}

/**
 * Built from `ImageData` directly rather than through an intermediate `OffscreenCanvas` +
 * `putImageData` round trip (the brief's literal form): Chromium's 2D canvas stores its bitmap
 * premultiplied internally, so a `putImageData`/`createImageBitmap(canvas, …)` round trip loses
 * every alpha-0 pixel's RGB before this module ever sees it — verified in isolation against a
 * plain `RGBA8` upload with no resample pipeline involved. `createImageBitmap(ImageData, …)`
 * with `premultiplyAlpha: 'none'` has no such intermediate and round-trips exactly, which is what
 * "on every channel including RGB under zero alpha" actually needs to test.
 */
async function sourceBitmap(): Promise<ImageBitmap> {
  return createImageBitmap(new ImageData(sourceBytes(), SRC.w, SRC.h), {
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none',
  })
}

/**
 * `uploadViaCanvas` (the §8.5.3 fallback) round-trips the bitmap through an `OffscreenCanvas` 2D
 * context (`drawImage` + `getImageData`), which — independent of driver, a property of the 2D
 * canvas's internally premultiplied storage — deterministically zeroes RGB wherever alpha is 0:
 * premultiplying by alpha 0 collapses every channel to 0, and un-premultiplying 0/0 back out
 * yields 0, not the original value. This is why `uploadViaByteFetch` is the normative path and
 * `uploadViaCanvas` exists only for a driver whose float conversion drifts (§8.5.3) — it was never
 * meant to promise byte-fidelity for a fully transparent texel's colour, only for its alpha and
 * for every opaque-enough texel's colour. Golden-adjusted for exactly that, and nothing else: full
 * buffer, byte-exact, no tolerance, except this one deterministic, driver-independent zeroing.
 */
function zeroRgbUnderZeroAlpha(bytes: Uint8Array | Uint8ClampedArray): number[] {
  const out = Array.from(bytes)
  for (let p = 0; p < out.length; p += 4) {
    if (out[p + 3] === 0) {
      out[p] = 0
      out[p + 1] = 0
      out[p + 2] = 0
    }
  }
  return out
}

function open(artwork: { w: number; h: number }) {
  fixture = createGlFixture(8, 8)
  expect(fixture.gl, 'no WebGL2 context — check the SwiftShader launch flags (§11)').not.toBeNull()
  pools = createScratchPools({ gl: fixture.ctx, artwork, sdfRes: 64 })
  return { ctx: fixture.ctx, pools: pools! }
}

/**
 * `DrawScope.bindTarget` binds `DRAW_FRAMEBUFFER` only; `readPixels` reads `READ_FRAMEBUFFER`,
 * which core's own resample fixture (`@paper-crumple/core`'s `testing/gl-resample.ts`) and this
 * package's `gl-sdf.gl.test.ts` both bind explicitly for the same reason. Without the explicit
 * bind here this would silently read the canvas backbuffer instead of the artwork slot.
 */
function readArtwork(
  ctx: PaperGlFixture['ctx'],
  texture: { readonly handle: WebGLTexture },
  w: number,
  h: number,
): Uint8Array {
  const target = ctx.target(texture as never)
  expect(GlError.is(target)).toBe(false)
  if (GlError.is(target)) return new Uint8Array(0)
  const out = new Uint8Array(w * h * 4)
  ctx.scope(() => {
    ctx.gl.bindFramebuffer(ctx.gl.READ_FRAMEBUFFER, target.framebuffer)
    ctx.gl.readPixels(0, 0, w, h, ctx.gl.RGBA_INTEGER, ctx.gl.UNSIGNED_BYTE, out)
  })
  target.dispose()
  return out
}

describe('the artwork slot', () => {
  it('is RGBA8UI at A and costs exactly frontBytes(A)', async () => {
    const artwork = { w: 12, h: 8 }
    const { ctx, pools: p } = open(artwork)
    const r = createResampler(ctx)
    expect(GlError.is(r)).toBe(false)
    if (GlError.is(r)) return
    const slot = r.resample({
      spriteKey: 'k',
      bitmap: await sourceBitmap(),
      srcRect: { x: 0, y: 0, w: SRC.w, h: SRC.h },
      artwork,
      poolA: p.poolA,
      poolB: p.poolB,
    })
    expect(GlError.is(slot)).toBe(false)
    if (GlError.is(slot)) return
    expect(slot.texture.format).toBe('RGBA8UI')
    expect(slot.texture.bytes).toBe(artwork.w * artwork.h * 4)
    expect(p.poolA.artworkKey()).toBe('k')
    expect(p.poolA.bytes()).toBeLessThanOrEqual(poolABytes(artwork, 64))
    r.dispose()
  })

  it('is the identity at ratio 1, on every channel including RGB under zero alpha', async () => {
    const artwork = { w: SRC.w, h: SRC.h }
    const { ctx, pools: p } = open(artwork)
    const r = createResampler(ctx)
    expect(GlError.is(r)).toBe(false)
    if (GlError.is(r)) return
    const slot = r.resample({
      spriteKey: 'k',
      bitmap: await sourceBitmap(),
      srcRect: { x: 0, y: 0, w: SRC.w, h: SRC.h },
      artwork,
      poolA: p.poolA,
      poolB: p.poolB,
    })
    expect(GlError.is(slot)).toBe(false)
    if (GlError.is(slot)) return
    expect(Array.from(readArtwork(ctx, slot.texture, SRC.w, SRC.h))).toEqual(
      Array.from(sourceBytes()),
    )
    r.dispose()
  })

  it("matches P5's identityResample byte for byte on a reduction", async () => {
    const artwork = { w: 9, h: 6 }
    const { ctx, pools: p } = open(artwork)
    const r = createResampler(ctx)
    expect(GlError.is(r)).toBe(false)
    if (GlError.is(r)) return
    const slot = r.resample({
      spriteKey: 'k',
      bitmap: await sourceBitmap(),
      srcRect: { x: 0, y: 0, w: SRC.w, h: SRC.h },
      artwork,
      poolA: p.poolA,
      poolB: p.poolB,
    })
    expect(GlError.is(slot)).toBe(false)
    if (GlError.is(slot)) return
    const reference = identityResample(
      { data: sourceBytes(), width: SRC.w, height: SRC.h },
      { x: 0, y: 0, w: SRC.w, h: SRC.h },
      artwork.w,
      artwork.h,
    )
    expect(reference instanceof Error).toBe(false)
    if (reference instanceof Error) return
    expect(Array.from(readArtwork(ctx, slot.texture, artwork.w, artwork.h))).toEqual(
      Array.from(reference),
    )
    r.dispose()
  })

  it(
    "matches P5's identityResample byte for byte through the canvas fallback " +
      '(§8.5.3, ctx.exactByteFetch=false)',
    async () => {
      const artwork = { w: 9, h: 6 }
      const { ctx, pools: p } = open(artwork)
      // `createGlContext` returns a plain object (`gl-context.ts`'s `CoreGlContext` return
      // literal), so a shallow override forces `uploadViaCanvas` without touching production
      // code or `ctx.exactByteFetch`'s single probe site. Every method this clone carries closes
      // over the same underlying `gl` as `ctx`, so behaviour is identical except for the one
      // overridden field.
      const fallbackCtx = { ...ctx, exactByteFetch: false }
      const r = createResampler(fallbackCtx)
      expect(GlError.is(r)).toBe(false)
      if (GlError.is(r)) return
      const slot = r.resample({
        spriteKey: 'k',
        bitmap: await sourceBitmap(),
        srcRect: { x: 0, y: 0, w: SRC.w, h: SRC.h },
        artwork,
        poolA: p.poolA,
        poolB: p.poolB,
      })
      expect(GlError.is(slot)).toBe(false)
      if (GlError.is(slot)) return
      const reference = identityResample(
        { data: sourceBytes(), width: SRC.w, height: SRC.h },
        { x: 0, y: 0, w: SRC.w, h: SRC.h },
        artwork.w,
        artwork.h,
      )
      expect(reference instanceof Error).toBe(false)
      if (reference instanceof Error) return
      expect(Array.from(readArtwork(ctx, slot.texture, artwork.w, artwork.h))).toEqual(
        zeroRgbUnderZeroAlpha(reference),
      )
      r.dispose()
    },
  )
})

describe('the ambient state a byte depends on (spec 7.4.1)', () => {
  it('leaves DITHER off, colourspace conversion NONE and flipY false', () => {
    const { ctx } = open({ w: 8, h: 8 })
    const { gl } = ctx
    expect(gl.isEnabled(gl.DITHER)).toBe(false)
    expect(gl.getParameter(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL)).toBe(gl.NONE)
    expect(gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL)).toBe(false)
    expect(gl.getParameter(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL)).toBe(false)
  })
})
