/**
 * The two synthetic sources the level-2 front suites share (§11): the `front-identity` source and
 * the `front-holes` composite. Test-only, like `gl-fixture.ts` beside it: reachable from neither
 * `index.ts` nor `tiles.ts`, so it ships in no tarball, and a plain `.ts` file so several suites
 * can import it without Vitest collecting it as a suite. Raw bytes, never a PNG (§7.4.1). The
 * return types are inferred on purpose: this file is inside the TypeScript 5.0 floor check
 * (tests/typescript-50.test.ts), where typed arrays are not generic yet.
 */

/** The `front-identity` source's size. */
export const IDENTITY_SRC = { w: 40, h: 40 } as const

/** A deterministic source with a hard alpha edge and non-zero RGB under zero alpha. */
export function identitySourceBytes() {
  const out = new Uint8ClampedArray(IDENTITY_SRC.w * IDENTITY_SRC.h * 4)
  for (let y = 0; y < IDENTITY_SRC.h; y++) {
    for (let x = 0; x < IDENTITY_SRC.w; x++) {
      const p = (y * IDENTITY_SRC.w + x) * 4
      out[p] = (x * 6 + 1) % 256
      out[p + 1] = (y * 9 + 40) % 256
      out[p + 2] = (x * y * 3 + 17) % 256
      // Non-zero RGB survives under zero alpha only if nothing premultiplied on the way in.
      out[p + 3] = x < 6 || x > 33 || y < 6 || y > 33 ? 0 : 255
    }
  }
  return out
}

/** The canvas the `front-holes` composite is centred in — see that file's guard-band note. */
const S = 160
/** One component's box. */
const COMP_W = 32
const COMP_H = 48
/** The space between them — see `front-holes.gl.test.ts`'s header. Do not shrink this below ~24. */
const GAP = 32
/** The composite's own origin, centred in the canvas. */
const CX = Math.round((S - (2 * COMP_W + GAP)) / 2)
const CY = Math.round((S - COMP_H) / 2)
/** The hole, inside the left component. */
const HOLE_X = CX + 10
const HOLE_Y = CY + 16
const HOLE_W = 12
const HOLE_H = 16

/** The `front-holes` geometry, in canvas coordinates; every probe in that file derives from these. */
export const HOLES_FIXTURE = {
  S,
  COMP_W,
  COMP_H,
  GAP,
  CX,
  CY,
  HOLE_X,
  HOLE_Y,
  HOLE_W,
  HOLE_H,
} as const

/**
 * Two disjoint opaque squares — the "pair of sneakers" — the left one carrying a square hole.
 * With the constants above this paints, in canvas coordinates:
 *
 *   x in [32, 64)    y in [56, 104)   left component, opaque
 *   x in [42, 54)    y in [72, 88)    the hole inside it, alpha 0
 *   x in [96, 128)   y in [56, 104)   right component, opaque
 *
 * leaving x in [64, 96) as the gap and a 32px margin on either side of the composite.
 */
export function twoComponentsWithAHole() {
  const out = new Uint8ClampedArray(S * S * 4)
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const p = (y * S + x) * 4
      const inY = y >= CY && y < CY + COMP_H
      const left = x >= CX && x < CX + COMP_W && inY
      const hole = x >= HOLE_X && x < HOLE_X + HOLE_W && y >= HOLE_Y && y < HOLE_Y + HOLE_H
      const right = x >= CX + COMP_W + GAP && x < CX + 2 * COMP_W + GAP && inY
      out[p] = 30
      out[p + 1] = 160
      out[p + 2] = 90
      out[p + 3] = (left && !hole) || right ? 255 : 0
    }
  }
  return out
}
