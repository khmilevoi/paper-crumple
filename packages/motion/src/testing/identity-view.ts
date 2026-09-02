/**
 * The `identityView` fixture (§7.4.2).
 *
 * **Test-only source.** Reachable from neither `index.ts` nor any pack subpath, so `tsdown` bundles
 * none of it and it ships in no tarball. A plain `.ts` file rather than a `.gl.test.ts` one, so a
 * suite can import it without Vitest collecting it as a suite of its own.
 *
 * §7.4.2 constrains this fixture exactly: an opaque rectangle at exactly a bucket aspect, centred
 * in a transparent field with an integer margin clearing the shader's guard band, so that
 * `stretch === 1`, `clamped === false`, cover-scale is exactly 1, `overscan` is forced to 0 (this
 * fixture builds its own front and never runs the sheet slot) and `A === (0, 0, w, h)` — the
 * artwork is the whole front, transparent field included.
 *
 * **The integer margin is load-bearing.** It is what puts every sample on a texel centre, so the
 * front's `LINEAR` filter returns the stored texel rather than a blend of two. A fractional margin
 * makes this fixture fail for a reason that has nothing to do with the shader.
 */
import type { Rect, SheetFront } from '@paper-crumple/core'

/** The front's side. A multiple of 64 (§7.4's `SIZE_QUANTUM`), so it is a size the design produces. */
export const IDENTITY_FRONT = 128
/** The opaque box's side. `IDENTITY_FRONT - 2 * IDENTITY_MARGIN`, and at aspect exactly 1. */
export const IDENTITY_BOX = 96
/** Integer, and the whole reason the sample lands on a texel centre. */
export const IDENTITY_MARGIN = 16

export interface IdentityView {
  readonly front: SheetFront
  /** The bbox to hand `MotionSource.fit()`. Exactly the `1x1` bucket's aspect. */
  readonly bbox: Rect
  readonly margin: number
  /** The front's texels, RGBA, row 0 first — the oracle the drawn frame is compared against. */
  readonly bytes: Uint8Array
  dispose(): void
}

/**
 * A deterministic, non-uniform interior: every channel varies, so a shader that returned a constant
 * would not pass. Alpha is 255 inside the box and 0 outside it, with no intermediate value — a
 * partially covered texel would be shaded by `discardCutoff` rather than by the identity path.
 */
function identityTexels(): Uint8Array {
  const out = new Uint8Array(IDENTITY_FRONT * IDENTITY_FRONT * 4)
  for (let y = 0; y < IDENTITY_FRONT; y++) {
    for (let x = 0; x < IDENTITY_FRONT; x++) {
      const p = (y * IDENTITY_FRONT + x) * 4
      const inside =
        x >= IDENTITY_MARGIN &&
        x < IDENTITY_MARGIN + IDENTITY_BOX &&
        y >= IDENTITY_MARGIN &&
        y < IDENTITY_MARGIN + IDENTITY_BOX
      out[p] = (x * 7 + 3) % 256
      out[p + 1] = (y * 13 + 29) % 256
      out[p + 2] = (x * y * 5 + 71) % 256
      out[p + 3] = inside ? 255 : 0
    }
  }
  return out
}

export function identityView(gl: WebGL2RenderingContext): IdentityView {
  const bytes = identityTexels()
  const texture = gl.createTexture() as WebGLTexture
  gl.bindTexture(gl.TEXTURE_2D, texture)
  // No flip: UNPACK_FLIP_Y_WEBGL is pinned off (§7.4.1), so row 0 of `bytes` is row 0 of the
  // texture is the first row `readPixels` returns.
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    IDENTITY_FRONT,
    IDENTITY_FRONT,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    bytes,
  )
  // LINEAR, matching the shipped front (§8.7). At cover-scale 1 with an integer margin every
  // sample lands on a texel centre, so LINEAR returns the stored texel exactly. Using NEAREST
  // here would make the test pass for a reason the real path does not have.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.bindTexture(gl.TEXTURE_2D, null)

  return {
    front: {
      texture,
      width: IDENTITY_FRONT,
      height: IDENTITY_FRONT,
      rect: { x: IDENTITY_MARGIN, y: IDENTITY_MARGIN, w: IDENTITY_BOX, h: IDENTITY_BOX },
      bytes: IDENTITY_FRONT * IDENTITY_FRONT * 4,
    },
    bbox: { x: IDENTITY_MARGIN, y: IDENTITY_MARGIN, w: IDENTITY_BOX, h: IDENTITY_BOX },
    margin: IDENTITY_MARGIN,
    bytes,
    dispose() {
      gl.deleteTexture(texture)
    },
  }
}
