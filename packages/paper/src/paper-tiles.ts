/**
 * The neutral fallback and the four `R8` tile textures (§14, §14.1).
 *
 * **The derivation, re-done against this package's own convention (§14.1: "the constant must be
 * re-derived against whatever convention the tiles are stored in, not copied from the spike").**
 *
 * 1. **Every consumer of a tile sample is centred on 0.5.** `paper.js:1302` `(photo.rg * 2.0 -
 *    1.0)`; `:1321` `(photo.a - 0.5)`; `:1564` `mix(grainProc, grainPhoto, uPhotoFibre)` feeding
 *    `:1565` `1.0 + (grain - 0.5) * uGrain`; `:1644` `(sc.rg * 2.0 - 1.0)`; `:1648`
 *    `(sc.a - 0.5)`; `:1706` `(felt - 0.5)`. A sample of exactly 0.5 makes every one of them
 *    contribute nothing, which is what "the render with the photograph turned off" means.
 * 2. **The spike's `[128, 128, 255, 128]` does not achieve it, and that is the false claim §14.1
 *    names.** The spike uploads that texel as RGBA with a non-unit alpha, Chromium premultiplies
 *    the upload, and the shader reads `round(128 * 128 / 255) / 255 = 0.251`, i.e. a
 *    `(-0.5, -0.5)` tilt rather than a flat normal.
 * 3. **Four opaque grayscale `R8` tiles are immune to the hazard**: an image with no alpha
 *    channel has nothing to be premultiplied by, and an `R8` upload of one byte is read back as
 *    exactly `byte / 255`.
 * 4. **So the neutral is the byte nearest to 0.5 in each of the four planes: `128`.**
 *    `128 / 255 = 0.50196`, a residual tilt of `0.00392` against the spike's `-0.498` — 127x
 *    smaller, and the smallest an 8-bit plane admits, since 0.5 is not representable. Uploading
 *    `127` is equally far the other way; `128` is chosen so the sign of the residual matches the
 *    spike's own rounding of its intended neutral.
 */
import { attempt, GlError } from '@paper-crumple/core'
import type { Aborted } from '@paper-crumple/core'
import { ABORTED } from '@paper-crumple/core'
import type { GlContext, Texture } from '@paper-crumple/core/unstable'
import { uploadBytes } from '@paper-crumple/core/unstable'
import type { PaperTileSet } from './tile-set.js'

/** The 1x1 fallback byte for every one of the four planes. See the derivation above. */
export const NEUTRAL_TILE_BYTE = 128

/** `paper.js:1302` and `:1644`: a plane sample becomes a normal component as `x * 2 - 1`. */
export function tiltFromPlane(byte: number): number {
  return (byte / 255) * 2 - 1
}

/** `paper.js:1321`, `:1565`, `:1648`, `:1706`: a plane sample contributes as `x - 0.5`. */
export function detailFromPlane(byte: number): number {
  return byte / 255 - 0.5
}

export type TileName = keyof PaperTileSet

export const TILE_NAMES: readonly TileName[] = ['crumpleR', 'crumpleG', 'crumpleA', 'fibreA']

export interface MountedTiles {
  readonly crumpleR: Texture
  readonly crumpleG: Texture
  readonly crumpleA: Texture
  readonly fibreA: Texture
  dispose(): void
}

/**
 * Four 1x1 `R8` textures at the neutral byte. A render before the tiles land — or with
 * `tiles: null`, which is the default (§14) — is the render with the photograph turned off, and
 * under this convention that claim is finally true.
 *
 * `MIRRORED_REPEAT`, not `REPEAT` (`paper.js:2113-2115`): the tiles are high-passed crops of
 * photographs whose opposite edges do not match, and mirroring makes every seam continuous for
 * free. The mirror is invisible because nothing slower than a crease survives the high pass.
 */
export function mountNeutralTiles(ctx: GlContext): InstanceType<typeof GlError> | MountedTiles {
  const made: Partial<Record<TileName, Texture>> = {}
  const neutral = new Uint8Array([NEUTRAL_TILE_BYTE])
  for (const name of TILE_NAMES) {
    const texture = ctx.texture({
      width: 1,
      height: 1,
      format: 'R8',
      filter: 'LINEAR',
      wrap: 'REPEAT',
      label: `paper.tile.${name}`,
    })
    if (GlError.is(texture)) {
      for (const t of Object.values(made)) t.dispose()
      return texture
    }
    const uploaded = ctx.scope(() => uploadBytes(ctx.gl, texture, neutral))
    if (uploaded !== undefined) {
      texture.dispose()
      for (const t of Object.values(made)) t.dispose()
      return uploaded
    }
    made[name] = texture
  }
  // `TextureDesc.wrap` offers CLAMP_TO_EDGE and REPEAT only; MIRRORED_REPEAT is set here, once,
  // through the escape hatch §5.1 documents for exactly this kind of gap.
  ctx.scope(() => {
    const { gl } = ctx
    for (const name of TILE_NAMES) {
      gl.bindTexture(gl.TEXTURE_2D, made[name]!.handle)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.MIRRORED_REPEAT)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.MIRRORED_REPEAT)
    }
  })
  const tiles = made as Record<TileName, Texture>
  return {
    ...tiles,
    dispose() {
      for (const name of TILE_NAMES) tiles[name].dispose()
    },
  }
}

/** `core` exports the synchronous `attempt` only; `fetch` and `createImageBitmap` need its
 * asynchronous twin, so this file carries a four-line local one. It contains no `throw`, so it
 * needs no boundary-allowlist entry. */
async function attemptAsync<T>(fn: () => Promise<T>): Promise<T | Error> {
  try {
    return await fn()
  } catch (cause) {
    return cause instanceof Error ? cause : new Error(String(cause), { cause })
  }
}

/**
 * Fetch and decode the four tiles. `imageOrientation: 'flipY'` at decode time, never
 * `UNPACK_FLIP_Y_WEBGL`: the flag is **ignored** for an `ImageBitmap` source and honoured for a
 * canvas one, and the spike documents that trap where it cost it a mirrored field.
 */
export async function loadTileBitmaps(
  set: PaperTileSet,
  signal?: AbortSignal,
): Promise<InstanceType<typeof GlError> | Aborted | Record<TileName, ImageBitmap>> {
  const out: Partial<Record<TileName, ImageBitmap>> = {}
  for (const name of TILE_NAMES) {
    if (signal?.aborted === true) {
      for (const b of Object.values(out)) b.close()
      return ABORTED
    }
    const response = await attemptAsync(() => fetch(set[name], { signal }))
    if (response instanceof Error) {
      for (const b of Object.values(out)) b.close()
      return new GlError(`paper tile ${name}: ${response.message}`, { cause: response })
    }
    if (!response.ok) {
      for (const b of Object.values(out)) b.close()
      return new GlError(`paper tile ${name}: ${set[name].href} responded ${response.status}`)
    }
    const blob = await attemptAsync(() => response.blob())
    if (blob instanceof Error) {
      for (const b of Object.values(out)) b.close()
      return new GlError(`paper tile ${name}: ${blob.message}`, { cause: blob })
    }
    const bitmap = await attemptAsync(() =>
      createImageBitmap(blob, { imageOrientation: 'flipY', premultiplyAlpha: 'none' }),
    )
    if (bitmap instanceof Error) {
      for (const b of Object.values(out)) b.close()
      return new GlError(`paper tile ${name}: decode failed: ${bitmap.message}`, { cause: bitmap })
    }
    out[name] = bitmap
  }
  return out as Record<TileName, ImageBitmap>
}

/**
 * Replace the 1x1 neutral storage with the decoded 512x512 planes. `texStorage2D` is immutable,
 * so this disposes the neutral textures and allocates at the tile size; the caller swaps the
 * whole `MountedTiles` for the returned one.
 */
export function uploadTiles(
  ctx: GlContext,
  bitmaps: Record<TileName, ImageBitmap>,
): InstanceType<typeof GlError> | MountedTiles {
  const made: Partial<Record<TileName, Texture>> = {}
  for (const name of TILE_NAMES) {
    const bitmap = bitmaps[name]
    const texture = ctx.texture({
      width: bitmap.width,
      height: bitmap.height,
      format: 'R8',
      filter: 'LINEAR',
      wrap: 'REPEAT',
      label: `paper.tile.${name}`,
    })
    if (GlError.is(texture)) {
      for (const t of Object.values(made)) t.dispose()
      return texture
    }
    const failed = ctx.scope(() => {
      const { gl } = ctx
      return attempt(
        () => {
          gl.bindTexture(gl.TEXTURE_2D, texture.handle)
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.MIRRORED_REPEAT)
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.MIRRORED_REPEAT)
          gl.texSubImage2D(
            gl.TEXTURE_2D,
            0,
            0,
            0,
            bitmap.width,
            bitmap.height,
            gl.RED,
            gl.UNSIGNED_BYTE,
            bitmap,
          )
        },
        (cause) => new GlError(`paper tile ${name}: upload failed`, { cause }),
      )
    })
    if (failed instanceof Error) {
      texture.dispose()
      for (const t of Object.values(made)) t.dispose()
      return failed
    }
    made[name] = texture
  }
  const tiles = made as Record<TileName, Texture>
  return {
    ...tiles,
    dispose() {
      for (const name of TILE_NAMES) tiles[name].dispose()
    },
  }
}
