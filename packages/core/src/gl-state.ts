/**
 * §5.1's enumerated GL state, and §7.4.1's one-time ambient pins.
 *
 * **The saved set is exactly what §5.1 enumerates** — program, VAO, active texture unit and its
 * bindings, framebuffer, viewport, scissor box and `SCISSOR_TEST`, `STENCIL_TEST` and the stencil
 * mask, `BLEND` and its function, `DEPTH_TEST` / `depthFunc` / `depthMask`, `CULL_FACE`, clear
 * colour and depth, and the `pixelStorei` unpack flags. Not more, and not less. Two readings are
 * written down because a reader will wonder:
 *
 * - "the active texture unit **and its bindings**" is the bindings on that one unit. A scope that
 *   binds on another unit leaks that binding, deliberately: restoring all thirty-two units would
 *   be restoring more than the enumeration names, and it would cost thirty-two `getParameter`
 *   round trips per scope.
 * - "framebuffer" is both halves of WebGL2's split binding. Restoring only `DRAW_FRAMEBUFFER`
 *   would leak `READ_FRAMEBUFFER`, and a leaked read binding silently redirects the next
 *   `readPixels` — which is the one instrument this whole tier depends on.
 *
 * The blend *equation* is absent because §5.1 says "`BLEND` and its function".
 */

/** The state one `scope()` saves. Every field is one item of §5.1's enumeration. */
export interface GlState {
  readonly program: WebGLProgram | null
  readonly vertexArray: WebGLVertexArrayObject | null
  readonly activeTexture: number
  readonly texture2d: WebGLTexture | null
  readonly texture2dArray: WebGLTexture | null
  readonly texture3d: WebGLTexture | null
  readonly textureCube: WebGLTexture | null
  readonly sampler: WebGLSampler | null
  readonly drawFramebuffer: WebGLFramebuffer | null
  readonly readFramebuffer: WebGLFramebuffer | null
  readonly viewport: readonly [number, number, number, number]
  readonly scissorBox: readonly [number, number, number, number]
  readonly scissorTest: boolean
  readonly stencilTest: boolean
  readonly stencilWriteMask: number
  readonly stencilBackWriteMask: number
  readonly blend: boolean
  readonly blendSrcRgb: number
  readonly blendDstRgb: number
  readonly blendSrcAlpha: number
  readonly blendDstAlpha: number
  readonly depthTest: boolean
  readonly depthFunc: number
  readonly depthMask: boolean
  readonly cullFace: boolean
  readonly clearColor: readonly [number, number, number, number]
  readonly clearDepth: number
  readonly unpackAlignment: number
  readonly unpackRowLength: number
  readonly unpackSkipRows: number
  readonly unpackSkipPixels: number
  readonly unpackImageHeight: number
  readonly unpackSkipImages: number
  readonly unpackFlipY: boolean
  readonly unpackPremultiplyAlpha: boolean
  readonly unpackColorspaceConversion: number
}

function four(value: unknown): readonly [number, number, number, number] {
  const a = value as ArrayLike<number>
  return [a[0], a[1], a[2], a[3]]
}

/** Read §5.1's enumerated set off the context. */
export function captureGlState(gl: WebGL2RenderingContext): GlState {
  return {
    program: gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null,
    vertexArray: gl.getParameter(gl.VERTEX_ARRAY_BINDING) as WebGLVertexArrayObject | null,
    activeTexture: gl.getParameter(gl.ACTIVE_TEXTURE) as number,
    texture2d: gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null,
    texture2dArray: gl.getParameter(gl.TEXTURE_BINDING_2D_ARRAY) as WebGLTexture | null,
    texture3d: gl.getParameter(gl.TEXTURE_BINDING_3D) as WebGLTexture | null,
    textureCube: gl.getParameter(gl.TEXTURE_BINDING_CUBE_MAP) as WebGLTexture | null,
    sampler: gl.getParameter(gl.SAMPLER_BINDING) as WebGLSampler | null,
    drawFramebuffer: gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null,
    readFramebuffer: gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null,
    viewport: four(gl.getParameter(gl.VIEWPORT)),
    scissorBox: four(gl.getParameter(gl.SCISSOR_BOX)),
    scissorTest: gl.isEnabled(gl.SCISSOR_TEST),
    stencilTest: gl.isEnabled(gl.STENCIL_TEST),
    stencilWriteMask: gl.getParameter(gl.STENCIL_WRITEMASK) as number,
    stencilBackWriteMask: gl.getParameter(gl.STENCIL_BACK_WRITEMASK) as number,
    blend: gl.isEnabled(gl.BLEND),
    blendSrcRgb: gl.getParameter(gl.BLEND_SRC_RGB) as number,
    blendDstRgb: gl.getParameter(gl.BLEND_DST_RGB) as number,
    blendSrcAlpha: gl.getParameter(gl.BLEND_SRC_ALPHA) as number,
    blendDstAlpha: gl.getParameter(gl.BLEND_DST_ALPHA) as number,
    depthTest: gl.isEnabled(gl.DEPTH_TEST),
    depthFunc: gl.getParameter(gl.DEPTH_FUNC) as number,
    depthMask: gl.getParameter(gl.DEPTH_WRITEMASK) as boolean,
    cullFace: gl.isEnabled(gl.CULL_FACE),
    clearColor: four(gl.getParameter(gl.COLOR_CLEAR_VALUE)),
    clearDepth: gl.getParameter(gl.DEPTH_CLEAR_VALUE) as number,
    unpackAlignment: gl.getParameter(gl.UNPACK_ALIGNMENT) as number,
    unpackRowLength: gl.getParameter(gl.UNPACK_ROW_LENGTH) as number,
    unpackSkipRows: gl.getParameter(gl.UNPACK_SKIP_ROWS) as number,
    unpackSkipPixels: gl.getParameter(gl.UNPACK_SKIP_PIXELS) as number,
    unpackImageHeight: gl.getParameter(gl.UNPACK_IMAGE_HEIGHT) as number,
    unpackSkipImages: gl.getParameter(gl.UNPACK_SKIP_IMAGES) as number,
    unpackFlipY: gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL) as boolean,
    unpackPremultiplyAlpha: gl.getParameter(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL) as boolean,
    unpackColorspaceConversion: gl.getParameter(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL) as number,
  }
}

function setEnabled(gl: WebGL2RenderingContext, cap: number, on: boolean): void {
  if (on) gl.enable(cap)
  else gl.disable(cap)
}

/** Put §5.1's enumerated set back, and nothing else. */
export function restoreGlState(gl: WebGL2RenderingContext, s: GlState): void {
  gl.useProgram(s.program)
  gl.bindVertexArray(s.vertexArray)

  // The active unit first, so the bindings below land on the unit they were read from.
  gl.activeTexture(s.activeTexture)
  gl.bindTexture(gl.TEXTURE_2D, s.texture2d)
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, s.texture2dArray)
  gl.bindTexture(gl.TEXTURE_3D, s.texture3d)
  gl.bindTexture(gl.TEXTURE_CUBE_MAP, s.textureCube)
  gl.bindSampler(s.activeTexture - gl.TEXTURE0, s.sampler)

  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, s.drawFramebuffer)
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, s.readFramebuffer)

  gl.viewport(s.viewport[0], s.viewport[1], s.viewport[2], s.viewport[3])
  gl.scissor(s.scissorBox[0], s.scissorBox[1], s.scissorBox[2], s.scissorBox[3])
  setEnabled(gl, gl.SCISSOR_TEST, s.scissorTest)

  setEnabled(gl, gl.STENCIL_TEST, s.stencilTest)
  gl.stencilMaskSeparate(gl.FRONT, s.stencilWriteMask)
  gl.stencilMaskSeparate(gl.BACK, s.stencilBackWriteMask)

  setEnabled(gl, gl.BLEND, s.blend)
  gl.blendFuncSeparate(s.blendSrcRgb, s.blendDstRgb, s.blendSrcAlpha, s.blendDstAlpha)

  setEnabled(gl, gl.DEPTH_TEST, s.depthTest)
  gl.depthFunc(s.depthFunc)
  gl.depthMask(s.depthMask)

  setEnabled(gl, gl.CULL_FACE, s.cullFace)

  gl.clearColor(s.clearColor[0], s.clearColor[1], s.clearColor[2], s.clearColor[3])
  gl.clearDepth(s.clearDepth)

  gl.pixelStorei(gl.UNPACK_ALIGNMENT, s.unpackAlignment)
  gl.pixelStorei(gl.UNPACK_ROW_LENGTH, s.unpackRowLength)
  gl.pixelStorei(gl.UNPACK_SKIP_ROWS, s.unpackSkipRows)
  gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, s.unpackSkipPixels)
  gl.pixelStorei(gl.UNPACK_IMAGE_HEIGHT, s.unpackImageHeight)
  gl.pixelStorei(gl.UNPACK_SKIP_IMAGES, s.unpackSkipImages)
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, s.unpackFlipY ? 1 : 0)
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, s.unpackPremultiplyAlpha ? 1 : 0)
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, s.unpackColorspaceConversion)
}

/**
 * The state that silently corrupts a byte, pinned once at context creation and never touched
 * again (§7.4.1).
 *
 * `DITHER` is not in §5.1's saved set on purpose: it is pinned, not scoped. A slot that re-enables
 * it is a slot that is wrong, and no `scope()` will put it back.
 */
export function pinAmbientState(gl: WebGL2RenderingContext): void {
  // ES 3.0 enables DITHER by default and permits it to alter the written value.
  gl.disable(gl.DITHER)
  // Defaults to BROWSER_DEFAULT_WEBGL, which colour-manages the upload.
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE)
  // engine.js uploads with this true; do not inherit it.
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0)
  // §8.7: the front is non-premultiplied, and the premultiply this filter does is its own (§7.4.1).
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0)
  // Tightly packed rows: an R8 mask of odd width has no padding.
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
  // The mirror of the pin above on the readback side. `readPixels` pads its rows to
  // PACK_ALIGNMENT, which defaults to 4, and every byte this tier compares comes back through it.
  gl.pixelStorei(gl.PACK_ALIGNMENT, 1)

  gl.disable(gl.BLEND)
  gl.disable(gl.SCISSOR_TEST)
  gl.disable(gl.DEPTH_TEST)
  gl.disable(gl.SAMPLE_COVERAGE)
  gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE)
  gl.colorMask(true, true, true, true)
}
