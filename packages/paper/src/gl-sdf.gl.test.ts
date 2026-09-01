import { afterEach, describe, expect, it } from 'vitest'
import { GlError } from '@paper-crumple/core'
import { createScratchPools, drawTargetFor, poolABytes } from '@paper-crumple/core/unstable'
import type { ScratchPools } from '@paper-crumple/core/unstable'
import { createGlFixture, type PaperGlFixture } from './testing/gl-fixture.js'
import { createSdfBuilder } from './gl-sdf.js'

let fixture: PaperGlFixture | null = null
let pools: ScratchPools | null = null

afterEach(() => {
  pools?.dispose()
  pools = null
  // §4.0 caps live WebGL2 contexts at roughly sixteen and Vitest opens one page per file.
  fixture?.dispose()
  fixture = null
})

const ARTWORK = { w: 64, h: 64 }
const FIELD = 64

function open() {
  fixture = createGlFixture(8, 8)
  expect(fixture.gl, 'no WebGL2 context — check the SwiftShader launch flags (§11)').not.toBeNull()
  pools = createScratchPools({ gl: fixture.ctx, artwork: ARTWORK, sdfRes: FIELD })
  return { ctx: fixture.ctx, pools }
}

/** A centred opaque disc of radius `r`, as RGBA8UI bytes. Distances from it are known exactly. */
function disc(w: number, h: number, r: number): Uint8Array {
  const out = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inside = Math.hypot(x + 0.5 - w / 2, y + 0.5 - h / 2) <= r
      const p = (y * w + x) * 4
      out[p] = 255
      out[p + 1] = 255
      out[p + 2] = 255
      out[p + 3] = inside ? 255 : 0
    }
  }
  return out
}

/**
 * Reads back one texel of `field.target`.
 *
 * `DrawScope.bindTarget` binds `DRAW_FRAMEBUFFER` only; `readPixels` reads `READ_FRAMEBUFFER`,
 * which core's own resample fixture binds explicitly for the same reason
 * (`@paper-crumple/core`'s `testing/gl-resample.ts`) — this harness follows that pattern.
 */
function readDistance(
  ctx: PaperGlFixture['ctx'],
  target: { readonly framebuffer: WebGLFramebuffer },
  bits: 'R16F' | 'RGBA8',
  decode: readonly [number, number],
  x: number,
  y: number,
): number {
  const px = new Uint8Array(4)
  const fl = new Float32Array(4)
  ctx.scope(() => {
    ctx.gl.bindFramebuffer(ctx.gl.READ_FRAMEBUFFER, target.framebuffer)
    if (bits === 'R16F') ctx.gl.readPixels(x, y, 1, 1, ctx.gl.RGBA, ctx.gl.FLOAT, fl)
    else ctx.gl.readPixels(x, y, 1, 1, ctx.gl.RGBA, ctx.gl.UNSIGNED_BYTE, px)
  })
  const raw = bits === 'R16F' ? fl[0] : px[0] / 255
  return raw * decode[0] + decode[1]
}

describe('the field contract (sdf.js)', () => {
  it('reports R16F with an identity decode when floatRT is available', () => {
    const { ctx } = open()
    const builder = createSdfBuilder(ctx, pools!.poolA)
    expect(GlError.is(builder)).toBe(false)
    if (GlError.is(builder)) return
    if (ctx.caps.floatRT) {
      expect(builder.contract.bits).toBe('R16F')
      expect(builder.contract.decode).toEqual([1, 0])
      expect(builder.contract.rangePx).toBe(Infinity)
    } else {
      expect(builder.contract.bits).toBe('RGBA8')
      expect(builder.contract.rangePx).toBe(128)
      expect(builder.contract.decode[0]).toBeCloseTo((255 / 127) * 128, 6)
      expect(builder.contract.decode[1]).toBeCloseTo((-128 / 127) * 128, 6)
    }
    builder.dispose()
  })

  it('round-trips through encode and decode whichever contract is live', () => {
    const { ctx } = open()
    const builder = createSdfBuilder(ctx, pools!.poolA)
    expect(GlError.is(builder)).toBe(false)
    if (GlError.is(builder)) return
    const { encode, decode, rangePx } = builder.contract
    for (const d of [-40, -1, 0, 1, 40]) {
      // The byte contract stores a normalised RGBA8 component, clamped to [0, 1] by the texture
      // itself; the float contract stores the raw distance in an R16F texel, unclamped (`sdf.js`'s
      // RESOLVE_FS writes `d` straight through on that path). Only the byte path's round trip goes
      // through the clamp a real upload would apply.
      const raw = d * encode[0] + encode[1]
      const stored = rangePx === Infinity ? raw : Math.min(1, Math.max(0, raw))
      const back = stored * decode[0] + decode[1]
      expect(back).toBeCloseTo(d, rangePx === Infinity ? 5 : 0)
    }
    builder.dispose()
  })
})

describe('pass A on a known silhouette', () => {
  it('signs the field: positive inside the disc, negative outside', () => {
    const { ctx } = open()
    const builder = createSdfBuilder(ctx, pools!.poolA)
    expect(GlError.is(builder)).toBe(false)
    if (GlError.is(builder)) return

    const artwork = pools!.poolA.holdArtwork('sprite', {
      width: ARTWORK.w,
      height: ARTWORK.h,
      format: 'RGBA8UI',
      filter: 'NEAREST',
      label: 'artwork:sprite',
    })
    expect(GlError.is(artwork)).toBe(false)
    if (GlError.is(artwork)) return
    ctx.scope(() => {
      const { gl } = ctx
      gl.bindTexture(gl.TEXTURE_2D, artwork.handle)
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        ARTWORK.w,
        ARTWORK.h,
        gl.RGBA_INTEGER,
        gl.UNSIGNED_BYTE,
        disc(ARTWORK.w, ARTWORK.h, 20),
      )
    })

    const field = builder.buildField({
      artwork,
      // Identity mapping: the field covers the artwork exactly, so overscan is 0 here.
      artworkUv: [1, 1, 0, 0],
      width: FIELD,
      height: FIELD,
      sourceLongSide: ARTWORK.w,
    })
    expect(GlError.is(field)).toBe(false)
    if (GlError.is(field)) return

    const read = (x: number, y: number): number =>
      readDistance(ctx, drawTargetFor(field.target), builder.contract.bits, field.decode, x, y)

    expect(read(32, 32)).toBeGreaterThan(15)
    expect(read(1, 1)).toBeLessThan(-10)
    builder.dispose()
  })

  it('runs the classic schedule plus one unit pass', () => {
    const { ctx } = open()
    const builder = createSdfBuilder(ctx, pools!.poolA)
    expect(GlError.is(builder)).toBe(false)
    if (GlError.is(builder)) return
    const artwork = pools!.poolA.holdArtwork('sprite', {
      width: ARTWORK.w,
      height: ARTWORK.h,
      format: 'RGBA8UI',
      filter: 'NEAREST',
      label: 'a',
    })
    expect(GlError.is(artwork)).toBe(false)
    if (GlError.is(artwork)) return
    const field = builder.buildField({
      artwork,
      artworkUv: [1, 1, 0, 0],
      width: 64,
      height: 64,
      sourceLongSide: 64,
    })
    expect(GlError.is(field)).toBe(false)
    if (GlError.is(field)) return
    // ceil(log2(64)) = 6 levels, + 1 unit pass = 7 steps, twice (two halves), + 2 seeds + 1 resolve.
    expect(field.passes).toBe(2 * (7 + 1) + 1)
    builder.dispose()
  })
})

describe('the seed pass applies the overscan margin as a uv offset (spec 8.5)', () => {
  it('reads an unpadded artwork into a larger field without a padded upload', () => {
    const { ctx } = open()
    const builder = createSdfBuilder(ctx, pools!.poolA)
    expect(GlError.is(builder)).toBe(false)
    if (GlError.is(builder)) return
    const artwork = pools!.poolA.holdArtwork('sprite', {
      width: ARTWORK.w,
      height: ARTWORK.h,
      format: 'RGBA8UI',
      filter: 'NEAREST',
      label: 'a',
    })
    expect(GlError.is(artwork)).toBe(false)
    if (GlError.is(artwork)) return
    ctx.scope(() => {
      const { gl } = ctx
      gl.bindTexture(gl.TEXTURE_2D, artwork.handle)
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        ARTWORK.w,
        ARTWORK.h,
        gl.RGBA_INTEGER,
        gl.UNSIGNED_BYTE,
        disc(ARTWORK.w, ARTWORK.h, 30),
      )
    })
    // p = 0.25: the artwork occupies the middle 1/(1+2p) = 2/3 of the field on each axis.
    const p = 0.25
    const scale = 1 + 2 * p
    const field = builder.buildField({
      artwork,
      artworkUv: [scale, scale, -p * scale, -p * scale],
      width: FIELD,
      height: FIELD,
      sourceLongSide: ARTWORK.w * scale,
    })
    expect(GlError.is(field)).toBe(false)
    if (GlError.is(field)) return
    // A corner texel maps outside the artwork, so it must read as outside the silhouette.
    const d = readDistance(
      ctx,
      drawTargetFor(field.target),
      builder.contract.bits,
      field.decode,
      0,
      0,
    )
    expect(d).toBeLessThan(0)
    builder.dispose()
  })
})

describe('Pool A holds every scratch target this module spends', () => {
  it('never exceeds poolABytes', () => {
    const { ctx } = open()
    const builder = createSdfBuilder(ctx, pools!.poolA)
    expect(GlError.is(builder)).toBe(false)
    if (GlError.is(builder)) return
    const artwork = pools!.poolA.holdArtwork('sprite', {
      width: ARTWORK.w,
      height: ARTWORK.h,
      format: 'RGBA8UI',
      filter: 'NEAREST',
      label: 'a',
    })
    expect(GlError.is(artwork)).toBe(false)
    if (GlError.is(artwork)) return
    const field = builder.buildField({
      artwork,
      artworkUv: [1, 1, 0, 0],
      width: FIELD,
      height: FIELD,
      sourceLongSide: 64,
    })
    expect(GlError.is(field)).toBe(false)
    if (GlError.is(field)) return
    expect(pools!.poolA.bytes()).toBeLessThanOrEqual(poolABytes(ARTWORK, FIELD))
    builder.dispose()
  })
})
