import { afterEach, describe, expect, it, vi } from 'vitest'
import { GlError } from '@paper-crumple/core'
import { createScratchPools, drawTargetFor, poolABytes } from '@paper-crumple/core/unstable'
import type { ScratchPools } from '@paper-crumple/core/unstable'
import { createGlFixture, type PaperGlFixture } from './testing/gl-fixture.js'
import { createSdfBuilder, looseSizeFor, sigmaFor } from './gl-sdf.js'

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

  it('reuses one WebGLFramebuffer per pool slot across repeated builds and blurs', () => {
    // `pool.acquire` already reuses the pooled Texture across calls; the bug this covers is that
    // `ctx.target()` used to be called fresh on every acquire, allocating a brand-new
    // WebGLFramebuffer each time even though the Texture underneath never changed — a leak on
    // every `buildField`/`blurField`, i.e. on every slider move (§source rebuilds on every move).
    // This counts actual `gl.createFramebuffer()` calls, the real observable behind the leak, not
    // just output pixels: a build that reused textures but still leaked framebuffers would still
    // pass a pixel-only test.
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

    const createFramebuffer = vi.spyOn(ctx.gl, 'createFramebuffer')

    const buildOnce = () =>
      builder.buildField({
        artwork,
        artworkUv: [1, 1, 0, 0],
        width: FIELD,
        height: FIELD,
        sourceLongSide: ARTWORK.w,
      })

    const first = buildOnce()
    expect(GlError.is(first)).toBe(false)
    if (GlError.is(first)) return
    const firstLoose = builder.blurField({ field: first, sigmaPx: 4, frontLongSide: ARTWORK.w })
    expect(GlError.is(firstLoose)).toBe(false)

    // One framebuffer per distinct pool slot this round touched (the two ping-pong pairs, the
    // resolved tight field, and pass B's loose/scratch pair) — never zero, or this assertion
    // would be vacuous.
    const afterFirstRound = createFramebuffer.mock.calls.length
    expect(afterFirstRound).toBeGreaterThan(0)

    for (let i = 0; i < 5; i++) {
      const field = buildOnce()
      expect(GlError.is(field)).toBe(false)
      if (GlError.is(field)) return
      const loose = builder.blurField({ field, sigmaPx: 4, frontLongSide: ARTWORK.w })
      expect(GlError.is(loose)).toBe(false)
    }

    // Five more build+blur rounds against the same sizes must not create a single additional
    // WebGLFramebuffer: every pool slot's target is cached and reused, not rebuilt.
    expect(createFramebuffer.mock.calls.length).toBe(afterFirstRound)

    createFramebuffer.mockRestore()
    builder.dispose()
  })
})

describe('pass B, the looseness blur', () => {
  it('stores the loose field at 1/4 of the tight field on each axis', () => {
    expect(looseSizeFor({ w: 192, h: 192 })).toEqual({ w: 48, h: 48 })
    expect(looseSizeFor({ w: 5, h: 5 })).toEqual({ w: 2, h: 2 })
  })

  it('scales sigma with the sprite, so the knob reads the same on a shoe and an avatar', () => {
    expect(sigmaFor(0, 384)).toBe(0)
    expect(sigmaFor(1, 384)).toBeCloseTo(0.2 * 384, 6)
    expect(sigmaFor(0.5, 384)).toBeCloseTo(0.5 ** 1.6 * 0.2 * 384, 6)
  })

  it('pulls the zero level set outward across a concavity, which is the whole trick', () => {
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
    // Two legs with a deep notch between them: the loose field must bridge the notch.
    const bytes = new Uint8Array(ARTWORK.w * ARTWORK.h * 4)
    for (let y = 0; y < ARTWORK.h; y++) {
      for (let x = 0; x < ARTWORK.w; x++) {
        const leg = (x > 8 && x < 24) || (x > 40 && x < 56)
        const p = (y * ARTWORK.w + x) * 4
        bytes[p] = bytes[p + 1] = bytes[p + 2] = 255
        bytes[p + 3] = leg && y > 8 ? 255 : 0
      }
    }
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
        bytes,
      )
    })
    const tight = builder.buildField({
      artwork,
      artworkUv: [1, 1, 0, 0],
      width: FIELD,
      height: FIELD,
      sourceLongSide: ARTWORK.w,
    })
    expect(GlError.is(tight)).toBe(false)
    if (GlError.is(tight)) return
    const loose = builder.blurField({
      field: tight,
      sigmaPx: sigmaFor(0.5, ARTWORK.w),
      frontLongSide: ARTWORK.w,
    })
    expect(GlError.is(loose)).toBe(false)
    if (GlError.is(loose)) return
    expect(loose.width).toBe(FIELD / 4)
    expect(loose.taps).toBe(loose.radius * 2 + 1)
    expect(loose.sigmaPx).toBeCloseTo(sigmaFor(0.5, ARTWORK.w), 6)

    // Sample inside the notch, at its widest point (x ~= 32, equidistant from both legs). The
    // tight field reads a clearly negative (outside) distance there; the loose field, blurred
    // across the notch, must read a distance closer to (or past) the zero level set than the
    // tight field did — that pull-outward is the entire reason pass B exists.
    const tightD = readDistance(
      ctx,
      drawTargetFor(tight.target),
      builder.contract.bits,
      tight.decode,
      32,
      32,
    )
    const looseD = readDistance(
      ctx,
      drawTargetFor(loose.target),
      builder.contract.bits,
      loose.decode,
      Math.floor(32 / 4),
      Math.floor(32 / 4),
    )
    expect(tightD).toBeLessThan(-3)
    expect(looseD).toBeGreaterThan(tightD + 1)
    builder.dispose()
  })

  it('re-runs alone: a second blur reuses the tight field and touches no seed pass', () => {
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
    const tight = builder.buildField({
      artwork,
      artworkUv: [1, 1, 0, 0],
      width: FIELD,
      height: FIELD,
      sourceLongSide: ARTWORK.w,
    })
    expect(GlError.is(tight)).toBe(false)
    if (GlError.is(tight)) return
    const a = builder.blurField({ field: tight, sigmaPx: 4, frontLongSide: ARTWORK.w })
    const b = builder.blurField({ field: tight, sigmaPx: 16, frontLongSide: ARTWORK.w })
    expect(GlError.is(a)).toBe(false)
    expect(GlError.is(b)).toBe(false)
    if (GlError.is(a) || GlError.is(b)) return
    expect(b.target).toBe(a.target)
    expect(b.sigmaPx).not.toBe(a.sigmaPx)
    builder.dispose()
  })
})
