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
 * `blurField` — pass B, the looseness blur — is task 6's addition to this file; it is not part of
 * `SdfBuilder` yet, so this module compiles only the three programs pass A needs (seed, step,
 * resolve).
 */
import { GlError } from '@paper-crumple/core'
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

export interface SdfBuilder {
  readonly contract: FieldContract
  fieldTargetDesc(w: number, h: number): TextureDesc
  buildField(o: BuildFieldOptions): InstanceType<typeof GlError> | Field
  dispose(): void
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

  /** Acquire a Pool A texture and wrap it in a fresh render target. */
  function acquireTarget(slot: string, d: TextureDesc): Err | Target {
    const texture = pool.acquire(slot, d)
    if (GlError.is(texture)) return texture
    return ctx.target(texture)
  }

  function buildField(o: BuildFieldOptions): Err | Field {
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

  return {
    contract,
    fieldTargetDesc,
    buildField,
    dispose() {
      seed.dispose()
      step.dispose()
      resolve.dispose()
      // The pool owns the coord and field textures backing every slot above, and disposes its
      // own on `pool.dispose()` — this builder never holds a texture Pool A did not hand it.
    },
  }
}
