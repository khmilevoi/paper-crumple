import { GlError } from '@paper-crumple/core'
import { afterEach, describe, expect, it } from 'vitest'

import pack2x3 from './packs/2x3.js'
import { bakedMotion, type BakedFit } from './source.js'
import { createGlFixture, type GlFixture } from './testing/gl-fixture.js'

let fixture: GlFixture | null = null

afterEach(() => {
  // §4.0 caps live WebGL2 contexts at roughly sixteen and Vitest opens one page per file.
  fixture?.dispose()
  fixture = null
})

function open(): GlFixture {
  fixture = createGlFixture(64, 64)
  expect(fixture.gl, 'no WebGL2 context — check the SwiftShader launch flags (§11)').not.toBeNull()
  return fixture
}

describe('mount (§5.1, §5.3)', () => {
  it('compiles the sheet program and returns undefined', () => {
    const f = open()
    const s = bakedMotion({ packs: [pack2x3] })
    expect(s.mount(f.ctx)).toBeUndefined()
    s.dispose()
  })

  it('refuses a second mount rather than leaking the first program', () => {
    const f = open()
    const s = bakedMotion({ packs: [pack2x3] })
    s.mount(f.ctx)
    expect(GlError.is(s.mount(f.ctx))).toBe(true)
    s.dispose()
  })

  it('leaves the context state it found: mount touches nothing scope did not save', () => {
    const f = open()
    const { gl } = f
    const before = {
      program: gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null,
      vao: gl.getParameter(gl.VERTEX_ARRAY_BINDING) as WebGLVertexArrayObject | null,
      texture: gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null,
    }
    const s = bakedMotion({ packs: [pack2x3] })
    expect(s.mount(f.ctx)).toBeUndefined()
    expect(gl.getParameter(gl.CURRENT_PROGRAM)).toBe(before.program)
    expect(gl.getParameter(gl.VERTEX_ARRAY_BINDING)).toBe(before.vao)
    expect(gl.getParameter(gl.TEXTURE_BINDING_2D)).toBe(before.texture)
    expect(gl.getError()).toBe(gl.NO_ERROR)
    s.dispose()
  })

  it('is disposable twice, and disposes what it mounted', () => {
    const f = open()
    const s = bakedMotion({ packs: [pack2x3] })
    s.mount(f.ctx)
    s.dispose()
    s.dispose()
    expect(f.gl.getError()).toBe(f.gl.NO_ERROR)
  })
})

describe('load in the browser (§14)', () => {
  it('reaches the binary through binUrl, with no cache: no-store', async () => {
    const f = open()
    const s = bakedMotion({ packs: [pack2x3] })
    expect(s.mount(f.ctx)).toBeUndefined()
    const fit = s.fit({ x: 0, y: 0, w: 256, h: 384 })
    expect(fit).not.toBeInstanceOf(Error)
    const clip = await s.load(fit as BakedFit)
    expect(clip).not.toBeInstanceOf(Error)
    expect(clip).toMatchObject({ frameCount: 12, keyFrames: [0, 2, 4, 6, 8, 11] })
    s.dispose()
  })
})
