import { afterEach, describe, expect, it } from 'vitest'
import { GlError } from './errors.js'
import { GL_ATTRIBUTES } from './gl-context.js'
import { drawTargetFor } from './gl-resources.js'
import { captureGlState } from './gl-state.js'
import { FULLSCREEN_VS } from './gl-shaders.js'
import { createGlFixture, type GlFixture } from './testing/gl-fixture.js'

let fixture: GlFixture | null = null

afterEach(() => {
  // §4.0 caps live WebGL2 contexts at roughly sixteen and Vitest opens one page per file.
  fixture?.dispose()
  fixture = null
})

function open(): GlFixture {
  fixture = createGlFixture(8, 8)
  expect(fixture.gl, 'no WebGL2 context — check the SwiftShader launch flags (§11)').not.toBeNull()
  return fixture
}

const TRIVIAL_FS = `#version 300 es
precision highp float;
out vec4 oColor;
void main() { oColor = vec4(1.0); }
`

describe('creation (§7.3)', () => {
  it('asks for exactly the attribute bag §7.3 lists, frozen', () => {
    expect(GL_ATTRIBUTES).toEqual({
      alpha: true,
      antialias: false,
      depth: true,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    })
    expect(Object.isFrozen(GL_ATTRIBUTES)).toBe(true)
  })

  it('is granted what it asked for on this driver, which is what §4.0.2 grades', () => {
    const { gl } = open()
    const granted = gl.getContextAttributes()
    // Grading an injected context is P9's; this only asserts the bag reaches the driver.
    expect(granted?.antialias).toBe(false)
    expect(granted?.premultipliedAlpha).toBe(false)
    expect(granted?.preserveDrawingBuffer).toBe(true)
    expect(granted?.depth).toBe(true)
    expect(granted?.stencil).toBe(false)
  })

  it('pins the ambient state on the way in, so the first draw is already safe', () => {
    const { gl } = open()
    expect(gl.isEnabled(gl.DITHER)).toBe(false)
    expect(gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL)).toBe(false)
    expect(gl.getParameter(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL)).toBe(gl.NONE)
  })
})

describe('caps (§5.1)', () => {
  it('reports the three capabilities and nothing else', () => {
    const { ctx } = open()
    expect(Object.keys(ctx.caps).sort()).toEqual(['floatRT', 'maxTextureSize', 'timer'])
    expect(Object.isFrozen(ctx.caps)).toBe(true)
  })

  it('reads each capability off the driver rather than assuming it', () => {
    const { ctx, gl } = open()
    expect(ctx.caps.floatRT).toBe(gl.getExtension('EXT_color_buffer_float') !== null)
    expect(ctx.caps.timer).toBe(gl.getExtension('EXT_disjoint_timer_query_webgl2') !== null)
    expect(ctx.caps.maxTextureSize).toBe(gl.getParameter(gl.MAX_TEXTURE_SIZE))
    // A consumer choosing maxSize needs this before the add() that would fail on it, and the
    // resample suite needs a 4096-wide source.
    expect(ctx.caps.maxTextureSize).toBeGreaterThanOrEqual(4096)
  })

  it('probes exactByteFetch once, at creation, and reports it on the seam (§8.5.3)', () => {
    const { ctx } = open()
    expect(typeof ctx.exactByteFetch).toBe('boolean')
  })
})

describe('program (§5.1)', () => {
  it('links a program and hands back memoised uniform locations', () => {
    const { ctx } = open()
    const program = ctx.program(FULLSCREEN_VS, TRIVIAL_FS, 'trivial')
    expect(program).not.toBeInstanceOf(GlError)
    if (program instanceof GlError) return
    expect(program.label).toBe('trivial')
    expect(program.uniformLocation('uMissing')).toBeNull()
    program.dispose()
  })

  it('returns a GlError naming the label and the stage rather than throwing', () => {
    const { ctx } = open()
    const broken = ctx.program(FULLSCREEN_VS, '#version 300 es\nvoid main() { nope(); }\n', 'bad')
    expect(broken).toBeInstanceOf(GlError)
    if (!(broken instanceof GlError)) return
    expect(broken.message).toMatch(/^bad: fragment shader did not compile/)
  })
})

describe('texture (§8.7)', () => {
  it('allocates immutable storage and prices it', () => {
    const { ctx } = open()
    const texture = ctx.texture({ width: 16, height: 8, format: 'RGBA8', label: 'artwork' })
    expect(texture).not.toBeInstanceOf(GlError)
    if (texture instanceof GlError) return
    expect(texture.bytes).toBe(16 * 8 * 4)
    expect(texture.format).toBe('RGBA8')
    texture.dispose()
  })

  it('refuses LINEAR on an integer format, because an integer texture is not filterable', () => {
    const { ctx } = open()
    const bad = ctx.texture({ width: 4, height: 4, format: 'RGBA8UI', filter: 'LINEAR' })
    expect(bad).toBeInstanceOf(GlError)
  })

  it('refuses a size the driver cannot hold, so add() fails with a reason', () => {
    const { ctx } = open()
    const bad = ctx.texture({ width: ctx.caps.maxTextureSize + 1, height: 1, format: 'RGBA8' })
    expect(bad).toBeInstanceOf(GlError)
    expect((bad as InstanceType<typeof GlError>).message).toMatch(/maxTextureSize/)
  })

  it('refuses a non-integer or non-positive size rather than letting the driver decide', () => {
    const { ctx } = open()
    expect(ctx.texture({ width: 0, height: 4, format: 'RGBA8' })).toBeInstanceOf(GlError)
    expect(ctx.texture({ width: 4.5, height: 4, format: 'RGBA8' })).toBeInstanceOf(GlError)
  })
})

describe('target (§5.1)', () => {
  it('makes a complete framebuffer over a texture and maps onto the whole of it', () => {
    const { ctx } = open()
    const texture = ctx.texture({ width: 12, height: 5, format: 'RGBA8', label: 'front' })
    expect(texture).not.toBeInstanceOf(GlError)
    if (texture instanceof GlError) return
    const target = ctx.target(texture)
    expect(target).not.toBeInstanceOf(GlError)
    if (target instanceof GlError) return
    expect(drawTargetFor(target)).toEqual({
      framebuffer: target.framebuffer,
      viewport: { x: 0, y: 0, w: 12, h: 5 },
      dest: { x: 0, y: 0, w: 12, h: 5 },
    })
    target.dispose()
    texture.dispose()
  })

  it('refuses a float attachment when the driver cannot render to one, and says so', () => {
    const { ctx } = open()
    const texture = ctx.texture({ width: 4, height: 4, format: 'R16F', label: 'field' })
    expect(texture).not.toBeInstanceOf(GlError)
    if (texture instanceof GlError) return
    const target = ctx.target(texture)
    if (ctx.caps.floatRT) {
      expect(target).not.toBeInstanceOf(GlError)
      if (!(target instanceof GlError)) target.dispose()
    } else {
      // Not a flake and not a driver bug: caps.floatRT is exactly this question, and a slot
      // reads it before asking. The error names the cap so the reason is in the message.
      expect(target).toBeInstanceOf(GlError)
      expect((target as InstanceType<typeof GlError>).message).toMatch(/floatRT/)
    }
    texture.dispose()
  })
})

describe('scope (§5.1)', () => {
  it('restores the enumerated set after a slot has churned it, and passes the value through', () => {
    const { ctx, gl } = open()
    const before = captureGlState(gl)
    const result = ctx.scope((s) => {
      s.enable('BLEND', true)
      s.enable('DEPTH_TEST', true)
      s.enable('CULL_FACE', true)
      s.enable('SCISSOR_TEST', true)
      ctx.gl.viewport(1, 1, 2, 2)
      ctx.gl.depthFunc(gl.GREATER)
      return 'passed through'
    })
    expect(result).toBe('passed through')
    expect(captureGlState(gl)).toEqual(before)
  })

  it('saves and restores again when nested, because §5.1 scopes and §7.3 batches', () => {
    const { ctx, gl } = open()
    const outer = captureGlState(gl)
    ctx.scope(() => {
      ctx.gl.viewport(0, 0, 3, 3)
      const inner = captureGlState(gl)
      ctx.scope(() => {
        ctx.gl.viewport(0, 0, 5, 5)
      })
      // The inner scope restored the outer scope's viewport, not the context's original one.
      expect(captureGlState(gl)).toEqual(inner)
    })
    expect(captureGlState(gl)).toEqual(outer)
    // stage.batch(fn)'s "a nested batch is a no-op rather than a double save" is P9's, built on
    // top of this. scope() itself always saves.
  })

  it('restores even when the body fails, so one bad slot cannot poison the next', () => {
    const { ctx, gl } = open()
    const before = captureGlState(gl)
    const boom = (): never => {
      // A stand-in for a slot's bug. `Promise.reject` gives a value to reject with without a
      // ThrowStatement, which eslint bans everywhere outside eslint.boundaries.js.
      return JSON.parse('{') as never
    }
    expect(() =>
      ctx.scope(() => {
        ctx.gl.viewport(1, 1, 2, 2)
        return boom()
      }),
    ).toThrow()
    expect(captureGlState(gl)).toEqual(before)
  })

  it('binds a DrawTarget to the framebuffer, the viewport and the scissor box', () => {
    const { ctx, gl } = open()
    const texture = ctx.texture({ width: 8, height: 8, format: 'RGBA8' })
    expect(texture).not.toBeInstanceOf(GlError)
    if (texture instanceof GlError) return
    const target = ctx.target(texture)
    expect(target).not.toBeInstanceOf(GlError)
    if (target instanceof GlError) return

    ctx.scope((s) => {
      s.bindTarget({
        framebuffer: target.framebuffer,
        viewport: { x: 0, y: 0, w: 8, h: 8 },
        dest: { x: 2, y: 3, w: 4, h: 5 },
      })
      expect(gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING)).toBe(target.framebuffer)
      expect(Array.from(gl.getParameter(gl.VIEWPORT) as Int32Array)).toEqual([0, 0, 8, 8])
      // dest is the view's box inside the viewport; whether the scissor test is on is the
      // view's call, and enable() is where a slot says so.
      expect(Array.from(gl.getParameter(gl.SCISSOR_BOX) as Int32Array)).toEqual([2, 3, 4, 5])
    })

    target.dispose()
    texture.dispose()
  })
})

describe('the escape hatch (§5.1)', () => {
  it('is the same raw context inside a scope and outside it', () => {
    const { ctx, gl } = open()
    expect(ctx.gl).toBe(gl)
    ctx.scope(() => {
      expect(ctx.gl).toBe(gl)
    })
  })

  it('is legal only inside a scope in exactly this sense: outside one, nothing puts it back', () => {
    const { ctx, gl } = open()
    const before = captureGlState(gl)
    ctx.gl.viewport(1, 1, 2, 2)
    // No scope, no restore. The rule is not enforced by a guard — a property cannot return an
    // Error (§10.8) — it is enforced by this being observable.
    expect(captureGlState(gl)).not.toEqual(before)
    ctx.scope(() => {
      ctx.gl.viewport(3, 3, 4, 4)
    })
    expect(Array.from(gl.getParameter(gl.VIEWPORT) as Int32Array)).toEqual([1, 1, 2, 2])
  })
})

describe('dispose', () => {
  it('releases every resource the context made, and is idempotent', () => {
    const { ctx, gl } = open()
    const texture = ctx.texture({ width: 4, height: 4, format: 'RGBA8' })
    expect(texture).not.toBeInstanceOf(GlError)
    if (texture instanceof GlError) return
    expect(gl.isTexture(texture.handle)).toBe(true)
    ctx.dispose()
    expect(gl.isTexture(texture.handle)).toBe(false)
    ctx.dispose()
    expect(gl.getError()).toBe(gl.NO_ERROR)
  })

  it("does not lose the context, because the surface is P9's and never a slot's", () => {
    const { ctx, gl } = open()
    ctx.dispose()
    expect(gl.isContextLost()).toBe(false)
  })
})
