/**
 * The resample: staging upload, `RESAMPLE_FS` into the Pool A artwork slot.
 *
 * **The format decision, and the accounting that forces it.** The artwork slot holds an
 * `RGBA8UI` texture at `A`, not an `RGBA8` one, for three reasons that agree: §7.4.1 requires
 * that the front-assembly pass read the resampled artwork with `texelFetch` at 1:1, never
 * `LINEAR`, and `texelFetch` on a `usampler2D` is exactly that; `RESAMPLE_FS`, which core
 * shipped and §7.4.1 forbids editing ("a slot that edits it breaks a cross-language contract"),
 * declares `out uvec4 oColor` and therefore requires an integer colour attachment; and `RGBA8UI`
 * costs 4 B/texel, so the slot is exactly `frontBytes(artwork)` — Pool A's artwork term,
 * unchanged.
 *
 * **Getting the source bytes into an integer texture, and the one transient it costs.**
 * `RESAMPLE_FS` reads a `usampler2D`, and WebGL2 forbids a `TexImageSource` upload into an
 * integer internal format (§8.5.3: `RGBA8UI` with `RGBA_INTEGER` raises `INVALID_OPERATION` from
 * every `ImageBitmap` overload). Two branches, on `ctx.exactByteFetch`:
 *
 * - **Probe green** — upload the `ImageBitmap` into Pool B's `RGBA8` staging (sized exactly for
 *   the source, per §8.1), then run `EXACT_BYTE_FETCH_FS` — core's own probe shader — into a
 *   source-sized `RGBA8UI`. No CPU decode and no `ArrayBufferView`.
 * - **Probe red** — `drawImage` the bitmap into an `OffscreenCanvas`, `getImageData`, and
 *   `uploadBytes` those bytes straight into the same source-sized `RGBA8UI`. Slower (§8.5.3
 *   prices it at 4–8 ms against 0.7–2.0), and correct on a driver whose unorm-to-float
 *   conversion drifts. Pool B is unused on this branch.
 *
 * That source-sized `RGBA8UI` is a **dedicated, non-pooled allocation released synchronously at
 * the end of the call**, on the mechanism §8.1 already blesses for `exact: true`. It exists
 * because `poolB.acquire` hard-codes `format: 'RGBA8'` and neither pool's budget has room for a
 * second source-sized texture. §8.5.3 claims that with the probe green "the `RGBA8UI` texture
 * and the `ArrayBufferView` disappear from the runtime entirely"; the `ArrayBufferView` and the
 * CPU staging canvas do, and the integer texture does not, because `RESAMPLE_FS`'s own signature
 * requires one at both ends. **A `sampler2D`-source variant of the resample shader — which is
 * P6's to write, not this plan's, since §7.4.1 makes the reference and its GLSL twin two plans'
 * work on purpose — would delete this transient.**
 *
 * **Pool ownership.** `resample()` calls `poolA.holdArtwork(spriteKey, desc)` for the output, so
 * §8.5's "the pool keeps one artwork slot, keyed by sprite" is enforced by the pool and not by
 * this module, and `poolA.artworkKey()` is what `build()` later reads to decide
 * `SourceExpiredError`. It calls `poolB.releaseIdle(spriteKey)` on the way out.
 *
 * **Ambient state.** §7.4.1 names three pieces that "silently corrupt a byte and must be
 * pinned": `DITHER` disabled, `UNPACK_COLORSPACE_CONVERSION_WEBGL` set to `NONE`, and
 * `UNPACK_FLIP_Y_WEBGL` not inherited from the spike's `true`. P6's `pinAmbientState` pins them
 * at context creation; this module's own level-2 suite asserts them rather than assuming, because
 * a byte lost here is invisible until a fixture comparison fails.
 */
import { attempt, GlError } from '@paper-crumple/core'
import type { Rect, Size } from '@paper-crumple/core'
import type {
  ArtworkPool,
  GlContext,
  Program,
  StagingPool,
  Target,
  Texture,
} from '@paper-crumple/core/unstable'
import {
  drawTargetFor,
  EXACT_BYTE_FETCH_FS,
  FULLSCREEN_VS,
  RESAMPLE_FS,
  RESAMPLE_UNIFORMS,
  uploadBytes,
} from '@paper-crumple/core/unstable'

type Err = InstanceType<typeof GlError>

export interface ArtworkSlot {
  readonly texture: Texture
  readonly size: Size
  readonly srcRect: Rect
}

export interface ResampleOptions {
  readonly spriteKey: string
  readonly bitmap: ImageBitmap
  /** The source rect, in source texels. `{ 0, 0, srcW, srcH }` unless a caller crops. */
  readonly srcRect: Rect
  /** `A` — front-derived, never source-derived (§8.5). */
  readonly artwork: Size
  readonly poolA: ArtworkPool
  readonly poolB: StagingPool
}

export interface Resampler {
  resample(o: ResampleOptions): Err | ArtworkSlot
  dispose(): void
}

/**
 * Upload `bitmap` into Pool B's `RGBA8` staging and recover the exact bytes into `dedicated`
 * with `EXACT_BYTE_FETCH_FS`. Probe-green branch — no CPU decode, no `ArrayBufferView`.
 */
function uploadViaByteFetch(
  ctx: GlContext,
  byteFetch: Program,
  poolB: StagingPool,
  spriteKey: string,
  srcRect: Rect,
  bitmap: ImageBitmap,
  dedicated: Texture,
): Err | undefined {
  const staging = poolB.acquire(spriteKey, { w: srcRect.w, h: srcRect.h })
  if (GlError.is(staging)) return staging

  const target = ctx.target(dedicated)
  if (GlError.is(target)) return target

  const failure = ctx.scope((s): Err | undefined => {
    const { gl } = ctx
    gl.bindTexture(gl.TEXTURE_2D, staging.handle)
    // §8.5.4: a closed or detached bitmap must resolve to an error, never throw. This is the
    // stage's last read of the bitmap (§8.5.4), before `source()`'s first suspension point.
    const upload = attempt(
      () =>
        gl.texSubImage2D(
          gl.TEXTURE_2D,
          0,
          0,
          0,
          srcRect.w,
          srcRect.h,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          bitmap,
        ),
      (cause) => new GlError('resample: bitmap upload failed', { cause }),
    )
    if (GlError.is(upload)) return upload

    s.bindTarget(drawTargetFor(target))
    gl.useProgram(byteFetch.handle)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, staging.handle)
    gl.uniform1i(byteFetch.uniformLocation('uSource'), 0)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    return undefined
  })

  target.dispose()
  return failure
}

/**
 * `drawImage` the bitmap into an `OffscreenCanvas`, `getImageData`, and `uploadBytes` those bytes
 * straight into `dedicated`. Probe-red branch — Pool B is unused.
 */
function uploadViaCanvas(
  ctx: GlContext,
  srcRect: Rect,
  bitmap: ImageBitmap,
  dedicated: Texture,
): Err | undefined {
  const canvas = attempt(
    () => new OffscreenCanvas(srcRect.w, srcRect.h),
    (cause) => new GlError('resample: OffscreenCanvas construction failed', { cause }),
  )
  if (GlError.is(canvas)) return canvas

  const c2d = canvas.getContext('2d')
  if (c2d === null) return new GlError('resample: OffscreenCanvas 2D context unavailable')

  // §8.5.4: the stage's last read of the bitmap happens here, before `source()`'s first
  // suspension point — which is what makes `stage.add(b, { key }); b.close()` legal.
  const drawn = attempt(
    () => c2d.drawImage(bitmap, 0, 0),
    (cause) => new GlError('resample: drawImage failed', { cause }),
  )
  if (GlError.is(drawn)) return drawn

  const imageData = attempt(
    () => c2d.getImageData(0, 0, srcRect.w, srcRect.h),
    (cause) => new GlError('resample: getImageData failed', { cause }),
  )
  if (GlError.is(imageData)) return imageData

  return ctx.scope(() =>
    uploadBytes(
      ctx.gl,
      dedicated,
      new Uint8Array(imageData.data.buffer, imageData.data.byteOffset, imageData.data.byteLength),
    ),
  )
}

export function createResampler(ctx: GlContext): Err | Resampler {
  const byteFetch = ctx.program(FULLSCREEN_VS, EXACT_BYTE_FETCH_FS, 'paper.byteFetch')
  if (GlError.is(byteFetch)) return byteFetch
  const resampleProgram = ctx.program(FULLSCREEN_VS, RESAMPLE_FS, 'paper.resample')
  if (GlError.is(resampleProgram)) {
    byteFetch.dispose()
    return resampleProgram
  }

  // `ctx.target()` allocates a new `WebGLFramebuffer` on every call, while `poolA.holdArtwork`
  // hands back a cached, reused `Texture` for consecutive rebuilds of the same sprite. Caching
  // the artwork slot's own `Target` here (invalidated with disposal on identity or size change,
  // per `gl-sdf.ts`'s `targetsBySlot`) is what keeps a dragged front-class knob from leaking one
  // framebuffer per resample.
  let artworkTarget: Target | null = null

  function acquireArtworkTarget(texture: Texture): Err | Target {
    if (
      artworkTarget !== null &&
      artworkTarget.texture.handle === texture.handle &&
      artworkTarget.width === texture.width &&
      artworkTarget.height === texture.height
    ) {
      return artworkTarget
    }
    if (artworkTarget !== null) artworkTarget.dispose()
    artworkTarget = null
    const target = ctx.target(texture)
    if (GlError.is(target)) return target
    artworkTarget = target
    return target
  }

  function resample(o: ResampleOptions): Err | ArtworkSlot {
    const { spriteKey, bitmap, srcRect, artwork, poolA, poolB } = o
    const { gl } = ctx

    const dedicated = ctx.texture({
      width: srcRect.w,
      height: srcRect.h,
      format: 'RGBA8UI',
      filter: 'NEAREST',
      label: `resample.src:${spriteKey}`,
    })
    if (GlError.is(dedicated)) return dedicated

    const uploadFail = ctx.exactByteFetch
      ? uploadViaByteFetch(ctx, byteFetch, poolB, spriteKey, srcRect, bitmap, dedicated)
      : uploadViaCanvas(ctx, srcRect, bitmap, dedicated)
    if (uploadFail !== undefined) {
      dedicated.dispose()
      return uploadFail
    }

    const artworkTexture = poolA.holdArtwork(spriteKey, {
      width: artwork.w,
      height: artwork.h,
      format: 'RGBA8UI',
      filter: 'NEAREST',
      label: `artwork:${spriteKey}`,
    })
    if (GlError.is(artworkTexture)) {
      dedicated.dispose()
      return artworkTexture
    }

    const target = acquireArtworkTarget(artworkTexture)
    if (GlError.is(target)) {
      dedicated.dispose()
      return target
    }

    ctx.scope((s) => {
      s.bindTarget(drawTargetFor(target))
      gl.useProgram(resampleProgram.handle)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, dedicated.handle)
      gl.uniform1i(resampleProgram.uniformLocation(RESAMPLE_UNIFORMS.source), 0)
      gl.uniform4i(
        resampleProgram.uniformLocation(RESAMPLE_UNIFORMS.srcRect),
        srcRect.x,
        srcRect.y,
        srcRect.w,
        srcRect.h,
      )
      gl.uniform2i(resampleProgram.uniformLocation(RESAMPLE_UNIFORMS.dst), artwork.w, artwork.h)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    })

    dedicated.dispose()
    poolB.releaseIdle(spriteKey)

    return { texture: artworkTexture, size: artwork, srcRect }
  }

  return {
    resample,
    dispose() {
      byteFetch.dispose()
      resampleProgram.dispose()
      if (artworkTarget !== null) artworkTarget.dispose()
      artworkTarget = null
    },
  }
}
