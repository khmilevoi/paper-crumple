/**
 * Pass A — jump flooding into a signed distance field — moved onto core's `GlContext` (§5.1).
 *
 * Both fields live in a decode contract shared with the Node baker, so a runtime-built field and a
 * pre-baked one are interchangeable downstream:
 *
 *     distance_px = texel.r * decode.x + decode.y
 *
 * Four deliberate departures from `sdf.js`, and nothing else:
 *
 * 1. Every allocation goes through `GlContext` and Pool A, so §8.7's format table and §8.1's
 *    budget are the ones that apply, rather than a private `Map` keyed by `WxH`.
 * 2. The seed pass reads the **unpadded** artwork through `uArtworkUv`, which is how §8.5's
 *    "the margin is applied by the seed pass with a uv offset at no cost" is realised. It reads a
 *    `usampler2D`, because the resample writes `RGBA8UI` (see `./artwork.ts`).
 * 3. A mismatched caller-supplied target returns a `GlError` instead of throwing (§10.8).
 * 4. The pass count is a field of the result, not mutable state on the builder.
 *
 * `blurField` — pass B, the looseness blur — is task 6's addition: `SdfBuilder` now compiles a
 * fourth program (`BLUR_FS`) alongside the three pass A needs (seed, step, resolve).
 */
import { GlError } from '@paper-crumple/core'
import type { Size } from '@paper-crumple/core'
import type {
  ArtworkPool,
  DrawScope,
  GlContext,
  Target,
  Texture,
  TextureDesc,
} from '@paper-crumple/core/unstable'
import { drawTargetFor, FULLSCREEN_VS } from '@paper-crumple/core/unstable'

/** Range of the 8-bit encoding, in source pixels. Only used on the no-float-RT fallback. */
export const BYTE_RANGE_PX = 128

/**
 * The loose field is a heavily blurred field: it has no detail left to lose, so it is stored at
 * 1/LOOSE_DIV of the tight field's size on each axis. That is a 16x pixel saving on pass B and,
 * more importantly, it keeps the tap count sane at the wide blur radii the reference look needs.
 */
export const LOOSE_DIV = 4

const COORD_HEADER = (byteMode: boolean): string => `#version 300 es
precision highp float;
${byteMode ? '#define BYTE_COORDS 1' : ''}

#ifdef BYTE_COORDS
// Two 16-bit fixed-point coordinates packed into RGBA8. Exact round-trip under NEAREST.
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

// Seed: every pixel either is a seed (it stores its own coordinate) or is empty.
// uSeedInside picks which side of the alpha threshold seeds, so one program builds both
// halves of the signed field across two runs.
//
// Departure 2: uSrc is the unpadded artwork (or hull mask), read as a highp usampler2D — the
// normative RGBA8UI form (§8.5.3) — through uArtworkUv, which maps this fragment's field uv into
// artwork uv: (scale.xy, offset.xy). A mapped position outside [0,1] never touched the artwork,
// so it reads as outside the silhouette at no extra cost, which is how §8.5's overscan margin is
// applied without a padded upload.
const SEED_FS = (byteMode: boolean): string => `${COORD_HEADER(byteMode)}
uniform highp usampler2D uSrc;
uniform vec2 uSize;   // the FIELD size, not the image size: the field is built at lower res
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

// One jump-flooding round: look at 8 neighbours a fixed stride away plus self, keep the
// nearest seed any of them knows about. log2(size) rounds later every pixel knows its
// nearest seed, which is what makes this O(n log n) instead of O(n * radius).
const STEP_FS = (byteMode: boolean): string => `${COORD_HEADER(byteMode)}
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

// Resolve: distance to the nearest inside pixel and to the nearest outside pixel, subtracted.
// Inside the silhouette the first is 0, so the result is +(distance to the boundary);
// outside it is the mirror. Accurate to about half a pixel, which is far below the scale
// the tear noise works at.
const RESOLVE_FS = (byteMode: boolean, byteOut: boolean): string => `${COORD_HEADER(byteMode)}
uniform sampler2D uInsideSeeds;
uniform sampler2D uOutsideSeeds;
uniform float uPxScale;   // source pixels per field texel
uniform vec2 uEncode;     // inverse of the decode contract
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

// Pass B. Blurring the *distance field* is the whole trick: blurring the alpha would only
// soften the outline, but blurring the field pulls the zero level set across concavities, so
// the paper bridges the gap between two legs instead of walking down into it.
// Works in uv, not texels, so the horizontal half can downsample at the same time: the loose
// field is smooth by construction, so it is stored at a quarter of the tight field's resolution
// on each axis. That is a 4x pixel saving and a 2x tap saving on the most expensive pass here.
const BLUR_FS = (byteOut: boolean): string => `#version 300 es
precision highp float;
uniform sampler2D uField;
uniform vec2 uDecode;
uniform vec2 uEncode;
uniform vec2 uOutSize;
uniform vec2 uStepUv;   // one tap, in uv
uniform float uSigma;   // in output texels
uniform int uRadius;
// Maps output uv into the input field's own uv space. Identity for a runtime field; for a
// pre-baked one it undoes the transparent padding the engine adds around the artwork, so the
// blurred result always lands in padded-texture space no matter where the input came from.
// This port never attaches a pre-baked field (loadBakedField/attachBakedField stay out of this
// package, per §3.3), so these three uniforms are always the identity here — left in place,
// with this comment, rather than deleted, so the shader keeps matching sdf.js verbatim.
uniform vec2 uInScale;
uniform vec2 uInOffset;
// Working-texture pixels per unit of the input field's uv, for the same linear extrapolation
// outside the field's rectangle that pass C does. Without it a baked field's clamped border
// starves this blur and the loose envelope balloons.
uniform vec2 uInPxPerUv;
out vec4 outColor;

float sampleField(sampler2D field, vec2 outUv, vec2 decode) {
  vec2 p = outUv * uInScale + uInOffset;
  vec2 inside = clamp(p, 0.0, 1.0);
  float d = texture(field, inside).r * decode.x + decode.y;
  return d - length((p - inside) * uInPxPerUv);
}
void main() {
  vec2 uv = gl_FragCoord.xy / uOutSize;
  float sum = 0.0;
  float wsum = 0.0;
  float inv = 1.0 / (2.0 * uSigma * uSigma);
  for (int i = -uRadius; i <= uRadius; i++) {
    float fi = float(i);
    float w = exp(-fi * fi * inv);
    float d = sampleField(uField, uv + uStepUv * fi, uDecode);
    sum += d * w;
    wsum += w;
  }
  float d = sum / wsum;
  ${byteOut ? 'outColor = vec4(clamp(d * uEncode.x + uEncode.y, 0.0, 1.0));' : 'outColor = vec4(d, 0.0, 0.0, 1.0);'}
}`

export const SDF_POOL_SLOTS = Object.freeze({
  inA: 'sdf.inA',
  inB: 'sdf.inB',
  outA: 'sdf.outA',
  outB: 'sdf.outB',
  tight: 'sdf.tight',
  loose: 'sdf.loose',
  blur: 'sdf.blur',
  hullField: 'sdf.hullField',
} as const)

/** decode/encode pair for the field storage this context is using, verbatim from `sdf.js`. */
export interface FieldContract {
  readonly decode: readonly [number, number]
  readonly encode: readonly [number, number]
  readonly rangePx: number
  readonly bits: 'R16F' | 'RGBA8'
}

/** Pass A's result: the resolved signed field, plus everything a caller needs to decode it. */
export interface Field {
  readonly target: Target
  readonly width: number
  readonly height: number
  readonly decode: readonly [number, number]
  readonly rangePx: number
  /** Field texels to source pixels, the spike's `srcWidth / w`. */
  readonly pxScale: number
  /** How many draw calls this build spent — 2 seeds + 2 x (schedule + 1 unit pass) + 1 resolve. */
  readonly passes: number
}

export interface BuildFieldOptions {
  /** The `RGBA8UI` artwork, or the `RGBA8UI` hull mask — pass A does not care which. */
  readonly artwork: Texture
  /** `(scale.x, scale.y, offset.x, offset.y)`: field uv -> artwork uv. `[1, 1, 0, 0]` is identity. */
  readonly artworkUv: readonly [number, number, number, number]
  readonly width: number
  readonly height: number
  /** The long side of the space the field covers, in front pixels — sets `uPxScale`. */
  readonly sourceLongSide: number
  /** Reuse this target instead of acquiring one; its size must match exactly. */
  readonly into?: Target
  /** The Pool A slot the output lands in when `into` is absent. */
  readonly slot?: string
}

/** Pass B's result: the blurred, downsampled loose field. */
export interface LooseField {
  readonly target: Target
  readonly width: number
  readonly height: number
  readonly decode: readonly [number, number]
  readonly rangePx: number
  /** Field texels to front pixels, derived from `frontLongSide`, not from the input field. */
  readonly pxScale: number
  /** Gaussian radius, in output texels: `min(64, max(1, ceil(sigma * 2.5)))`. */
  readonly radius: number
  /** `radius * 2 + 1` — how many samples each of the two separable passes takes per texel. */
  readonly taps: number
  /** Echoes the input `sigmaPx`, so a caller (task 9's renderer) can derive `LOOSE_PUSH`. */
  readonly sigmaPx: number
}

export interface BlurFieldOptions {
  readonly field: Field
  /** In front pixels, from `sigmaFor(looseness, frontLongSide)`. */
  readonly sigmaPx: number
  /** The long side of the front, which sets `outPxScale` from the OUTPUT, not from the input. */
  readonly frontLongSide: number
}

export interface SdfBuilder {
  readonly contract: FieldContract
  fieldTargetDesc(w: number, h: number): TextureDesc
  buildField(o: BuildFieldOptions): InstanceType<typeof GlError> | Field
  blurField(o: BlurFieldOptions): InstanceType<typeof GlError> | LooseField
  dispose(): void
}

/** `max(2, round(n / LOOSE_DIV))` per axis — the size the loose field is stored at. */
export function looseSizeFor(field: Size): Size {
  return {
    w: Math.max(2, Math.round(field.w / LOOSE_DIV)),
    h: Math.max(2, Math.round(field.h / LOOSE_DIV)),
  }
}

/**
 * `sigmaPx` in *source* pixels, scaled by the front's own long side, so the looseness knob
 * means the same thing for a 300 px shoe and a 768 px avatar.
 */
export function sigmaFor(looseness: number, frontLongSide: number): number {
  return looseness ** 1.6 * 0.2 * frontLongSide
}

type Err = InstanceType<typeof GlError>

/** `sourceLongSide / max(width, height)` — field texels to front pixels. */
function pxScaleFor(sourceLongSide: number, width: number, height: number): number {
  return sourceLongSide / Math.max(width, height)
}

/** Classic JFA schedule `N/2, N/4 ... 1` plus one extra unit pass (removes sparse artefacts). */
function scheduleFor(width: number, height: number): readonly number[] {
  const levels = Math.ceil(Math.log2(Math.max(width, height)))
  const schedule: number[] = []
  for (let k = levels - 1; k >= 0; k--) schedule.push(2 ** k)
  schedule.push(1)
  return schedule
}

export function createSdfBuilder(ctx: GlContext, pool: ArtworkPool): Err | SdfBuilder {
  const byteMode = !ctx.caps.floatRT

  const seed = ctx.program(FULLSCREEN_VS, SEED_FS(byteMode), 'paper.sdf.seed')
  if (GlError.is(seed)) return seed
  const step = ctx.program(FULLSCREEN_VS, STEP_FS(byteMode), 'paper.sdf.step')
  if (GlError.is(step)) {
    seed.dispose()
    return step
  }
  const resolve = ctx.program(FULLSCREEN_VS, RESOLVE_FS(byteMode, byteMode), 'paper.sdf.resolve')
  if (GlError.is(resolve)) {
    seed.dispose()
    step.dispose()
    return resolve
  }
  const blur = ctx.program(FULLSCREEN_VS, BLUR_FS(byteMode), 'paper.sdf.blur')
  if (GlError.is(blur)) {
    seed.dispose()
    step.dispose()
    resolve.dispose()
    return blur
  }

  const contract: FieldContract = byteMode
    ? {
        decode: [(255 / 127) * BYTE_RANGE_PX, (-128 / 127) * BYTE_RANGE_PX],
        encode: [127 / 255 / BYTE_RANGE_PX, 128 / 255],
        rangePx: BYTE_RANGE_PX,
        bits: 'RGBA8',
      }
    : { decode: [1, 0], encode: [1, 0], rangePx: Infinity, bits: 'R16F' }

  function fieldTargetDesc(w: number, h: number): TextureDesc {
    // LINEAR: pass C samples the field at render resolution, and the field is locally linear, so
    // bilinear interpolation of a half-res field is visually free.
    return {
      width: w,
      height: h,
      format: byteMode ? 'RGBA8' : 'R16F',
      filter: 'LINEAR',
      label: 'paper.sdf.field',
    }
  }

  function coordTargetDesc(w: number, h: number, label: string): TextureDesc {
    return {
      width: w,
      height: h,
      format: byteMode ? 'RGBA8' : 'RG16F',
      filter: 'NEAREST',
      label,
    }
  }

  // `ctx.target()` allocates a brand-new WebGLFramebuffer on every call, but `pool.acquire()`
  // hands back the *same* Texture (same `.handle`) whenever a slot's desc has not changed. Every
  // slot this builder touches — Pass A's ping-pong halves as much as Pass B's `loose`/`blur` —
  // is re-acquired on every `buildField`/`blurField` call (that is what makes the looseness knob
  // "cheap enough to run live off a slider"), so without caching, every call leaked one
  // framebuffer per slot. The Target wrapping each slot's pooled texture is cached here and only
  // rebuilt when the pool hands back a different texture identity or size (a resize/replace).
  const targetsBySlot = new Map<string, Target>()
  function acquireTarget(slot: string, d: TextureDesc): Err | Target {
    const texture = pool.acquire(slot, d)
    if (GlError.is(texture)) return texture
    const cached = targetsBySlot.get(slot)
    if (
      cached !== undefined &&
      cached.texture.handle === texture.handle &&
      cached.width === texture.width &&
      cached.height === texture.height
    ) {
      return cached
    }
    if (cached !== undefined) cached.dispose()
    const target = ctx.target(texture)
    if (GlError.is(target)) return target
    targetsBySlot.set(slot, target)
    return target
  }

  // A `const` arrow, not a hoisted `function` declaration: `seed`/`step`/`resolve`/`blur` are
  // narrowed to `Program` above by the early-return `GlError.is()` checks, but that narrowing does
  // not survive into a nested `function` declaration's body (TS's CFA treats a hoisted function as
  // possibly callable before the narrowing ran, so it re-widens captured outer bindings back to
  // their declared type). A `const` arrow has no such hoisting hazard, so the narrowing holds.
  const buildField = (o: BuildFieldOptions): Err | Field => {
    const { artwork, artworkUv, width: w, height: h, sourceLongSide, into, slot } = o

    if (into !== undefined && (into.width !== w || into.height !== h)) {
      return new GlError(
        `paper.sdf.buildField: target ${into.width}x${into.height} != field ${w}x${h}`,
      )
    }

    const pxScale = pxScaleFor(sourceLongSide, w, h)
    const schedule = scheduleFor(w, h)
    const passes = 2 * (schedule.length + 1) + 1

    // Two ping-pong pairs, one per half, so neither half has to be copied out of the way.
    const halves: Target[] = []
    for (const [seedInside, keyA, keyB] of [
      [1, SDF_POOL_SLOTS.inA, SDF_POOL_SLOTS.inB],
      [0, SDF_POOL_SLOTS.outA, SDF_POOL_SLOTS.outB],
    ] as const) {
      const targetA = acquireTarget(keyA, coordTargetDesc(w, h, keyA))
      if (GlError.is(targetA)) return targetA
      const targetB = acquireTarget(keyB, coordTargetDesc(w, h, keyB))
      if (GlError.is(targetB)) return targetB

      let src = targetA
      let dst = targetB

      const seedFail = ctx.scope((s: DrawScope): Err | undefined => {
        const { gl } = ctx
        s.bindTarget(drawTargetFor(src))
        gl.useProgram(seed.handle)
        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, artwork.handle)
        gl.uniform1i(seed.uniformLocation('uSrc'), 0)
        gl.uniform2f(seed.uniformLocation('uSize'), w, h)
        gl.uniform1i(seed.uniformLocation('uSeedInside'), seedInside)
        gl.uniform4f(
          seed.uniformLocation('uArtworkUv'),
          artworkUv[0],
          artworkUv[1],
          artworkUv[2],
          artworkUv[3],
        )
        gl.drawArrays(gl.TRIANGLES, 0, 3)
        return undefined
      })
      if (seedFail !== undefined) return seedFail

      const stepFail = ctx.scope((s: DrawScope): Err | undefined => {
        const { gl } = ctx
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
        return undefined
      })
      if (stepFail !== undefined) return stepFail

      halves.push(src)
    }

    const out = into ?? acquireTarget(slot ?? SDF_POOL_SLOTS.tight, fieldTargetDesc(w, h))
    if (GlError.is(out)) return out

    const resolveFail = ctx.scope((s: DrawScope): Err | undefined => {
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
      gl.uniform2f(resolve.uniformLocation('uEncode'), contract.encode[0], contract.encode[1])
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      return undefined
    })
    if (resolveFail !== undefined) return resolveFail

    return {
      target: out,
      width: w,
      height: h,
      decode: contract.decode,
      rangePx: contract.rangePx,
      pxScale,
      passes,
    }
  }

  // Same reasoning as `buildField` above: a `const` arrow so the `blur` program's narrowing holds.
  const blurField = (o: BlurFieldOptions): Err | LooseField => {
    const { field, sigmaPx, frontLongSide } = o
    const size = looseSizeFor({ w: field.width, h: field.height })
    const outDesc = fieldTargetDesc(size.w, size.h)

    const out = acquireTarget(SDF_POOL_SLOTS.loose, outDesc)
    if (GlError.is(out)) return out
    // The horizontal half's shared scratch is a Pool A slot rather than a private `Map` entry:
    // it is dead the moment the vertical half reads it, so every sprite in a grid can share one.
    const tmp = acquireTarget(SDF_POOL_SLOTS.blur, outDesc)
    if (GlError.is(tmp)) return tmp

    // Deliberately derived from the output, not the input: a baked field may be at any
    // resolution and cover a different rectangle, but the output always covers the front.
    const outPxScale = frontLongSide / Math.max(out.width, out.height)
    const sigma = Math.max(0.35, sigmaPx / outPxScale)
    const radius = Math.min(64, Math.max(1, Math.ceil(sigma * 2.5)))

    // Working-texture pixels per unit of uv, for both taps — a consistent stick in front-pixel
    // units, independent of tmp/out's own resolution, matching `decode`'s own scale.
    const paddedHeight = (frontLongSide * out.height) / out.width

    const blurFail = ctx.scope((s: DrawScope): Err | undefined => {
      const { gl } = ctx
      gl.useProgram(blur.handle)
      gl.uniform1f(blur.uniformLocation('uSigma'), sigma)
      gl.uniform1i(blur.uniformLocation('uRadius'), radius)
      gl.uniform2f(blur.uniformLocation('uEncode'), contract.encode[0], contract.encode[1])
      gl.uniform2f(blur.uniformLocation('uOutSize'), out.width, out.height)
      // Always the identity: this port never attaches a pre-baked field (see BLUR_FS's comment).
      gl.uniform2f(blur.uniformLocation('uInScale'), 1, 1)
      gl.uniform2f(blur.uniformLocation('uInOffset'), 0, 0)
      gl.uniform2f(blur.uniformLocation('uInPxPerUv'), frontLongSide, paddedHeight)

      // Horizontal half: reads the tight field, downsamples to `out`'s width on the way in.
      s.bindTarget(drawTargetFor(tmp))
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, field.target.texture.handle)
      gl.uniform1i(blur.uniformLocation('uField'), 0)
      gl.uniform2f(blur.uniformLocation('uDecode'), field.decode[0], field.decode[1])
      gl.uniform2f(blur.uniformLocation('uStepUv'), 1 / out.width, 0)
      gl.drawArrays(gl.TRIANGLES, 0, 3)

      // Vertical half: reads the scratch, writes the loose field.
      s.bindTarget(drawTargetFor(out))
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, tmp.texture.handle)
      gl.uniform1i(blur.uniformLocation('uField'), 0)
      gl.uniform2f(blur.uniformLocation('uDecode'), contract.decode[0], contract.decode[1])
      gl.uniform2f(blur.uniformLocation('uStepUv'), 0, 1 / out.height)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      return undefined
    })
    if (blurFail !== undefined) return blurFail

    return {
      target: out,
      width: out.width,
      height: out.height,
      decode: contract.decode,
      rangePx: contract.rangePx,
      pxScale: outPxScale,
      radius,
      taps: radius * 2 + 1,
      sigmaPx,
    }
  }

  return {
    contract,
    fieldTargetDesc,
    buildField,
    blurField,
    dispose() {
      seed.dispose()
      step.dispose()
      resolve.dispose()
      blur.dispose()
      // The pool owns the coord and field textures backing every slot above, and disposes its
      // own on `pool.dispose()` — this builder never holds a texture Pool A did not hand it. The
      // framebuffers wrapping those textures are this builder's own, though (see
      // `acquireTarget`'s comment), so they are released here.
      for (const target of targetsBySlot.values()) target.dispose()
      targetsBySlot.clear()
    },
  }
}
