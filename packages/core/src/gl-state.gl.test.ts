import { afterEach, describe, expect, it } from 'vitest'
import { captureGlState, pinAmbientState, restoreGlState } from './gl-state.js'
import { createRawGl, type RawGl } from './testing/gl-fixture.js'

let raw: RawGl | null = null

afterEach(() => {
  // §4.0's cap of roughly sixteen live contexts. Dispose, never re-run.
  raw?.dispose()
  raw = null
})

function open(): WebGL2RenderingContext {
  raw = createRawGl(8, 8)
  // A null here is the launch flags, not a library bug (§11).
  expect(raw.gl, 'no WebGL2 context — check --use-gl=angle --use-angle=swiftshader').not.toBeNull()
  return raw.gl
}

describe('pinAmbientState (§7.4.1)', () => {
  it('disables DITHER, which ES 3.0 enables by default and permits to alter a written value', () => {
    const gl = open()
    expect(gl.isEnabled(gl.DITHER)).toBe(true)
    pinAmbientState(gl)
    expect(gl.isEnabled(gl.DITHER)).toBe(false)
  })

  it('stops the browser colour-managing an upload, and never inherits the spike flip', () => {
    const gl = open()
    pinAmbientState(gl)
    expect(gl.getParameter(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL)).toBe(gl.NONE)
    // engine.js uploads with UNPACK_FLIP_Y_WEBGL true; inheriting it mirrors every comparison.
    expect(gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL)).toBe(false)
    // §8.7: the front is non-premultiplied, so the upload must not premultiply it either.
    expect(gl.getParameter(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL)).toBe(false)
    // A tightly packed R8 row of odd width needs alignment 1.
    expect(gl.getParameter(gl.UNPACK_ALIGNMENT)).toBe(1)
  })

  it('turns off everything §7.4.1 lists and opens the whole colour mask', () => {
    const gl = open()
    pinAmbientState(gl)
    for (const cap of [
      gl.BLEND,
      gl.SCISSOR_TEST,
      gl.DEPTH_TEST,
      gl.SAMPLE_COVERAGE,
      gl.SAMPLE_ALPHA_TO_COVERAGE,
    ]) {
      expect(gl.isEnabled(cap)).toBe(false)
    }
    expect(Array.from(gl.getParameter(gl.COLOR_WRITEMASK) as boolean[])).toEqual([
      true,
      true,
      true,
      true,
    ])
  })

  it('grants a single-sample surface, because §7.4.1 forbids a multisampled attachment', () => {
    const gl = open()
    expect(gl.getContextAttributes()?.antialias).toBe(false)
    expect(gl.getParameter(gl.SAMPLES)).toBe(0)
  })
})

describe('captureGlState / restoreGlState (§5.1)', () => {
  it('restores every item of the enumerated set after a scope has churned all of them', () => {
    const gl = open()
    pinAmbientState(gl)
    const before = captureGlState(gl)

    // Churn every enumerated item, so a missing field in GlState shows up as a diff below.
    const VS = `#version 300 es
void main() { gl_Position = vec4(0.0, 0.0, 0.0, 1.0); }
`
    const FS = `#version 300 es
precision highp float;
out vec4 oColor;
void main() { oColor = vec4(1.0); }
`
    const vShader: WebGLShader | null = gl.createShader(gl.VERTEX_SHADER)
    const fShader: WebGLShader | null = gl.createShader(gl.FRAGMENT_SHADER)
    if (vShader) gl.shaderSource(vShader, VS)
    if (fShader) gl.shaderSource(fShader, FS)
    if (vShader) gl.compileShader(vShader)
    if (fShader) gl.compileShader(fShader)
    const program: WebGLProgram | null = gl.createProgram()
    if (program && vShader && fShader) {
      gl.attachShader(program, vShader)
      gl.attachShader(program, fShader)
      gl.linkProgram(program)
      gl.useProgram(program)
    }

    const vao = gl.createVertexArray()
    const fbo = gl.createFramebuffer()
    const tex = gl.createTexture()
    const sampler: WebGLSampler | null = gl.createSampler()
    const tex2dArray: WebGLTexture | null = gl.createTexture()
    const tex3d: WebGLTexture | null = gl.createTexture()
    const texCube: WebGLTexture | null = gl.createTexture()

    gl.bindVertexArray(vao)
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fbo)
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fbo)
    // These five bindings must land on unit 0, the unit active when `before` was captured,
    // because §5.1's saved set is "the active texture unit and its bindings" — a binding
    // on any other unit is deliberately outside the saved set.
    gl.bindTexture(gl.TEXTURE_2D, tex)
    if (sampler) gl.bindSampler(0, sampler)
    if (tex2dArray) gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex2dArray)
    if (tex3d) gl.bindTexture(gl.TEXTURE_3D, tex3d)
    if (texCube) gl.bindTexture(gl.TEXTURE_CUBE_MAP, texCube)
    gl.activeTexture(gl.TEXTURE0 + 2)

    gl.viewport(1, 2, 3, 4)
    gl.scissor(5, 6, 7, 8)
    gl.enable(gl.SCISSOR_TEST)
    gl.enable(gl.STENCIL_TEST)
    gl.stencilMask(0x0f)
    gl.enable(gl.BLEND)
    gl.blendFuncSeparate(gl.ONE, gl.SRC_ALPHA, gl.DST_ALPHA, gl.ZERO)
    gl.enable(gl.DEPTH_TEST)
    gl.depthFunc(gl.GREATER)
    gl.depthMask(false)
    gl.enable(gl.CULL_FACE)
    gl.clearColor(0.25, 0.5, 0.75, 1)
    gl.clearDepth(0.125)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 8)
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 13)
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 2)
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 3)
    gl.pixelStorei(gl.UNPACK_IMAGE_HEIGHT, 5)
    gl.pixelStorei(gl.UNPACK_SKIP_IMAGES, 1)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1)
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.BROWSER_DEFAULT_WEBGL)

    restoreGlState(gl, before)
    expect(captureGlState(gl)).toEqual(before)

    gl.deleteProgram(program)
    gl.deleteSampler(sampler)
    gl.deleteVertexArray(vao)
    gl.deleteFramebuffer(fbo)
    gl.deleteTexture(tex)
    gl.deleteTexture(tex2dArray)
    gl.deleteTexture(tex3d)
    gl.deleteTexture(texCube)
    if (vShader) gl.deleteShader(vShader)
    if (fShader) gl.deleteShader(fShader)
  })

  it('restores exactly the enumerated set and nothing outside it, which is the point of "exactly"', () => {
    const gl = open()
    pinAmbientState(gl)
    const before = captureGlState(gl)

    // Outside §5.1's list on purpose: a binding on a texture unit that is not the active one,
    // and a rasteriser state the enumeration does not mention.
    const other = gl.createTexture()
    gl.activeTexture(gl.TEXTURE0 + 3)
    gl.bindTexture(gl.TEXTURE_2D, other)
    gl.activeTexture(gl.TEXTURE0)
    gl.enable(gl.POLYGON_OFFSET_FILL)

    restoreGlState(gl, before)

    // Still set: the enumeration says "the active texture unit and its bindings", singular, and
    // POLYGON_OFFSET_FILL is not on the list at all. A scope that restored these would be
    // restoring more than §5.1 enumerates.
    gl.activeTexture(gl.TEXTURE0 + 3)
    expect(gl.getParameter(gl.TEXTURE_BINDING_2D)).toBe(other)
    gl.activeTexture(gl.TEXTURE0)
    expect(gl.isEnabled(gl.POLYGON_OFFSET_FILL)).toBe(true)

    gl.disable(gl.POLYGON_OFFSET_FILL)
    gl.deleteTexture(other)
  })

  it('restores the read framebuffer as well as the draw one, because "framebuffer" is both', () => {
    const gl = open()
    const before = captureGlState(gl)
    const fbo = gl.createFramebuffer()
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fbo)
    restoreGlState(gl, before)
    expect(gl.getParameter(gl.READ_FRAMEBUFFER_BINDING)).toBeNull()
    gl.deleteFramebuffer(fbo)
  })
})
