/**
 * The GL resource shapes §5.1 names and never gives a shape, and the format decision of §8.7.
 *
 * Pure data and types: nothing here touches a `WebGL2RenderingContext` except `uploadBytes`,
 * which takes one as an argument. `gl-context.ts` is what allocates.
 */
import { GlError } from './errors.js'
import type { Rect } from './geometry.js'
import type { DrawTarget } from './gl.js'

/**
 * **RGBA8, no mipmaps, non-premultiplied** (§8.7), plus the field and mask formats §8.1 names.
 * `SRGB8_ALPHA8` is absent by construction (§7.4.1): a format that is not in this union cannot
 * be asked for, which is a stronger guarantee than a runtime rejection.
 */
export type TextureFormat = 'RGBA8' | 'RGBA8UI' | 'R8' | 'R16F' | 'RG16F' | 'RGBA16F'

/** Bytes per texel, per format. Frozen: a slot must not be able to reprice a format. */
export const TEXTURE_FORMAT_BYTES: Readonly<Record<TextureFormat, number>> = Object.freeze({
  RGBA8: 4,
  RGBA8UI: 4,
  R8: 1,
  R16F: 2,
  RG16F: 4,
  RGBA16F: 8,
})

/** The names of the three GL enums each format needs, resolved against a live context. */
export interface GlFormatNames {
  /** For `texStorage2D`. */
  readonly internalFormat: 'RGBA8' | 'RGBA8UI' | 'R8' | 'R16F' | 'RG16F' | 'RGBA16F'
  /** For `texSubImage2D`. */
  readonly format: 'RGBA' | 'RGBA_INTEGER' | 'RED' | 'RG'
  readonly type: 'UNSIGNED_BYTE' | 'HALF_FLOAT'
}

/**
 * Enum *names*, not values: the values live on the context and this module has none. Every
 * caller resolves them with `gl[names.internalFormat]`.
 */
export const TEXTURE_FORMAT_GL: Readonly<Record<TextureFormat, GlFormatNames>> = Object.freeze({
  RGBA8: { internalFormat: 'RGBA8', format: 'RGBA', type: 'UNSIGNED_BYTE' },
  RGBA8UI: { internalFormat: 'RGBA8UI', format: 'RGBA_INTEGER', type: 'UNSIGNED_BYTE' },
  R8: { internalFormat: 'R8', format: 'RED', type: 'UNSIGNED_BYTE' },
  R16F: { internalFormat: 'R16F', format: 'RED', type: 'HALF_FLOAT' },
  RG16F: { internalFormat: 'RG16F', format: 'RG', type: 'HALF_FLOAT' },
  RGBA16F: { internalFormat: 'RGBA16F', format: 'RGBA', type: 'HALF_FLOAT' },
} as const)

/** Integer textures are not filterable: `LINEAR` on one is a `GlError`, not a fallback. */
export const INTEGER_FORMATS: ReadonlySet<TextureFormat> = new Set<TextureFormat>(['RGBA8UI'])

/** Rendering into one of these needs `EXT_color_buffer_float`, which is `caps.floatRT`. */
export const FLOAT_FORMATS: ReadonlySet<TextureFormat> = new Set<TextureFormat>([
  'R16F',
  'RG16F',
  'RGBA16F',
])

/**
 * What `GlContext.texture` allocates from. **Immutable storage** (`texStorage2D`, one level):
 * §8.7 chooses per-sprite immutable textures over an array texture and over an atlas, and no
 * mipmaps anywhere.
 */
export interface TextureDesc {
  readonly width: number
  readonly height: number
  readonly format: TextureFormat
  /** Defaults to `NEAREST` for an integer format and `LINEAR` for everything else (§8.7). */
  readonly filter?: 'NEAREST' | 'LINEAR'
  /** Defaults to `CLAMP_TO_EDGE`. */
  readonly wrap?: 'CLAMP_TO_EDGE' | 'REPEAT'
  /** Carried into every `GlError` this texture produces. */
  readonly label?: string
}

/** A GPU texture handle, returned by `GlContext.texture`. */
export interface Texture {
  readonly handle: WebGLTexture
  readonly width: number
  readonly height: number
  readonly format: TextureFormat
  /** `textureBytes(desc)` — what this texture costs a pool. */
  readonly bytes: number
  readonly label: string
  dispose(): void
}

/** A render target over a `Texture`, returned by `GlContext.target`. */
export interface Target {
  readonly framebuffer: WebGLFramebuffer
  readonly texture: Texture
  readonly width: number
  readonly height: number
  dispose(): void
}

/** A compiled program handle, returned by `GlContext.program`. */
export interface Program {
  readonly handle: WebGLProgram
  readonly label: string
  /** Memoised. `null` when the uniform is absent or was optimised out. */
  uniformLocation(name: string): WebGLUniformLocation | null
  dispose(): void
}

/** What a texture of this description costs. */
export function textureBytes(d: Pick<TextureDesc, 'width' | 'height' | 'format'>): number {
  return d.width * d.height * TEXTURE_FORMAT_BYTES[d.format]
}

/**
 * A whole-target `DrawTarget` for an offscreen `Target`.
 *
 * `dest` equals `viewport` because an offscreen target has no view box inside it. A view's own
 * rect is P9's and never comes from here.
 */
export function drawTargetFor(t: Target): DrawTarget {
  const box: Rect = { x: 0, y: 0, w: t.width, h: t.height }
  return { framebuffer: t.framebuffer, viewport: box, dest: box }
}

/**
 * Upload tightly packed bytes over the whole of `t`.
 *
 * `UNPACK_ALIGNMENT` is pinned to 1 at context creation (`pinAmbientState`), so an `R8` row of
 * odd width uploads without padding. The caller is inside a `scope()` and this function leaves
 * the 2D binding on the active unit changed — which is inside §5.1's saved set.
 */
export function uploadBytes(
  gl: WebGL2RenderingContext,
  t: Texture,
  data: ArrayBufferView,
): InstanceType<typeof GlError> | undefined {
  const expected = textureBytes(t)
  if (data.byteLength !== expected) {
    return new GlError(
      `${t.label}: upload holds ${data.byteLength} bytes for ${t.width}x${t.height} ${t.format}, ` +
        `which needs ${expected}`,
    )
  }
  const names = TEXTURE_FORMAT_GL[t.format]
  gl.bindTexture(gl.TEXTURE_2D, t.handle)
  gl.texSubImage2D(
    gl.TEXTURE_2D,
    0,
    0,
    0,
    t.width,
    t.height,
    gl[names.format],
    gl[names.type],
    data,
  )
  return undefined
}
