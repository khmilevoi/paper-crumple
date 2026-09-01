import { describe, expect, it } from 'vitest'
import { EXACT_BYTE_FETCH_FS, FULLSCREEN_VS, RESAMPLE_FS, RESAMPLE_UNIFORMS } from './gl-shaders.js'
import { RESAMPLE_Q, RESAMPLE_T } from './resample.js'

const SOURCES: readonly (readonly [string, string])[] = [
  ['FULLSCREEN_VS', FULLSCREEN_VS],
  ['EXACT_BYTE_FETCH_FS', EXACT_BYTE_FETCH_FS],
  ['RESAMPLE_FS', RESAMPLE_FS],
]

describe('every GLSL source in the package', () => {
  it('opens with the version line, with nothing at all in front of it', () => {
    // A template literal that starts on the next line puts a newline before #version, and
    // GLSL ES 3.00 rejects that with a message about the ES 1.00 default.
    for (const [name, source] of SOURCES) {
      expect(source.startsWith('#version 300 es\n'), `${name} does not open with #version`).toBe(
        true,
      )
    }
  })

  it('ends with a newline, so a driver never sees an unterminated final line', () => {
    for (const [name, source] of SOURCES) {
      expect(source.endsWith('\n'), `${name} does not end with a newline`).toBe(true)
    }
  })
})

describe('EXACT_BYTE_FETCH_FS (§8.5.3)', () => {
  it('is the recovery expression the specification writes, not an approximation of it', () => {
    expect(EXACT_BYTE_FETCH_FS).toMatch(/uvec4\(texelFetch\(uSource, p, 0\) \* 255\.0 \+ 0\.5\)/)
  })

  it('writes an unsigned integer output, because the target is RGBA8UI', () => {
    expect(EXACT_BYTE_FETCH_FS).toMatch(/out uvec4 oColor;/)
  })

  it('declares highp int, because the fragment default is mediump (§7.4.1)', () => {
    expect(EXACT_BYTE_FETCH_FS).toMatch(/^precision highp int;$/m)
  })
})

describe('RESAMPLE_FS — the GLSL twin of identityResample (§7.4.1)', () => {
  it('declares highp int, without which the fragment default mediump breaks the index maths', () => {
    expect(RESAMPLE_FS).toMatch(/^precision highp int;$/m)
  })

  it('reads a usampler2D, which is the normative source form and the fallback (§8.5.3)', () => {
    expect(RESAMPLE_FS).toMatch(/uniform highp usampler2D uSource;/)
    expect(RESAMPLE_FS).toMatch(/out uvec4 oColor;/)
  })

  it("carries the reference's quantisation, so the two cannot drift apart silently", () => {
    expect(RESAMPLE_FS).toMatch(new RegExp(`const int Q = ${RESAMPLE_Q};`))
    expect(RESAMPLE_FS).toMatch(new RegExp(`const uint T = ${RESAMPLE_T}u;`))
  })

  it('has no clamp and no min against 255, because §7.4.1 says clamping never fires', () => {
    // "Clamping never fires and must not be written as a safety net." A shader that needs one
    // is wrong, and a shader that has one hides being wrong.
    expect(RESAMPLE_FS).not.toMatch(/\bclamp\s*\(/)
    expect(RESAMPLE_FS).not.toMatch(/255u/)
  })

  it('rounds in exactly four places per texel, and divides RGB by the unrounded Sa', () => {
    // Four roundings execute per texel — A, R, G, B (§7.4.1 step 4) — written as seven call
    // sites because RGB each carry the `Sa = 0` alternative, plus one definition: eight.
    expect(RESAMPLE_FS.match(/roundDivU\(/g)?.length).toBe(8)
    expect(RESAMPLE_FS).toMatch(/roundDivU\(sr, sa\)/)
    expect(RESAMPLE_FS).toMatch(/roundDivU\(sa, T\)/)
    // The Sa = 0 branch preserves the matte colour rather than inventing one.
    expect(RESAMPLE_FS).toMatch(/roundDivU\(ur, T\)/)
  })

  it('flips nothing: the reference row index is the texture row and the framebuffer row', () => {
    // int(gl_FragCoord.y) and no dstH - 1 - y anywhere. UNPACK_FLIP_Y_WEBGL is pinned off, so
    // reference row 0 is texture row 0 is the first row readPixels returns.
    expect(RESAMPLE_FS).toMatch(/int oy = int\(gl_FragCoord\.y\);/)
    expect(RESAMPLE_FS).not.toMatch(/- 1 - o[xy]/)
  })

  it('names its three uniforms once, so the test and the shader cannot disagree', () => {
    expect(RESAMPLE_UNIFORMS).toEqual({ source: 'uSource', srcRect: 'uSrcRect', dst: 'uDstSize' })
    for (const name of Object.values(RESAMPLE_UNIFORMS)) {
      expect(RESAMPLE_FS).toContain(name)
    }
  })
})
