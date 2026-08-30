/**
 * Run `RESAMPLE_FS` over a source and read the result back (§7.4.1, §11).
 *
 * **Test-only source.** The shipped GPU resample pass belongs to the sheet slot (P10) and is
 * written against `RESAMPLE_FS` there; this is the harness that proves the shader is the
 * reference's twin before any slot exists to use it.
 *
 * The whole path is integer: an `RGBA8UI` source read with `usampler2D` — §8.5.3's normative
 * form and its fallback — into an `RGBA8UI` attachment, read back as `RGBA_INTEGER` /
 * `UNSIGNED_BYTE`. No normalised texture, no float anywhere, and therefore nothing for a driver
 * to round differently.
 *
 * **No flip.** `UNPACK_FLIP_Y_WEBGL` is pinned off, so the reference's row 0 is the texture's row
 * 0 is the first row `readPixels` returns.
 */
import { GlError } from '../errors.js'
import type { Rect } from '../geometry.js'
import type { CoreGlContext } from '../gl-context.js'
import { drawTargetFor, uploadBytes } from '../gl-resources.js'
import { FULLSCREEN_VS, RESAMPLE_FS, RESAMPLE_UNIFORMS } from '../gl-shaders.js'
import type { ResampleSource } from '../resample.js'

type Err = InstanceType<typeof GlError>

/** A value the shader can never produce for every channel of every texel of a random corpus. */
const SENTINEL = 7

export function resampleOnGpu(
  ctx: CoreGlContext,
  source: ResampleSource,
  srcRect: Rect,
  dstW: number,
  dstH: number,
): Err | Uint8ClampedArray {
  const gl = ctx.gl

  const sourceTexture = ctx.texture({
    width: source.width,
    height: source.height,
    format: 'RGBA8UI',
    label: 'resample-source',
  })
  if (GlError.is(sourceTexture)) return sourceTexture

  const destinationTexture = ctx.texture({
    width: dstW,
    height: dstH,
    format: 'RGBA8UI',
    label: 'resample-destination',
  })
  if (GlError.is(destinationTexture)) return destinationTexture

  const target = ctx.target(destinationTexture)
  if (GlError.is(target)) return target

  const program = ctx.program(FULLSCREEN_VS, RESAMPLE_FS, 'identityResample')
  if (GlError.is(program)) return program

  const out = new Uint8Array(dstW * dstH * 4)

  // The failure is the scope's *return value* and never a captured `let`: TypeScript stops
  // narrowing a variable that a nested function assigns, and a `failure !== null` check after
  // the call would read as unreachable.
  const failure = ctx.scope((s): Err | undefined => {
    const upload = uploadBytes(
      gl,
      sourceTexture,
      new Uint8Array(source.data.buffer, source.data.byteOffset, source.data.byteLength),
    )
    if (upload !== undefined) return upload

    const vao: WebGLVertexArrayObject | null = gl.createVertexArray()
    if (vao === null) return new GlError('identityResample: createVertexArray returned null')
    gl.bindVertexArray(vao)

    s.bindTarget(drawTargetFor(target))
    // §7.4.1's pinned set, re-stated here because a scope may be entered from a dirty caller.
    s.enable('BLEND', false)
    s.enable('SCISSOR_TEST', false)
    s.enable('DEPTH_TEST', false)
    gl.colorMask(true, true, true, true)

    // gl.clear does not clear an integer buffer; clearBufferuiv does. A sentinel proves the
    // triangle covered every texel rather than the readback finding stale memory.
    gl.clearBufferuiv(gl.COLOR, 0, new Uint32Array([SENTINEL, SENTINEL, SENTINEL, SENTINEL]))

    gl.useProgram(program.handle)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, sourceTexture.handle)
    gl.uniform1i(program.uniformLocation(RESAMPLE_UNIFORMS.source), 0)
    gl.uniform4i(
      program.uniformLocation(RESAMPLE_UNIFORMS.srcRect),
      srcRect.x,
      srcRect.y,
      srcRect.w,
      srcRect.h,
    )
    gl.uniform2i(program.uniformLocation(RESAMPLE_UNIFORMS.dst), dstW, dstH)
    gl.drawArrays(gl.TRIANGLES, 0, 3)

    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, target.framebuffer)
    gl.readPixels(0, 0, dstW, dstH, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, out)

    const error = gl.getError()
    gl.bindVertexArray(null)
    gl.deleteVertexArray(vao)

    return error === gl.NO_ERROR
      ? undefined
      : new GlError(`identityResample: GL error 0x${error.toString(16)} after readback`)
  })

  program.dispose()
  target.dispose()
  destinationTexture.dispose()
  sourceTexture.dispose()

  if (failure !== undefined) return failure
  return new Uint8ClampedArray(out.buffer, out.byteOffset, out.byteLength)
}
