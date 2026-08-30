/**
 * §8.5.3's `exactByteFetch` probe.
 *
 * > At context creation, upload a `256x1` `RGBA8` texture holding `n` in every channel for
 * > `n` in `[0,255]`, run the recovery expression into an `RGBA8UI` target, read it back and
 * > assert the identity.
 *
 * It runs before a `GlContext` exists, so it takes a raw context and builds and tears down every
 * object itself. It saves and restores §5.1's enumerated state around its own work, because a
 * probe that leaves the context dirty is a probe that makes the first real draw wrong.
 *
 * Nothing here throws (§10.8): every failure path returns `false`, because a driver that cannot
 * run the probe is a driver on which `exactByteFetch` is not true.
 */
import { EXACT_BYTE_FETCH_FS, FULLSCREEN_VS } from './gl-shaders.js'
import { captureGlState, restoreGlState } from './gl-state.js'

const WIDTH = 256

function buildShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const shader: WebGLShader | null = gl.createShader(type)
  if (shader === null) return null
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS) !== true) {
    gl.deleteShader(shader)
    return null
  }
  return shader
}

/**
 * True iff `uint(texelFetch(rgba8Tex, p, 0) * 255.0 + 0.5)` recovers the uploaded byte for every
 * value in `[0,255]` on every channel.
 */
export function probeExactByteFetch(gl: WebGL2RenderingContext): boolean {
  const saved = captureGlState(gl)

  const vs = buildShader(gl, gl.VERTEX_SHADER, FULLSCREEN_VS)
  const fs = buildShader(gl, gl.FRAGMENT_SHADER, EXACT_BYTE_FETCH_FS)
  const program: WebGLProgram | null = vs === null || fs === null ? null : gl.createProgram()
  const source: WebGLTexture | null = gl.createTexture()
  const destination: WebGLTexture | null = gl.createTexture()
  const framebuffer: WebGLFramebuffer | null = gl.createFramebuffer()
  const vao: WebGLVertexArrayObject | null = gl.createVertexArray()

  let ok = false

  if (
    vs !== null &&
    fs !== null &&
    program !== null &&
    source !== null &&
    destination !== null &&
    framebuffer !== null &&
    vao !== null
  ) {
    gl.attachShader(program, vs)
    gl.attachShader(program, fs)
    gl.linkProgram(program)

    if (gl.getProgramParameter(program, gl.LINK_STATUS) === true) {
      // n in every channel, for n in [0,255].
      const bytes = new Uint8Array(WIDTH * 4)
      for (let n = 0; n < WIDTH; n++) {
        bytes[n * 4] = n
        bytes[n * 4 + 1] = n
        bytes[n * 4 + 2] = n
        bytes[n * 4 + 3] = n
      }

      gl.bindTexture(gl.TEXTURE_2D, source)
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, WIDTH, 1)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, WIDTH, 1, gl.RGBA, gl.UNSIGNED_BYTE, bytes)

      gl.bindTexture(gl.TEXTURE_2D, destination)
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8UI, WIDTH, 1)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)

      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, framebuffer)
      gl.framebufferTexture2D(
        gl.DRAW_FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        destination,
        0,
      )

      if (gl.checkFramebufferStatus(gl.DRAW_FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE) {
        gl.bindVertexArray(vao)
        gl.useProgram(program)
        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, source)
        gl.uniform1i(gl.getUniformLocation(program, 'uSource'), 0)
        gl.viewport(0, 0, WIDTH, 1)
        // Integer targets are not clearable with gl.clear; a sentinel here would prove coverage,
        // but the triangle covers the whole viewport and the equality below already does.
        gl.drawArrays(gl.TRIANGLES, 0, 3)

        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, framebuffer)
        const out = new Uint8Array(WIDTH * 4)
        gl.readPixels(0, 0, WIDTH, 1, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, out)

        ok = gl.getError() === gl.NO_ERROR
        for (let i = 0; ok && i < out.length; i++) ok = out[i] === bytes[i]
      }
    }
  }

  if (vs !== null) gl.deleteShader(vs)
  if (fs !== null) gl.deleteShader(fs)
  if (program !== null) gl.deleteProgram(program)
  if (source !== null) gl.deleteTexture(source)
  if (destination !== null) gl.deleteTexture(destination)
  if (framebuffer !== null) gl.deleteFramebuffer(framebuffer)
  if (vao !== null) gl.deleteVertexArray(vao)

  restoreGlState(gl, saved)
  return ok
}
