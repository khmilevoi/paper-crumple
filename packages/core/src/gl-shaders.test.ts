import { describe, expect, it } from 'vitest'
import { EXACT_BYTE_FETCH_FS, FULLSCREEN_VS } from './gl-shaders.js'

const SOURCES: readonly (readonly [string, string])[] = [
  ['FULLSCREEN_VS', FULLSCREEN_VS],
  ['EXACT_BYTE_FETCH_FS', EXACT_BYTE_FETCH_FS],
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
