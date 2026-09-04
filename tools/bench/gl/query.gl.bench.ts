/**
 * `gl.query.*` — what one synchronous GL query costs, per enum, and whether it drains the queue.
 *
 * `captureGlState` (`packages/core/src/gl-state.ts`) reads 31 `getParameter` enums and 5
 * `isEnabled` caps per `scope()`, and the Chrome trace of the playground put 806 ms of main-thread
 * time under those calls. Each enum here is called 1000 times, twice: `.idle` with nothing queued
 * (the pure call cost — a Blink-side answer, or an IPC round trip to the GPU process) and
 * `.queued` right after ten full-screen draws were issued without a flush (the same call when a
 * round trip has to wait for the queue ahead of it). The difference between the two rows is the
 * drain; a `.queued` row that stays flat is an enum Blink answers from its own state.
 *
 * `gl.query.scope.empty` is one `ctx.scope(() => {})` — a full `captureGlState` +
 * `restoreGlState` pair — x100; `gl.query.getError` and `gl.query.checkFramebufferStatus` are the
 * two ingest-path validations; `gl.query.finish.after10draws` is `gl.finish()` alone behind the
 * same ten draws, which is how the harness learnt that SwiftShader's `finish()` does not wait.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { FULLSCREEN_VS, GlError } from './deps.js'
import { flush, measure, openFixture } from './harness.js'

afterAll(flush)

const PARAMETERS = [
  'CURRENT_PROGRAM',
  'VERTEX_ARRAY_BINDING',
  'ACTIVE_TEXTURE',
  'TEXTURE_BINDING_2D',
  'TEXTURE_BINDING_2D_ARRAY',
  'TEXTURE_BINDING_3D',
  'TEXTURE_BINDING_CUBE_MAP',
  'SAMPLER_BINDING',
  'DRAW_FRAMEBUFFER_BINDING',
  'READ_FRAMEBUFFER_BINDING',
  'VIEWPORT',
  'SCISSOR_BOX',
  'STENCIL_WRITEMASK',
  'STENCIL_BACK_WRITEMASK',
  'BLEND_SRC_RGB',
  'BLEND_DST_RGB',
  'BLEND_SRC_ALPHA',
  'BLEND_DST_ALPHA',
  'DEPTH_FUNC',
  'DEPTH_WRITEMASK',
  'COLOR_CLEAR_VALUE',
  'DEPTH_CLEAR_VALUE',
  'UNPACK_ALIGNMENT',
  'UNPACK_ROW_LENGTH',
  'UNPACK_SKIP_ROWS',
  'UNPACK_SKIP_PIXELS',
  'UNPACK_IMAGE_HEIGHT',
  'UNPACK_SKIP_IMAGES',
  'UNPACK_FLIP_Y_WEBGL',
  'UNPACK_PREMULTIPLY_ALPHA_WEBGL',
  'UNPACK_COLORSPACE_CONVERSION_WEBGL',
] as const

const CAPS = ['SCISSOR_TEST', 'STENCIL_TEST', 'BLEND', 'DEPTH_TEST', 'CULL_FACE'] as const

/** Enough per-fragment work that ten of these at 512² are a visible queue on any GPU. */
const HEAVY_FS = `#version 300 es
precision highp float;
uniform sampler2D uTex;
out vec4 outColor;
void main() {
  vec2 uv = gl_FragCoord.xy / 512.0;
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 48; i++) {
    uv = fract(uv * 1.37 + texture(uTex, uv).xy * 0.01 + float(i) * 0.013);
    acc += texture(uTex, uv);
  }
  outColor = acc / 48.0;
}
`

const N = 1000

describe('gl.query', () => {
  it('gl.query.getParameter', async () => {
    const f = openFixture(512, 512)
    expect(f).not.toBeInstanceOf(Error)
    if (f instanceof Error) return
    const { gl, ctx } = f

    const program = ctx.program(FULLSCREEN_VS, HEAVY_FS, 'bench.heavy')
    expect(GlError.is(program)).toBe(false)
    if (GlError.is(program)) return
    const tex = ctx.texture({ width: 256, height: 256, format: 'RGBA8', label: 'bench.noise' })
    expect(GlError.is(tex)).toBe(false)
    if (GlError.is(tex)) return
    const target = ctx.target(tex)
    expect(GlError.is(target)).toBe(false)
    if (GlError.is(target)) return

    const queueTenDraws = (): void => {
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null)
      gl.viewport(0, 0, 512, 512)
      gl.useProgram(program.handle)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, tex.handle)
      gl.uniform1i(program.uniformLocation('uTex'), 0)
      for (let i = 0; i < 10; i++) gl.drawArrays(gl.TRIANGLES, 0, 3)
    }
    // `finish()` is not enough on SwiftShader (see the harness); the timer drain in `measure`
    // is what actually empties the queue between iterations, so `.idle` rows start empty.
    const idle = (): void => {
      gl.finish()
    }

    const queries: Array<[string, () => void]> = [
      ...PARAMETERS.map((name): [string, () => void] => [
        `gl.query.getParameter.${name}`,
        () => {
          const pname = gl[name]
          for (let i = 0; i < N; i++) gl.getParameter(pname)
        },
      ]),
      ...CAPS.map((name): [string, () => void] => [
        `gl.query.isEnabled.${name}`,
        () => {
          const cap = gl[name]
          for (let i = 0; i < N; i++) gl.isEnabled(cap)
        },
      ]),
      [
        'gl.query.getError',
        () => {
          for (let i = 0; i < N; i++) gl.getError()
        },
      ],
      [
        'gl.query.checkFramebufferStatus',
        () => {
          gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, target.framebuffer)
          for (let i = 0; i < N; i++) gl.checkFramebufferStatus(gl.DRAW_FRAMEBUFFER)
          gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null)
        },
      ],
      [
        'gl.query.scope.empty',
        () => {
          for (let i = 0; i < 100; i++) ctx.scope(() => undefined)
        },
      ],
    ]

    for (const [name, run] of queries) {
      const perCall = name === 'gl.query.scope.empty' ? 100 : N
      for (const [suffix, before] of [
        ['idle', idle],
        ['queued', queueTenDraws],
      ] as const) {
        await measure(`${name}.${suffix}`, {
          gl,
          timer: f.timer,
          iterations: 3,
          before,
          run,
          extra: () => ({ calls: perCall }),
        })
      }
    }

    await measure('gl.query.finish.after10draws', {
      gl,
      timer: f.timer,
      iterations: 3,
      before: queueTenDraws,
      run: () => gl.finish(),
      note: 'gl.finish() alone behind ten queued 512² draws; ~0 here means finish() did not wait for the rasteriser',
    })
    await measure('gl.query.draws10', {
      gl,
      timer: f.timer,
      iterations: 3,
      before: idle,
      run: queueTenDraws,
      note: 'the ten draws themselves: callMs is the issue cost, gpuMs is what a .queued query has to wait behind',
    })

    target.dispose()
    tex.dispose()
    program.dispose()
    f.dispose()
  })
})
