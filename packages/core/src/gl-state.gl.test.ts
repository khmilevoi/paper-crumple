import { afterEach, describe, expect, it } from 'vitest'
import { GlError } from './errors.js'
import { createGlContext } from './gl-context.js'
import { drawTargetFor } from './gl-resources.js'
import { FULLSCREEN_VS } from './gl-shaders.js'
import { captureGlState, pinAmbientState, restoreGlState, type GlState } from './gl-state.js'
import { createRawGl, type RawGl } from './testing/gl-fixture.js'

const TRIVIAL_FS = `#version 300 es
precision highp float;
out vec4 oColor;
void main() { oColor = vec4(1.0); }
`

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

  it('pins the readback side as well, because readPixels pads a row the way an upload does', () => {
    const gl = open()
    pinAmbientState(gl)
    // PACK_ALIGNMENT defaults to 4, and every byte this tier compares comes back through
    // readPixels. The 7x5 -> 11x3 case has 44-byte rows: divisible by 4, not by 8, so a slot
    // that left an 8 behind would pad every row and shift every byte after the first.
    expect(gl.getParameter(gl.PACK_ALIGNMENT)).toBe(1)
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

/**
 * Item by item, and by identity for the handles: `toEqual` sees two distinct `WebGLTexture`
 * objects as equal because neither has an own enumerable key, which is exactly the comparison a
 * wrong restore would slip through.
 */
function expectSameState(actual: GlState, expected: GlState): void {
  for (const key of Object.keys(expected) as Array<keyof GlState>) {
    const want = expected[key]
    if (typeof want === 'object' && want !== null && !Array.isArray(want)) {
      expect(actual[key], key).toBe(want)
    } else {
      expect(actual[key], key).toEqual(want)
    }
  }
}

describe('an owned context restores the pinned baseline without a query (§4.0, §5.1)', () => {
  it('leaves every enumerated item at the baseline after representative library work', () => {
    const gl = open()
    const ctx = createGlContext(gl, { owned: true })
    // A real 36-query capture, taken right after creation: what every scope exit must reproduce.
    const baseline = captureGlState(gl)

    const program = ctx.program(FULLSCREEN_VS, TRIVIAL_FS, 'work')
    const tex = ctx.texture({ width: 8, height: 8, format: 'RGBA8', label: 'work' })
    expect(program).not.toBeInstanceOf(GlError)
    expect(tex).not.toBeInstanceOf(GlError)
    if (GlError.is(program) || GlError.is(tex)) return
    const target = ctx.target(tex)
    expect(target).not.toBeInstanceOf(GlError)
    if (GlError.is(target)) return
    const vao = gl.createVertexArray()
    const sampler: WebGLSampler | null = gl.createSampler()
    const tex2dArray: WebGLTexture | null = gl.createTexture()
    const tex3d: WebGLTexture | null = gl.createTexture()
    const texCube: WebGLTexture | null = gl.createTexture()

    // Allocating outside any scope: only the library has written, and it put its binding back.
    expectSameState(captureGlState(gl), baseline)

    ctx.scope((s) => {
      // Every write the stage and the slots make inside a scope (stage.ts drawInto, motion
      // source.ts draw, paper gl-sdf.ts / paper-renderer.ts / artwork.ts), plus the ones only
      // the enumeration names, so a restore that forgot an item shows up below.
      s.bindTarget(drawTargetFor(target))
      // bindTarget's scissor box is the whole 8x8 target, which is the baseline's; move it.
      gl.scissor(1, 1, 2, 2)
      s.enable('SCISSOR_TEST', true)
      s.enable('DEPTH_TEST', true)
      s.enable('BLEND', true)
      s.enable('CULL_FACE', true)
      gl.useProgram(program.handle)
      gl.bindVertexArray(vao)
      // Unit 0 — the baseline's active unit — gets a binding on every target §5.1 restores and a
      // sampler; the active unit is then left on TEXTURE1, so the restore has to move back to
      // unit 0 before it rebinds, and every one of its five binding entries is exercised.
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, tex.handle)
      if (tex2dArray) gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex2dArray)
      if (tex3d) gl.bindTexture(gl.TEXTURE_3D, tex3d)
      if (texCube) gl.bindTexture(gl.TEXTURE_CUBE_MAP, texCube)
      if (sampler) gl.bindSampler(0, sampler)
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, tex.handle)
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, target.framebuffer)
      gl.enable(gl.STENCIL_TEST)
      gl.stencilMask(0x0f)
      gl.blendFuncSeparate(gl.ONE, gl.SRC_ALPHA, gl.DST_ALPHA, gl.ZERO)
      gl.depthFunc(gl.LEQUAL)
      gl.depthMask(false)
      gl.clearColor(0.25, 0.5, 0.75, 1)
      gl.clearDepth(0.125)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 8)
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 13)
      gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 2)
      gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 3)
      gl.pixelStorei(gl.UNPACK_IMAGE_HEIGHT, 5)
      gl.pixelStorei(gl.UNPACK_SKIP_IMAGES, 1)
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1)
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1)
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.BROWSER_DEFAULT_WEBGL)
      // An allocation mid-scope, the way gl-sdf.ts's pool does, restores its own binding only.
      const mid = ctx.texture({ width: 4, height: 4, format: 'R8', label: 'mid' })
      if (!GlError.is(mid)) ctx.target(mid)
      // A nested scope, the way motion.draw's sits inside drawInto's.
      ctx.scope(() => {
        gl.viewport(1, 1, 2, 2)
      })
    })

    expectSameState(captureGlState(gl), baseline)

    gl.deleteVertexArray(vao)
    gl.deleteSampler(sampler)
    gl.deleteTexture(tex2dArray)
    gl.deleteTexture(tex3d)
    gl.deleteTexture(texCube)
    ctx.dispose()
  })
})
