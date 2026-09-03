/**
 * # `holes`, at level 2 (§11, §8.2)
 *
 * §11 moves `identity` and `holes` to this tier because "both compare pixels rather than judging
 * appearance". P8's level-1 tests of `extractContours` and the mask utilities are a different
 * thing and are not replaced by this file.
 *
 * The property under test is §8.2's: **only OUTER loops are kept, but every one of them.** Both
 * halves of that sentence get a probe here, and they pull in opposite directions:
 *
 * - *every one of them* — a source with two disjoint components gets two pieces of paper, and the
 *   gap between them stays empty. Pinned twice below: once structurally, on the traced hull's own
 *   component count, and once on the pixel in the middle of the gap.
 * - *only OUTER* — a hole inside a component is **filled** by the paper that surrounds it. This is
 *   deliberate, and `hull.ts`'s own module header says so in as many words: a magazine cutout has
 *   no holes. The artwork still has its hole (its alpha is 0 there); what the probe reads is the
 *   paper behind it.
 *
 * That second bullet is the opposite of what this file asserted before the hull field was wired
 * into `build()`. It used to read LOW alpha there, and passed, because every `build()` in `hull`
 * mode went through `uEdgeMode == 2`, which ignores the traced polygon entirely and derives its
 * coverage from the artwork's own alpha — so the probe was reading the artwork's hole rather than
 * the sheet, and never tested §8.2's rule at all. With a real `paperField` the sheet follows the
 * polygon, the polygon has no inner loop, and the hole reads paper.
 *
 * The hole probe therefore does double duty, and is the reason it is worth keeping rather than
 * deleting: it is also this file's **positive control**. Because it sits deep inside the left
 * component, it can only read paper if the hull mask was filled, scaled and placed correctly. A
 * gap probe that reads "not paper" proves nothing on its own — a mask that failed to render at
 * all would satisfy it too. The two probes only pass together if the sheet is really there and
 * really has two pieces.
 *
 * ## Geometry — and why the gap is 32px wide, not 16px
 *
 * Two 32x48 opaque squares, `GAP` apart, centred in an `S x S` canvas, the left one carrying a
 * 12x16 hole. Every coordinate below is derived from those constants rather than written out, so
 * the diagram cannot drift from the bytes.
 *
 * `GAP` is load-bearing and must not be shrunk. `buildHull` traces its contour at
 * `iso = -(minDist + maxDist) * 0.5` (`hull.ts:146`) — the *middle* of the band, 47 reference px at
 * the shipped hull defaults (`minDist: 22`, `maxDist: 72`) — and then slides every vertex out to
 * its own distance within `[minDist, maxDist]`, with the noise deliberately stretched and clamped
 * so that "the ends of the band are actually reached" (`hull.ts:172-181`). The mid-band figure is
 * therefore a *floor* on the polygon's reach, not the reach itself: stretches of the contour sit
 * all the way out at `maxDist`. Two offset curves whose offset exceeds half their separation merge
 * into a single contour; that is ordinary Minkowski-offset behaviour, not a tracer defect, and it
 * is the same reason a sheet of paper wrapped around two nearby garment pieces reads as one sheet.
 *
 * Converting that into the source pixels this fixture is painted in: `source()` scales reference px
 * by `pxScale = front.h / KNOB_REFERENCE_PX` (`sheet.ts:892`) off its OWN front, which under
 * `exact: true` is `exactFrontLongSide(160, p) = 193` (`sheet.ts:782`) — so 47 reference px is
 * `47 * 193 / 1000 ~= 9.07` **front** px, and converting back to source px (`x 160 / 193`) gives
 * `~7.5` **source** px per side. The front factor cancels, which is what makes `47 * S / 1000` the
 * correct shortcut; `47 * 193 / 1000` is a front-px figure and must not be compared against `GAP`,
 * which is quoted in source px. The same conversion puts the band's outer end, `maxDist = 72`, at
 * `72 * 160 / 1000 ~= 11.5` source px per side.
 *
 * So the fuse threshold is not a single number but a bracket, `2 * 7.5 = 15px` to
 * `2 * 11.5 = 23px`, depending on how far out the noise pushed the contour along the two facing
 * edges. The sweep below lands inside that bracket — merging at 16 and separating at 24 — which is
 * the behaviour the band's outer end predicts, not its middle.
 *
 * Measured directly against this fixture, sweeping `GAP` at `S = 160` and reading the component
 * count off `handle.hull` plus the alpha at the gap's midpoint:
 *
 * | `GAP` | hull components | alpha at the gap's midpoint |
 * | ----- | --------------- | --------------------------- |
 * | 16    | **1**           | **255** (one merged sheet)   |
 * | 24    | 2               | 0                            |
 * | 32    | 2               | 0                            |
 * | 40    | 2               | 0                            |
 *
 * 16px — this fixture's original gap — is inside the merge bracket, so the two squares traced as a
 * single loop spanning both. `GAP = 32` is chosen over the 24 that first works because 24 clears
 * the bracket's upper end (23px) by a single pixel: 32 clears it by ~1.4x, so the fixture does not
 * fuse again for a rounding change or for a different `seed` shifting the noise along the band.
 *
 * ## Canvas size — required by the guard-band check, not by the hole
 *
 * `S = 160` is not free either. Measured directly, `S = 96` fails before any assertion is reached:
 * `source()` itself returns a `SheetError` from the shipped guard-band check (§8.6,
 * `packages/core/src/overscan.ts`'s `checkGuardBand`) — "the hull reaches 0.4828 of the front on
 * axis x, inside the shader's guard band at 0.482". At the shipped hull defaults (`maxDist: 72`
 * reference px, `slop: 12`) the reserve radius is `r = 72 + 12 = 84`, giving overscan
 * `p = r / (1000 - 2r) = 84 / 832 ~= 0.10096`. Under `exact: true`,
 * `frontLongSide = ceil(sourceLongSide * (1 + 2p))`; at `sourceLongSide = 96` that is
 * `ceil(96 * 1.20192) = 116` — too little margin around a composite silhouette that already spans
 * most of the canvas once the hull's own offset is added on top. At `S = 160` that becomes
 * `ceil(160 * 1.20192) = 193`, which clears it: measured, `source()` succeeds here and the
 * guard-band `SheetError` does not reappear, at the widened `GAP` as well as the original one.
 *
 * Note this is a property of the *overall composite bounding box* — both components plus the gap —
 * so widening `GAP` spends canvas margin: the composite grows from 80px to 96px of the 160, and
 * the margin around it falls from 40px to 32px per side. Measured, that still clears the guard
 * band. Growing `S` instead would not have helped, because the hull's offset is quoted in
 * reference px and therefore scales *with* `S`, while the gap would not.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { GlError, SheetError, isAborted } from '@paper-crumple/core'
import { hullComponentCount } from './hull-shape.js'
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

/** The canvas the composite is centred in — see the file header's guard-band note. */
const S = 160
/** One component's box. */
const COMP_W = 32
const COMP_H = 48
/** The space between them — see the file header. Do not shrink this below ~24. */
const GAP = 32
/** The composite's own origin, centred in the canvas. */
const CX = Math.round((S - (2 * COMP_W + GAP)) / 2)
const CY = Math.round((S - COMP_H) / 2)
/** The hole, inside the left component. */
const HOLE_X = CX + 10
const HOLE_Y = CY + 16
const HOLE_W = 12
const HOLE_H = 16

/**
 * Two disjoint opaque squares — the "pair of sneakers" — the left one carrying a square hole.
 * Raw bytes, never a PNG (§7.4.1). With the constants above this paints, in canvas coordinates:
 *
 *   x in [32, 64)    y in [56, 104)   left component, opaque
 *   x in [42, 54)    y in [72, 88)    the hole inside it, alpha 0
 *   x in [96, 128)   y in [56, 104)   right component, opaque
 *
 * leaving x in [64, 96) as the gap and a 32px margin on either side of the composite.
 */
function twoComponentsWithAHole(): Uint8ClampedArray<ArrayBuffer> {
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
  it('gives both components paper, fills the hole, and leaves the gap empty', async () => {
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

    // §8.2's "every one of them", pinned structurally rather than inferred from a pixel. This is
    // the assertion that actually fails when the two components fuse: at the original 16px gap the
    // tracer returned ONE loop spanning both squares (see the file header's sweep), and every
    // pixel probe below still has to be read through that fact to be interpreted correctly.
    expect(hullComponentCount(handle.hull)).toBe(2)

    const front = sheet.build(handle, { w: 128, h: 128 }, defaultsFor('hull') as never)
    if (front instanceof Error) return expect.fail(front.message)

    // A is centred in the front (§7.4.3); the probes below are in the fixture's own canvas
    // coordinates and are offset into front coordinates once, so they stay readable against the
    // diagram above.
    //
    // ax/ay come out NEGATIVE here, and that is load-bearing — do not "fix" it by shrinking the
    // build size to match the artwork, or by assuming ax >= 0. Under `exact: true`, source() sets
    // `aLongSide = sourceLongSide` unconditionally (sheet.ts:767-773) — maxSize is never consulted
    // for artwork sizing — so on this 160x160 fixture `handle.artwork` is 160x160, while the front
    // built below is only 128x128, i.e. smaller than its own artwork. That gives
    // `ax = round((128 - 160) / 2) = -16`, and the clip this implies is real: build() places
    // `artworkRect` with the identical `Math.round((size - artwork) / 2)` formula (sheet.ts:1157-
    // 1161), so the artwork overflows the front by 16px on every edge inside it. It is harmless
    // only because the painted content sits at x in [32, 128) and y in [56, 104), strictly inside
    // the visible artwork window (artwork-local [16, 144) on each axis) — only transparent margin
    // gets clipped. And because `at()` reapplies the same `ax`/`ay` that build() itself used, the
    // negative offset cancels out of every probe: the five reads below land at front x in [20, 96]
    // and y in [63, 64], all well inside [0, 128).
    const ax = Math.round((front.width - handle.artwork.w) / 2)
    const ay = Math.round((front.height - handle.artwork.h) / 2)
    const at = (x: number, y: number) => readTexel(ctx, front.texture, ax + x, ay + y)

    // Both components carry paper: alpha well above the shader's own 0.002 identity cutoff. Each
    // probe sits inside its own component's rect, and the left one is strictly left of the hole.
    expect(at(CX + 4, CY + 24)[3]).toBeGreaterThan(200)
    expect(at(CX + COMP_W + GAP + 16, CY + 24)[3]).toBeGreaterThan(200)

    // The gap between them is not bridged. Measured: alpha 0 at the midpoint. With the component
    // count pinned at 2 above, this reads as "two sheets that do not touch" rather than merely
    // "no sheet rendered here".
    expect(at(CX + COMP_W + GAP / 2, CY + 24)[3]).toBeLessThan(64)

    // The hole is filled, by design — §8.2 keeps only OUTER loops, so the traced polygon has no
    // inner loop and the sheet runs straight under the artwork's hole ("a magazine cutout has no
    // holes", `hull.ts`'s module header). Measured: both probes read alpha exactly 255, against
    // the LOW alpha this file asserted while `build()` still forced `uEdgeMode == 2` and the probe
    // was reading the artwork's own alpha instead of the sheet. Doubling as the positive control
    // for the mask itself — see the file header — these two are the only probes here that can
    // distinguish a correctly placed sheet from no sheet at all.
    expect(at(HOLE_X + 6, HOLE_Y + 8)[3]).toBeGreaterThan(200)
    expect(at(HOLE_X + 6, HOLE_Y + 7)[3]).toBeGreaterThan(200)

    sheet.releaseFront(front)
    sheet.dispose()
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
    // The silhouette box spans the whole composite, x in [32, 128) — both squares — not just one
    // of them, which would be only COMP_W (32) wide.
    expect(handle.rect.w).toBeGreaterThan(2 * COMP_W + GAP - 10)
    sheet.dispose()
  })
})
