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
 * `GAP` is load-bearing and must not be shrunk. Whether the two squares trace as one loop or two is
 * decided in one place: `extractContours(field, w, h, iso)` at `hull.ts:146-147`, run at the single
 * fixed `iso = -(minDist + maxDist) * 0.5` — the *middle* of the band, 47 reference px at the
 * shipped hull defaults (`minDist: 22`, `maxDist: 72`). Two offset curves whose offset exceeds half
 * their separation merge into a single contour; that is ordinary Minkowski-offset behaviour, not a
 * tracer defect, and it is the same reason a sheet of paper wrapped around two nearby garment
 * pieces reads as one sheet.
 *
 * The per-vertex sliding that follows (`hull.ts:168-181`, which stretches and clamps its noise so
 * "the ends of the band are actually reached") does **not** enter into this. It runs *after*
 * extraction, on a loop that is already either one or two, and moving a vertex along the band can
 * neither split a loop nor fuse two — so the component count is a property of the mid-band `iso`
 * alone. Do not reach for the band to explain the sweep below.
 *
 * The units are the trap here, so they are spelled out. `source()` scales reference px by
 * `pxScale = front.h / KNOB_REFERENCE_PX` (`sheet.ts:892`) off its own front, which under
 * `exact: true` is `exactFrontLongSide(160, p) = 193` (`sheet.ts:782`). That front is **not** a
 * magnified source: `aLongSide = sourceLongSide` under `exact: true` (`sheet.ts:783`), so the
 * artwork is placed at 1:1 — 160 source px stay 160 artwork px — and the front is larger only
 * because, in `exactFrontLongSide`'s own words, "the paper margin still has to fit". One front px
 * is therefore one source px, and the per-side reach is `47 * 193 / 1000 ~= 9.07` px in the same
 * units `GAP` is quoted in. **Do not** rescale that by `160 / 193` on the theory that front and
 * source are different densities; they are not, and `47 * S / 1000` is not a valid shortcut. (The
 * same fact is stated again further down this file, in the `ax`/`ay` note: on this fixture
 * `handle.artwork` is 160x160.)
 *
 * So the merge threshold is a single number, `2 * 9.07 ~= 18.1` source px, and the sweep below is
 * what pins it down — the cross-check is worth keeping in the comment because it is exactly what
 * catches an arithmetic slip here. At `GAP = 16` each side reaches 9.07 across a half-gap of 8, so
 * `8 < 9.07` and the contours fuse: measured, one component. At `GAP = 24` the half-gap is 12, so
 * `12 > 9.07` and they stay apart: measured, two.
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
 * 16px — this fixture's original gap — is under the 18.1px threshold, so the two squares traced as
 * a single loop spanning both. `GAP = 32` is chosen over the 24 that first works because it clears
 * that threshold by ~1.77x rather than by a hair, so the fixture does not fuse again for a rounding
 * change or a small shift in the shipped hull knobs.
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
import { HOLES_FIXTURE, twoComponentsWithAHole } from './testing/fixture-sources.js'
import { createGlFixture, type PaperGlFixture } from './testing/gl-fixture.js'
import { SMOOTH_CLEAN } from './testing/edge-cells.js'

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

/**
 * The geometry, shared with `paper-shader-early-out.gl.test.ts` through `testing/fixture-sources.ts`:
 * the canvas `S` (see the file header's guard-band note), one component's box, the gap (do not
 * shrink it below ~24 — see the file header), the composite's origin and the hole.
 */
const { S, COMP_W, GAP, CX, CY, HOLE_X, HOLE_Y } = HOLES_FIXTURE

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

    const front = sheet.build(handle, { w: 128, h: 128 }, defaultsFor(SMOOTH_CLEAN) as never)
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
