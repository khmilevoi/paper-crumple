import { afterEach, describe, expect, it, vi } from 'vitest'
import { GlError } from '@paper-crumple/core'
import type { DrawTarget } from '@paper-crumple/core'
import {
  createScratchPools,
  drawTargetFor,
  FULLSCREEN_VS,
  poolABytes,
  uploadBytes,
} from '@paper-crumple/core/unstable'
import type { GlContext, ScratchPools, Target, Texture } from '@paper-crumple/core/unstable'
import { createGlFixture, type PaperGlFixture } from './testing/gl-fixture.js'
import { silhouetteBytes } from './testing/silhouette.js'
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
  target: DrawTarget,
  bits: 'R16F' | 'RGBA8',
  decode: readonly [number, number],
  x: number,
  y: number,
): number {
  // `DrawTarget.framebuffer` is `null` only for the stage's own output (core's own doc comment on
  // the interface) — every call site below passes `drawTargetFor()` of an offscreen Pool A/B
  // `Target`, which always wraps a real framebuffer, so `null` here would be a genuine test bug,
  // not a case this helper is meant to carry silently.
  expect(target.framebuffer, 'readDistance: target has no framebuffer').not.toBeNull()
  if (target.framebuffer === null) return NaN
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
      artworkUv: [scale, scale, -p, -p],
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

  it('centres that sub-rectangle — equal margins on both sides', () => {
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
    // Full-bleed and fully opaque, so the silhouette's own edges ARE the artwork's edges: the run
    // of inside texels measured below is exactly the sub-rectangle the seed pass placed, with no
    // shape of its own in between to confuse the two.
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
        new Uint8Array(ARTWORK.w * ARTWORK.h * 4).fill(255),
      )
    })
    const p = 0.25
    const scale = 1 + 2 * p
    const field = builder.buildField({
      artwork,
      artworkUv: [scale, scale, -p, -p],
      width: FIELD,
      height: FIELD,
      sourceLongSide: ARTWORK.w * scale,
    })
    expect(GlError.is(field)).toBe(false)
    if (GlError.is(field)) return

    const inside: number[] = []
    for (let x = 0; x < FIELD; x++) {
      const d = readDistance(
        ctx,
        drawTargetFor(field.target),
        builder.contract.bits,
        field.decode,
        x,
        FIELD / 2,
      )
      if (d >= 0) inside.push(x)
    }
    const first = inside.at(0)
    const last = inside.at(-1)
    expect(first).toBeDefined()
    expect(last).toBeDefined()
    if (first === undefined || last === undefined) return

    // `p` is a fraction of the ARTWORK (`p = r / (1000 - 2r)`, `front = artwork * (1+2p)`), so the
    // margin is `p * artwork` — `p/(1+2p)` of the field, 10.67 texels here — on BOTH sides. An
    // offset of `-p * scale` rather than `-p` leaves 16 texels on the left and 5 on the right:
    // the total margin is still right, its distribution is not, and the starved side is what put
    // the grown sheet rect on the front's edge and made `checkGuardBand` unpassable for any
    // tightly-cropped source at any knob value.
    const leftMargin = first
    const rightMargin = FIELD - 1 - last
    expect(Math.abs(leftMargin - rightMargin)).toBeLessThanOrEqual(1)
    expect(Math.abs(leftMargin - (p / scale) * FIELD)).toBeLessThanOrEqual(1)
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

// -----------------------------------------------------------------------------------------------
// The texel-selection oracle.
//
// `STEP_FS` and `RESOLVE_FS` read their NEAREST coord targets with `texelFetch(sampler, ivec2, 0)`
// where they used to read `texture(sampler, p / uSize)`; the taps land on texel centres, so the
// two select the same texel by construction — and "by construction" is proven here rather than
// argued: the oracle below is pass A exactly as it shipped before the switch (`gl-sdf.ts` at
// 5f61a46: `COORD_HEADER`, `SEED_FS`, `STEP_FS`, `RESOLVE_FS` and `scheduleFor`), copied rather
// than imported so the comparison has an independent reference — the production builder measured
// against its own current self would prove nothing. The oracle runs on dedicated, exact-size
// targets, which also makes it the reference for the ping-pong sub-viewport (`gl-sdf.ts`'s
// `pingPong`): the production build's coord textures may be larger than the field, the oracle's
// never are, and the resolved fields must still agree to the byte.
//
// Byte mode (`RGBA8` coords and field, no float render target) is carried in the copy, but
// SwiftShader has float render targets, so only the `RG16F` / `R16F` path runs in this suite.
// -----------------------------------------------------------------------------------------------

const ORACLE_COORD_HEADER = (byteMode: boolean): string => `#version 300 es
precision highp float;
${byteMode ? '#define BYTE_COORDS 1' : ''}

#ifdef BYTE_COORDS
vec4 encodeCoord(vec2 c) {
  if (c.x < 0.0) return vec4(1.0);
  vec2 hi = floor(c / 256.0);
  vec2 lo = c - hi * 256.0;
  return vec4(hi.x, lo.x, hi.y, lo.y) / 255.0;
}
vec2 decodeCoord(vec4 t) {
  vec4 v = floor(t * 255.0 + 0.5);
  vec2 c = vec2(v.x * 256.0 + v.y, v.z * 256.0 + v.w);
  return (c.x > 65000.0) ? vec2(-1.0) : c;
}
#else
vec4 encodeCoord(vec2 c) { return vec4(c, 0.0, 1.0); }
vec2 decodeCoord(vec4 t) { return t.xy; }
#endif
`

const ORACLE_SEED_FS = (byteMode: boolean): string => `${ORACLE_COORD_HEADER(byteMode)}
uniform highp usampler2D uSrc;
uniform vec2 uSize;
uniform int uSeedInside;
uniform vec4 uArtworkUv;
out vec4 outColor;
void main() {
  vec2 uv = gl_FragCoord.xy / uSize;
  vec2 artworkUv = uv * uArtworkUv.xy + uArtworkUv.zw;
  bool inRange = artworkUv.x >= 0.0 && artworkUv.x <= 1.0 && artworkUv.y >= 0.0 && artworkUv.y <= 1.0;
  ivec2 srcSize = textureSize(uSrc, 0);
  ivec2 p = clamp(ivec2(floor(artworkUv * vec2(srcSize))), ivec2(0), srcSize - ivec2(1));
  bool inside = inRange && (texelFetch(uSrc, p, 0).a >= 128u);
  bool seed = (uSeedInside == 1) ? inside : !inside;
  outColor = encodeCoord(seed ? gl_FragCoord.xy : vec2(-1.0));
}`

const ORACLE_STEP_FS = (byteMode: boolean): string => `${ORACLE_COORD_HEADER(byteMode)}
uniform sampler2D uPrev;
uniform vec2 uSize;
uniform float uStep;
out vec4 outColor;
void main() {
  vec2 fc = gl_FragCoord.xy;
  vec2 best = decodeCoord(texture(uPrev, fc / uSize));
  float bestD = (best.x < 0.0) ? 1e20 : dot(best - fc, best - fc);
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      if (x == 0 && y == 0) continue;
      vec2 p = fc + vec2(float(x), float(y)) * uStep;
      if (p.x < 0.0 || p.y < 0.0 || p.x >= uSize.x || p.y >= uSize.y) continue;
      vec2 c = decodeCoord(texture(uPrev, p / uSize));
      if (c.x < 0.0) continue;
      float d = dot(c - fc, c - fc);
      if (d < bestD) { bestD = d; best = c; }
    }
  }
  outColor = encodeCoord(best);
}`

const ORACLE_RESOLVE_FS = (
  byteMode: boolean,
  byteOut: boolean,
): string => `${ORACLE_COORD_HEADER(byteMode)}
uniform sampler2D uInsideSeeds;
uniform sampler2D uOutsideSeeds;
uniform float uPxScale;
uniform vec2 uEncode;
out vec4 outColor;
void main() {
  vec2 fc = gl_FragCoord.xy;
  vec2 uv = fc / vec2(textureSize(uInsideSeeds, 0));
  vec2 pi = decodeCoord(texture(uInsideSeeds, uv));
  vec2 po = decodeCoord(texture(uOutsideSeeds, uv));
  float dOut = (pi.x < 0.0) ? 1e4 : length(pi - fc);
  float dIn  = (po.x < 0.0) ? 1e4 : length(po - fc);
  float d = (dIn - dOut) * uPxScale;
  ${byteOut ? 'outColor = vec4(clamp(d * uEncode.x + uEncode.y, 0.0, 1.0));' : 'outColor = vec4(d, 0.0, 0.0, 1.0);'}
}`

/** `scheduleFor`, verbatim: `N/2, N/4 ... 1` plus one extra unit pass. */
function oracleSchedule(w: number, h: number): number[] {
  const levels = Math.ceil(Math.log2(Math.max(w, h)))
  const schedule: number[] = []
  for (let k = levels - 1; k >= 0; k--) schedule.push(2 ** k)
  schedule.push(1)
  return schedule
}

/**
 * The raw stored value of every texel of a resolved field, row-major — channel 0 of an
 * `RGBA/FLOAT` read on a float target (a half's float expansion is exact, so this IS the byte
 * content), the raw byte on an `RGBA8` one. No decode: identity is asserted on what is stored.
 */
function readRawField(ctx: GlContext, target: Target, byteMode: boolean): Float32Array {
  const { gl } = ctx
  const w = target.width
  const h = target.height
  const out = new Float32Array(w * h)
  ctx.scope(() => {
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, target.framebuffer)
    if (byteMode) {
      const px = new Uint8Array(w * h * 4)
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px)
      for (let i = 0; i < out.length; i++) out[i] = px[i * 4]!
    } else {
      const fl = new Float32Array(w * h * 4)
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, fl)
      for (let i = 0; i < out.length; i++) out[i] = fl[i * 4]!
    }
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null)
  })
  return out
}

/** The index of the first texel where `a` and `b` differ, or -1. `Object.is`, so NaN is caught. */
function firstMismatch(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return Math.min(a.length, b.length)
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return i
  return -1
}

/** Pass A the pre-`texelFetch` way, on dedicated exact-size targets: the raw resolved field. */
function oraclePassA(
  ctx: GlContext,
  artwork: Texture,
  artworkUv: readonly [number, number, number, number],
  w: number,
  h: number,
  sourceLongSide: number,
): Error | Float32Array {
  const byteMode = !ctx.caps.floatRT
  const seed = ctx.program(FULLSCREEN_VS, ORACLE_SEED_FS(byteMode), 'oracle.seed')
  if (GlError.is(seed)) return seed
  const step = ctx.program(FULLSCREEN_VS, ORACLE_STEP_FS(byteMode), 'oracle.step')
  if (GlError.is(step)) return step
  const resolve = ctx.program(
    FULLSCREEN_VS,
    ORACLE_RESOLVE_FS(byteMode, byteMode),
    'oracle.resolve',
  )
  if (GlError.is(resolve)) return resolve
  const owned: Target[] = []
  const dedicated = (format: 'RG16F' | 'RGBA8' | 'R16F', filter: 'NEAREST' | 'LINEAR') => {
    const texture = ctx.texture({ width: w, height: h, format, filter, label: 'oracle' })
    if (GlError.is(texture)) return texture
    const target = ctx.target(texture)
    if (GlError.is(target)) {
      texture.dispose()
      return target
    }
    owned.push(target)
    return target
  }
  const release = () => {
    for (const t of owned) {
      t.dispose()
      t.texture.dispose()
    }
    seed.dispose()
    step.dispose()
    resolve.dispose()
  }

  const encode: readonly [number, number] = byteMode ? [127 / 255 / 128, 128 / 255] : [1, 0]
  const pxScale = sourceLongSide / Math.max(w, h)
  const schedule = oracleSchedule(w, h)
  const halves: Target[] = []
  for (const seedInside of [1, 0]) {
    const a = dedicated(byteMode ? 'RGBA8' : 'RG16F', 'NEAREST')
    const b = dedicated(byteMode ? 'RGBA8' : 'RG16F', 'NEAREST')
    if (GlError.is(a) || GlError.is(b)) {
      release()
      return GlError.is(a) ? a : (b as Error)
    }
    let src = a
    let dst = b
    ctx.scope((s) => {
      const { gl } = ctx
      s.bindTarget(drawTargetFor(src))
      gl.useProgram(seed.handle)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, artwork.handle)
      gl.uniform1i(seed.uniformLocation('uSrc'), 0)
      gl.uniform2f(seed.uniformLocation('uSize'), w, h)
      gl.uniform1i(seed.uniformLocation('uSeedInside'), seedInside)
      gl.uniform4f(seed.uniformLocation('uArtworkUv'), ...artworkUv)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      gl.useProgram(step.handle)
      gl.uniform2f(step.uniformLocation('uSize'), w, h)
      for (const stepSize of schedule) {
        s.bindTarget(drawTargetFor(dst))
        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, src.texture.handle)
        gl.uniform1i(step.uniformLocation('uPrev'), 0)
        gl.uniform1f(step.uniformLocation('uStep'), stepSize)
        gl.drawArrays(gl.TRIANGLES, 0, 3)
        const t = src
        src = dst
        dst = t
      }
    })
    halves.push(src)
  }
  const out = dedicated(byteMode ? 'RGBA8' : 'R16F', 'LINEAR')
  if (GlError.is(out)) {
    release()
    return out
  }
  ctx.scope((s) => {
    const { gl } = ctx
    s.bindTarget(drawTargetFor(out))
    gl.useProgram(resolve.handle)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, halves[0]!.texture.handle)
    gl.uniform1i(resolve.uniformLocation('uInsideSeeds'), 0)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, halves[1]!.texture.handle)
    gl.uniform1i(resolve.uniformLocation('uOutsideSeeds'), 1)
    gl.uniform1f(resolve.uniformLocation('uPxScale'), pxScale)
    gl.uniform2f(resolve.uniformLocation('uEncode'), encode[0], encode[1])
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  })
  const field = readRawField(ctx, out, byteMode)
  release()
  return field
}

interface IdentityCase {
  readonly name: string
  readonly artwork: { readonly w: number; readonly h: number }
  readonly bytes: Uint8Array
  readonly artworkUv: readonly [number, number, number, number]
  readonly field: { readonly w: number; readonly h: number }
  /**
   * A larger field to build first on the same builder, so `field` runs on coord targets bigger
   * than itself — the ping-pong sub-viewport (`gl-sdf.ts`'s `pingPong`), whose identity is
   * exactly what the exact-size oracle then proves.
   */
  readonly first?: { readonly w: number; readonly h: number }
  /** The field storage the builder must report — proof that a forced byte-mode case took it. */
  readonly expectBits?: 'R16F' | 'RGBA8'
}

/** Builds `c` through the production builder and through the oracle; the fields must agree. */
function expectIdenticalField(ctx: GlContext, c: IdentityCase): void {
  const sdfRes = Math.max(c.field.w, c.field.h, c.first?.w ?? 0, c.first?.h ?? 0)
  const casePools = createScratchPools({ gl: ctx, artwork: c.artwork, sdfRes })
  const artwork = casePools.poolA.holdArtwork('sprite', {
    width: c.artwork.w,
    height: c.artwork.h,
    format: 'RGBA8UI',
    filter: 'NEAREST',
    label: `artwork:${c.name}`,
  })
  expect(GlError.is(artwork), c.name).toBe(false)
  if (GlError.is(artwork)) {
    casePools.dispose()
    return
  }
  expect(ctx.scope(() => uploadBytes(ctx.gl, artwork, c.bytes))).toBeUndefined()
  const builder = createSdfBuilder(ctx, casePools.poolA)
  expect(GlError.is(builder), c.name).toBe(false)
  if (GlError.is(builder)) {
    casePools.dispose()
    return
  }
  if (c.expectBits !== undefined) expect(builder.contract.bits, c.name).toBe(c.expectBits)
  if (c.first !== undefined) {
    const grown = builder.buildField({
      artwork,
      artworkUv: c.artworkUv,
      width: c.first.w,
      height: c.first.h,
      sourceLongSide: Math.max(c.first.w, c.first.h),
    })
    expect(GlError.is(grown), `${c.name}: first build`).toBe(false)
  }
  const sourceLongSide = Math.max(c.field.w, c.field.h)
  const built = builder.buildField({
    artwork,
    artworkUv: c.artworkUv,
    width: c.field.w,
    height: c.field.h,
    sourceLongSide,
  })
  expect(GlError.is(built), c.name).toBe(false)
  if (GlError.is(built)) {
    builder.dispose()
    casePools.dispose()
    return
  }
  const byteMode = !ctx.caps.floatRT
  const ours = readRawField(ctx, built.target, byteMode)
  const theirs = oraclePassA(ctx, artwork, c.artworkUv, c.field.w, c.field.h, sourceLongSide)
  expect(theirs instanceof Error, c.name).toBe(false)
  if (theirs instanceof Error) {
    builder.dispose()
    casePools.dispose()
    return
  }
  // Not vacuous: the field is signed, so both sides of the silhouette are in the comparison. The
  // raw byte-mode value is the encoded distance, whose zero level set is `encode.y * 255 = 128`.
  const zero = byteMode ? 128 : 0
  let lo = Infinity
  let hi = -Infinity
  for (const v of theirs) {
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  expect(lo, c.name).toBeLessThan(zero)
  expect(hi, c.name).toBeGreaterThan(zero)
  expect(firstMismatch(ours, theirs), `${c.name}: first differing texel`).toBe(-1)
  builder.dispose()
  casePools.dispose()
}

describe('texelFetch selects the texel texture(p / uSize) selected — byte for byte (P6b)', () => {
  it('on the disc fixtures: square, non-square, odd and margin-framed', () => {
    const { ctx } = open()
    const cases: IdentityCase[] = [
      {
        name: 'disc 64x64',
        artwork: { w: 64, h: 64 },
        bytes: disc(64, 64, 20),
        artworkUv: [1, 1, 0, 0],
        field: { w: 64, h: 64 },
      },
      {
        name: 'disc 48x40',
        artwork: { w: 48, h: 40 },
        bytes: disc(48, 40, 12),
        artworkUv: [1, 1, 0, 0],
        field: { w: 48, h: 40 },
      },
      {
        name: 'disc 33x17',
        artwork: { w: 33, h: 17 },
        bytes: disc(33, 17, 6),
        artworkUv: [1, 1, 0, 0],
        field: { w: 33, h: 17 },
      },
      {
        // A 64² artwork centred in a 96x80 field: the seed pass's overscan uv mapping (spec 8.5).
        name: 'disc 64x64 in a 96x80 field',
        artwork: { w: 64, h: 64 },
        bytes: disc(64, 64, 20),
        artworkUv: [96 / 64, 80 / 64, -16 / 64, -8 / 64],
        field: { w: 96, h: 80 },
      },
    ]
    for (const c of cases) expectIdenticalField(ctx, c)
  })

  it('on the bench artwork at 256x192 and at the production maximum, 512x384', () => {
    const { ctx } = open()
    for (const [w, h] of [
      [256, 192],
      [512, 384],
    ] as const) {
      expectIdenticalField(ctx, {
        name: `silhouette ${w}x${h}`,
        artwork: { w, h },
        bytes: silhouetteBytes(w, h),
        artworkUv: [1, 1, 0, 0],
        field: { w, h },
      })
    }
  })

  it('on coord targets larger than the field — the ping-pong sub-viewport — still byte for byte', () => {
    const { ctx } = open()
    expectIdenticalField(ctx, {
      name: 'disc 48x40 after a 64x64 build',
      artwork: { w: 48, h: 40 },
      bytes: disc(48, 40, 12),
      artworkUv: [1, 1, 0, 0],
      field: { w: 48, h: 40 },
      first: { w: 64, h: 64 },
    })
    expectIdenticalField(ctx, {
      name: 'disc 33x17 after a 40x64 build',
      artwork: { w: 33, h: 17 },
      bytes: disc(33, 17, 6),
      artworkUv: [1, 1, 0, 0],
      field: { w: 33, h: 17 },
      first: { w: 40, h: 64 },
    })
    // The production pair: the bucket-framed field (452x512 at sdfRes 512) built after the
    // reserve-framed one (512x512), on the bench artwork.
    expectIdenticalField(ctx, {
      name: 'silhouette 452x512 after a 512x512 build',
      artwork: { w: 452, h: 512 },
      bytes: silhouetteBytes(452, 512),
      artworkUv: [1, 1, 0, 0],
      field: { w: 452, h: 512 },
      first: { w: 512, h: 512 },
    })
  })

  it('in byte mode (no float render target): the RGBA8 coords and field, byte for byte', () => {
    const { ctx } = open()
    // `createGlContext` returns a plain object (the artwork suite forces `exactByteFetch` the same
    // way), so a shallow clone with `caps.floatRT` off sends the builder — and the oracle, which
    // reads the same flag — down the `RGBA8` path on a driver that does have float targets. The
    // 16-bit fixed-point coord packing and the byte field contract are what this exercises;
    // `expectBits` proves the branch fired rather than silently taking `R16F`.
    const byteCtx: GlContext = { ...ctx, caps: { ...ctx.caps, floatRT: false } }
    expectIdenticalField(byteCtx, {
      name: 'disc 64x64, byte mode',
      artwork: { w: 64, h: 64 },
      bytes: disc(64, 64, 20),
      artworkUv: [1, 1, 0, 0],
      field: { w: 64, h: 64 },
      expectBits: 'RGBA8',
    })
    expectIdenticalField(byteCtx, {
      name: 'disc 48x40 after a 64x64 build, byte mode',
      artwork: { w: 48, h: 40 },
      bytes: disc(48, 40, 12),
      artworkUv: [1, 1, 0, 0],
      field: { w: 48, h: 40 },
      first: { w: 64, h: 64 },
      expectBits: 'RGBA8',
    })
  })
})

describe('the field slots do not thrash between two framings (spec 8.1)', () => {
  it('allocates nothing once each framing has been built once, and both fields stay readable', () => {
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
    expect(ctx.scope(() => uploadBytes(ctx.gl, artwork, disc(ARTWORK.w, ARTWORK.h, 20)))).toBe(
      undefined,
    )

    // Two framings of one artwork, the way `source()` (reserve-sized front) and `build()`
    // (bucket-sized front) frame theirs: the same artwork, a different field grid.
    const framings = [
      { w: 64, h: 64, uv: [1, 1, 0, 0] as const },
      { w: 56, h: 48, uv: [1, 1, 0, 0] as const },
    ]
    const round = () => {
      for (const f of framings) {
        const field = builder.buildField({
          artwork,
          artworkUv: f.uv,
          width: f.w,
          height: f.h,
          sourceLongSide: Math.max(f.w, f.h),
        })
        expect(GlError.is(field)).toBe(false)
        if (GlError.is(field)) return
        const loose = builder.blurField({ field, sigmaPx: 4, frontLongSide: Math.max(f.w, f.h) })
        expect(GlError.is(loose)).toBe(false)
        // Readable, and right: the disc's centre is inside, its corner outside — in both framings.
        const read = (x: number, y: number) =>
          readDistance(ctx, drawTargetFor(field.target), builder.contract.bits, field.decode, x, y)
        expect(read(f.w >> 1, f.h >> 1)).toBeGreaterThan(0)
        expect(read(0, 0)).toBeLessThan(0)
      }
    }

    const texStorage2D = vi.spyOn(ctx.gl, 'texStorage2D')
    const createFramebuffer = vi.spyOn(ctx.gl, 'createFramebuffer')
    const getError = vi.spyOn(ctx.gl, 'getError')
    round()
    // The first round allocates: the coord ping-pong (once, at the larger framing), and each
    // framing's own field, loose and scratch. Never zero, or the assertion below is vacuous.
    expect(texStorage2D.mock.calls.length).toBeGreaterThan(0)
    texStorage2D.mockClear()
    createFramebuffer.mockClear()
    getError.mockClear()
    for (let i = 0; i < 4; i++) round()
    const stores = texStorage2D.mock.calls.length
    const framebuffers = createFramebuffer.mock.calls.length
    const errors = getError.mock.calls.length
    texStorage2D.mockRestore()
    createFramebuffer.mockRestore()
    getError.mockRestore()
    // Four more rounds alternating between the two framings allocate nothing at all — no
    // texture, no framebuffer, and no allocation-time `getError` round trip — which is the
    // thrash `SDF_POOL_SLOTS`'s doc comment describes, ended.
    expect(stores).toBe(0)
    expect(framebuffers).toBe(0)
    expect(errors).toBe(0)
    expect(pools!.poolA.bytes()).toBeLessThanOrEqual(poolABytes(ARTWORK, FIELD))
    builder.dispose()
  })
})
