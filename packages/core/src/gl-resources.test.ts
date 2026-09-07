import { describe, expect, it } from 'vitest'
import {
  drawTargetFor,
  FLOAT_FORMATS,
  INTEGER_FORMATS,
  TEXTURE_FORMAT_BYTES,
  TEXTURE_FORMAT_GL,
  textureBytes,
  type Target,
  type TextureFormat,
} from './gl-resources.js'
import { frontBytes } from './bytes.js'

describe('the format table (§8.7)', () => {
  it('carries exactly the formats §8.1 and §8.7 name, and never an sRGB one', () => {
    expect(Object.keys(TEXTURE_FORMAT_BYTES).sort()).toEqual([
      'R16F',
      'R8',
      'RG16F',
      'RGBA16F',
      'RGBA8',
      'RGBA8UI',
    ])
    // "never SRGB8_ALPHA8" (§7.4.1) is enforced by the union, not by a runtime check.
    expect(JSON.stringify(TEXTURE_FORMAT_BYTES)).not.toMatch(/SRGB|srgb/i)
  })

  it('prices every format, and agrees with P5 on RGBA8', () => {
    expect(TEXTURE_FORMAT_BYTES).toEqual({
      RGBA8: 4,
      RGBA8UI: 4,
      R8: 1,
      R16F: 2,
      RG16F: 4,
      RGBA16F: 8,
    })
    expect(textureBytes({ width: 326, height: 326, format: 'RGBA8' })).toBe(
      frontBytes({ w: 326, h: 326 }),
    )
  })

  it('names a GL enum, an upload format and an upload type for every format', () => {
    for (const format of Object.keys(TEXTURE_FORMAT_BYTES) as TextureFormat[]) {
      const entry = TEXTURE_FORMAT_GL[format]
      expect(typeof entry.internalFormat).toBe('string')
      expect(typeof entry.format).toBe('string')
      expect(typeof entry.type).toBe('string')
    }
  })

  it('marks the integer and float families, because each disallows something', () => {
    // An integer texture is not filterable, so LINEAR on one is a GlError (task 4).
    expect([...INTEGER_FORMATS]).toEqual(['RGBA8UI'])
    // A float attachment needs EXT_color_buffer_float, which is what caps.floatRT reports.
    expect([...FLOAT_FORMATS].sort()).toEqual(['R16F', 'RG16F', 'RGBA16F'])
  })

  it('freezes the tables, because a slot must not be able to reprice a format', () => {
    expect(Object.isFrozen(TEXTURE_FORMAT_BYTES)).toBe(true)
    expect(Object.isFrozen(TEXTURE_FORMAT_GL)).toBe(true)
  })
})

describe('drawTargetFor', () => {
  it('maps an offscreen target onto its whole self, viewport and dest alike (§5.1)', () => {
    const target = {
      framebuffer: {} as WebGLFramebuffer,
      texture: {
        handle: {} as WebGLTexture,
        width: 384,
        height: 366,
        format: 'RGBA8' as const,
        bytes: 562_176,
        label: 'artwork',
        dispose: () => undefined,
      },
      width: 384,
      height: 366,
      dispose: () => undefined,
    } satisfies Target

    const drawn = drawTargetFor(target)
    expect(drawn.framebuffer).toBe(target.framebuffer)
    expect(drawn.viewport).toEqual({ x: 0, y: 0, w: 384, h: 366 })
    // dest equals viewport here: an offscreen target has no view box inside it. A view's own
    // rect is P9's, and it never comes from this function.
    expect(drawn.dest).toEqual(drawn.viewport)
  })
})
