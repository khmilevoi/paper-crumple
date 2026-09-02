import { afterEach, describe, expect, it } from 'vitest'
import { GlError } from '@paper-crumple/core'
import { FULLSCREEN_VS } from '@paper-crumple/core/unstable'
import { createGlFixture, type PaperGlFixture } from './testing/gl-fixture.js'
import { MAX_FOLDS, PAPER_FS, PAPER_UNIFORMS } from './paper-shader.js'

let fixture: PaperGlFixture | null = null

afterEach(() => {
  // §4.0 caps live WebGL2 contexts at roughly sixteen and Vitest opens one page per file.
  fixture?.dispose()
  fixture = null
})

function open() {
  fixture = createGlFixture(8, 8)
  expect(fixture.gl, 'no WebGL2 context — check the SwiftShader launch flags (§11)').not.toBeNull()
  return fixture.ctx
}

describe('PAPER_FS', () => {
  it('compiles and links against core FULLSCREEN_VS', () => {
    const ctx = open()
    const program = ctx.program(FULLSCREEN_VS, PAPER_FS, 'paper')
    expect(GlError.is(program), GlError.is(program) ? program.message : '').toBe(false)
    if (GlError.is(program)) return
    program.dispose()
  })

  it('resolves every name PAPER_UNIFORMS declares', () => {
    const ctx = open()
    const program = ctx.program(FULLSCREEN_VS, PAPER_FS, 'paper')
    expect(GlError.is(program), GlError.is(program) ? program.message : '').toBe(false)
    if (GlError.is(program)) return
    const missing = Object.values(PAPER_UNIFORMS).filter(
      (name) => program.uniformLocation(name) === null,
    )
    expect(missing).toEqual([])
    program.dispose()
  })

  it('reads the artwork with texelFetch and never with LINEAR (spec 7.4.1)', () => {
    expect(PAPER_FS).toContain('usampler2D uImage')
    expect(PAPER_FS).toContain('texelFetch(uImage')
    expect(PAPER_FS).not.toContain('texture(uImage')
  })

  it('samples four R8 tile planes and no packed RGBA tile (spec 14)', () => {
    for (const name of ['uCrumpleR', 'uCrumpleG', 'uCrumpleA', 'uFibreA']) {
      expect(PAPER_FS).toContain(`uniform sampler2D ${name}`)
    }
    expect(PAPER_FS).not.toContain('uCrumpleTex')
    expect(PAPER_FS).not.toContain('uFibreTex')
  })

  it('declares highp int, because the fragment default would break the index arithmetic', () => {
    expect(PAPER_FS).toContain('precision highp int;')
  })

  it('keeps the fold model whole at MAX_FOLDS 12 (spec 15)', () => {
    expect(MAX_FOLDS).toBe(12)
    expect(PAPER_FS).toContain('#define MAX_FOLDS 12')
    expect(PAPER_FS).toContain('uFoldJitter')
    expect(PAPER_FS).toContain('uCrumpleFill')
    expect(PAPER_FS).toContain('uShadowBlur')
  })

  it('is the whole 1977-line shader, not an excerpt', () => {
    expect(PAPER_FS.split('\n').length).toBeGreaterThan(1900)
  })
})
