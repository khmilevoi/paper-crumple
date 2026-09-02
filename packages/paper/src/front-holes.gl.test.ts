/**
 * # `holes`, at level 2 (§11, §8.2)
 *
 * §11 moves `identity` and `holes` to this tier because "both compare pixels rather than judging
 * appearance". P8's level-1 tests of `extractContours` and the mask utilities are a different
 * thing and are not replaced by this file.
 *
 * The property under test is §8.2's: only OUTER loops are kept, but **every one of them**, so a
 * source with two disjoint components gets two pieces of paper — and a hole inside a component
 * stays a hole rather than being filled by the paper that surrounds it.
 *
 * ## Probe coordinates — corrected against the fixture's own geometry
 *
 * Expressed relative to the *unpadded* geometry (before `PAD` below is added), the fixture places
 * the left component at `x in [8,40)`, `y in [24,72)`, its hole at `x in [18,30)`, `y in [40,56)`,
 * and the right component at `x in [56,88)`, `y in [24,72)`. `(24, 48)` and `(24, 47)` both fall
 * *inside* the hole (18 <= 24 < 30 and 40 <= 48 < 56, and y = 47 is still within [40,56)) — they
 * are not on the left component's own paper at all. So:
 *
 * - The "left component carries paper" probe is at `(12, 48)`: inside the left component's rect
 *   and strictly left of the hole's `x >= 18`, so it reads the component and nothing else.
 * - The hole probes keep their original coordinates (they are correctly inside the hole) but their
 *   matcher is inverted to `toBeLessThan(64)` — the same "this is not paper" bound the gap probe
 *   already uses. A hole that is filled by the surrounding paper reads high alpha there; a hole
 *   that survives reads low alpha. The step this file follows says a closed hole is fixed by
 *   widening the fixture, never by loosening the assertion — which only makes sense if "the hole
 *   survives" is read off a low-alpha probe, not a high one.
 *
 * ## Canvas padding — required by the guard-band check, not by the hole
 *
 * The unpadded geometry above sits in a 96x96 canvas (`S = 96`, `PAD = 0`) and, measured directly,
 * that size fails before the hole assertions are ever reached: `source()` itself returns a
 * `SheetError` from the shipped guard-band check (§8.6, `packages/core/src/overscan.ts`'s
 * `checkGuardBand`) — "the hull reaches 0.4828 of the front on axis x, inside the shader's guard
 * band at 0.482". At the shipped hull defaults (`maxDist: 72` reference px, `slop: 12`) the reserve
 * radius is `r = 72 + 12 = 84`, giving `overscan p = r / (1000 - 2r) = 84 / 832 ≈ 0.10096`. Under
 * `exact: true`, `frontLongSide = ceil(sourceLongSide * (1 + 2p))`; at `sourceLongSide = 96` that is
 * `ceil(96 * 1.20192) = 116` — too little margin around a composite silhouette that already spans
 * `x in [8,88)` (80 of the 96 source pixels) once the hull's own dilation is added on top.
 *
 * This is a property of the *overall composite bounding box* (both components plus the gap between
 * them), not of the 12x16 hole: padding the canvas out to `S = 160` (`PAD = 32` on every side, the
 * same absolute component geometry just recentred in a larger source image) grows `frontLongSide`
 * to `ceil(160 * 1.20192) = 193`, which clears the guard band — measured directly against this
 * fixture, the guard-band `SheetError` above disappears at `S = 160` and does not reappear.
 *
 * Once `source()` succeeds, the hole itself needs no widening at all: measured directly, both hole
 * probes below read alpha exactly `0` (fully transparent), comfortably under the `64` bound — the
 * 12x16 hole survives the shipped hull dilation cleanly. The smallest hole that survives is
 * therefore still the brief's original 12x16; what needed changing was the fixture's padding, not
 * its hole size.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { GlError, SheetError, isAborted } from '@paper-crumple/core'
import { defaultsFor } from './paper-knobs.js'
import { paperSheet } from './sheet.js'
import { createGlFixture, type PaperGlFixture } from './testing/gl-fixture.js'

let fixture: PaperGlFixture | null = null
afterEach(() => {
  fixture?.dispose()
  fixture = null
})

function open() {
  fixture = createGlFixture(8, 8)
  expect(fixture.gl, 'no WebGL2 context — check the SwiftShader launch flags (§11)').not.toBeNull()
  return fixture.ctx
}

/** Canvas padding around the composite silhouette — see the file header's guard-band note. */
const PAD = 32
const S = 96 + 2 * PAD

/**
 * Two disjoint opaque squares — the "pair of sneakers" — the left one carrying a square hole.
 * Raw bytes, never a PNG (§7.4.1). Coordinates below are the unpadded geometry (see file header)
 * shifted by `PAD` on both axes so the whole composite sits centred in the `S x S` canvas.
 *
 *   x in [8+PAD, 40+PAD)  y in [24+PAD, 72+PAD)   left component, opaque
 *   x in [18+PAD, 30+PAD) y in [40+PAD, 56+PAD)   the hole inside it, alpha 0
 *   x in [56+PAD, 88+PAD) y in [24+PAD, 72+PAD)   right component, opaque
 */
function twoComponentsWithAHole(): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(S * S * 4)
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const p = (y * S + x) * 4
      const left = x >= 8 + PAD && x < 40 + PAD && y >= 24 + PAD && y < 72 + PAD
      const hole = x >= 18 + PAD && x < 30 + PAD && y >= 40 + PAD && y < 56 + PAD
      const right = x >= 56 + PAD && x < 88 + PAD && y >= 24 + PAD && y < 72 + PAD
      out[p] = 30
      out[p + 1] = 160
      out[p + 2] = 90
      out[p + 3] = (left && !hole) || right ? 255 : 0
    }
  }
  return out
}

function readTexel(
  ctx: ReturnType<typeof open>,
  texture: WebGLTexture,
  x: number,
  y: number,
): [number, number, number, number] {
  const out = new Uint8Array(4)
  const probe = ctx.gl.createFramebuffer()
  ctx.scope(() => {
    ctx.gl.bindFramebuffer(ctx.gl.READ_FRAMEBUFFER, probe)
    ctx.gl.framebufferTexture2D(
      ctx.gl.READ_FRAMEBUFFER,
      ctx.gl.COLOR_ATTACHMENT0,
      ctx.gl.TEXTURE_2D,
      texture,
      0,
    )
    ctx.gl.readPixels(x, y, 1, 1, ctx.gl.RGBA, ctx.gl.UNSIGNED_BYTE, out)
    ctx.gl.bindFramebuffer(ctx.gl.READ_FRAMEBUFFER, null)
  })
  ctx.gl.deleteFramebuffer(probe)
  return [out[0]!, out[1]!, out[2]!, out[3]!]
}

describe('holes and components survive into the built front (§8.2, §11)', () => {
  it('gives both components paper, and leaves the hole a hole', async () => {
    const ctx = open()
    const sheet = paperSheet()
    expect(sheet.mount(ctx)).toBeUndefined()
    const bitmap = await createImageBitmap(new ImageData(twoComponentsWithAHole(), S, S), {
      premultiplyAlpha: 'none',
      colorSpaceConversion: 'none',
    })
    const handle = await sheet.source(bitmap, { maxSize: 128, exact: true })
    bitmap.close()
    if (GlError.is(handle) || SheetError.is(handle) || isAborted(handle)) {
      return expect.fail(`source() refused: ${String(handle)}`)
    }
    const front = sheet.build(handle, { w: 128, h: 128 }, defaultsFor('hull') as never)
    if (front instanceof Error) return expect.fail(front.message)

    // A is centred in the front (§7.4.3); every probe below is expressed in the fixture's own
    // (unpadded) coordinates, shifted by PAD to land on the actual painted geometry, and offset
    // into front coordinates once, so the numbers stay readable against the file header's diagram.
    //
    // ax/ay come out NEGATIVE here, and that is load-bearing — do not "fix" it by shrinking the
    // build size to match the artwork, or by assuming ax >= 0. Under `exact: true`, source() sets
    // `aLongSide = sourceLongSide` unconditionally (sheet.ts:767-773) — maxSize is never consulted
    // for artwork sizing — so on this padded 160x160 fixture `handle.artwork` is 160x160, while the
    // front built below is only 128x128, i.e. smaller than its own artwork. That gives
    // `ax = round((128 - 160) / 2) = -16`, and the clip this implies is real: build() places
    // `artworkRect` with the identical `Math.round((size - artwork) / 2)` formula (sheet.ts:1157-
    // 1161), so the artwork overflows the front by 16px on every edge inside it. It is harmless
    // only because the painted content sits at bitmap x/y in [40,120), strictly inside the visible
    // artwork window (artwork-local [16,144) on each axis) — only transparent margin gets clipped.
    // And because `at()` below reapplies this same `ax`/`ay` that build() itself used, the negative
    // offset cancels out of every probe: `at(x, y)` reads front pixel (16 + x, 16 + y), which stays
    // inside [0,128) for all five probes here.
    const ax = Math.round((front.width - handle.artwork.w) / 2)
    const ay = Math.round((front.height - handle.artwork.h) / 2)
    const at = (x: number, y: number) => readTexel(ctx, front.texture, ax + PAD + x, ay + PAD + y)

    // Both components carry paper: alpha well above the shader's own 0.002 identity cutoff.
    // (12, 48) sits inside the left component's rect (x in [8,40), y in [24,72)) and strictly left
    // of the hole (x >= 18), so it reads the component's own paper and nothing else.
    expect(at(12, 48)[3]).toBeGreaterThan(200)
    expect(at(72, 48)[3]).toBeGreaterThan(200)

    // The gap between them is not bridged: a single merged hull would fill x = 48.
    expect(at(48, 48)[3]).toBeLessThan(64)

    // The hole is still a hole. It sits inside the left component's outer loop, so anything that
    // "took the largest contour" or filled interior loops would make this opaque — i.e. this must
    // read LOW alpha, using the same "not paper" bound as the gap probe above. Measured: both reads
    // are exactly 0 (see the file header's guard-band note).
    expect(at(24, 48)[3]).toBeLessThan(64)
    expect(at(24, 47)[3]).toBeLessThan(64)
  })

  it('reports a rect that spans both components rather than only the larger one', async () => {
    const ctx = open()
    const sheet = paperSheet()
    expect(sheet.mount(ctx)).toBeUndefined()
    const bitmap = await createImageBitmap(new ImageData(twoComponentsWithAHole(), S, S), {
      premultiplyAlpha: 'none',
      colorSpaceConversion: 'none',
    })
    const handle = await sheet.source(bitmap, { maxSize: 128, exact: true })
    bitmap.close()
    if (GlError.is(handle) || SheetError.is(handle) || isAborted(handle)) {
      return expect.fail(`source() refused: ${String(handle)}`)
    }
    // The silhouette box spans x = 8+PAD .. 88+PAD — both squares — not 8+PAD .. 40+PAD or
    // 56+PAD .. 88+PAD.
    expect(handle.rect.w).toBeGreaterThan(70)
    sheet.dispose()
  })
})
