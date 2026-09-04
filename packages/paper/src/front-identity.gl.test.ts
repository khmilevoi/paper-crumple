/**
 * # The pose-0 guarantee, at the scope §7.4.2 actually claims
 *
 * **The guarantee is over the front texture, not over a drawn frame.** It is compared here on the
 * front's **artwork rect** through `readPixels`, and never on a tile's blitted pixels: a `{ canvas }`
 * view whose backing store is not the front's size resamples through the 2D context's own filter,
 * which the library does not control (§4.0.1). The drawn-frame claim is scoped to `identityView`
 * and lives in `packages/motion/src/identity-view.gl.test.ts`, which names itself a smoke test.
 *
 * The `identity` case moves here from level 1 (§11) because it compares pixels rather than judging
 * appearance. P8's level-1 tests of `extractContours` and the mask utilities are a different thing
 * and stay where they are.
 *
 * ## What this file actually claims, and what it does not
 *
 * §7.4.2's "the filter reduces to a bitwise copy on every channel of every texel, including RGB
 * under zero alpha" is a claim about the **resample filter** — already carried, at Pool A, by
 * `artwork.gl.test.ts`'s "is the identity at ratio 1, on every channel including RGB under zero
 * alpha" and "matches P5's identityResample byte for byte on a reduction". This file compares a
 * different surface: the **front**, which is a composite the filter's output is drawn into, not
 * the filter's own output.
 *
 * `build()` supplies a real `paperField` at the default `hull` knobs (`sheet.ts`'s `build()`), so
 * the front compared here is `uEdgeMode == 1` — not the `uEdgeMode == 2` this file was originally
 * written against, when `build()` still passed `paperField: null` unconditionally. At
 * `uEdgeMode == 1` the coverage mask is the hull polygon's own distance field rather than the
 * artwork's alpha, and the sheet follows that polygon, which sits *outside* the artwork's
 * silhouette. So an alpha-0 texel of A is no longer uniformly empty: the ones the sheet reaches
 * carry opaque paper, and only the ones it does not reach are still exactly `(0, 0, 0, 0)`. Which
 * of the two any given texel lands in depends on the front the hull was TRACED on: `minDist` and
 * `maxDist` are `reference: 'sprite-px'` knobs, scaled by that front's height when `source()`
 * traces the polygon once, and the polygon then moves 1:1 with the artwork into whatever front
 * `build()` is asked for (`sheet.ts`'s `artworkPlacement`). The two tests below trace at different
 * front heights (49 and 32), so they measure their split rather than deriving it, and they
 * measure different splits.
 *
 * The front still does not preserve the artwork's RGB under zero alpha, and a future reader must
 * still not "fix" this file's partitioned assertions back into a full-rect byte-for-byte claim.
 * That claim is now false for a second, independent reason: it was already false because the
 * alpha-0 texels did not carry the source's RGB, and it is now *also* false because most of them
 * do not read `(0, 0, 0, 0)` either — they read paper.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { GlError, SheetError, isAborted } from '@paper-crumple/core'
import { identityResample } from '@paper-crumple/core/unstable'
import { defaultsFor } from './paper-knobs.js'
import { paperSheet } from './sheet.js'
import {
  IDENTITY_SRC as SRC,
  identitySourceBytes as sourceBytes,
} from './testing/fixture-sources.js'
import { createGlFixture, type PaperGlFixture } from './testing/gl-fixture.js'

let fixture: PaperGlFixture | null = null
afterEach(() => {
  // §4.0 caps live WebGL2 contexts at roughly sixteen and Vitest opens one page per file.
  fixture?.dispose()
  fixture = null
})

function open() {
  fixture = createGlFixture(8, 8)
  expect(fixture.gl, 'no WebGL2 context — check the SwiftShader launch flags (§11)').not.toBeNull()
  return fixture.ctx
}

/**
 * Built from `ImageData` directly, never through an `OffscreenCanvas` `putImageData` round trip:
 * Chromium's 2D canvas stores premultiplied, which zeroes every alpha-0 texel's RGB before this
 * module ever sees it (`artwork.gl.test.ts:42-55` records the verification).
 */
async function sourceBitmap(): Promise<ImageBitmap> {
  return createImageBitmap(new ImageData(sourceBytes(), SRC.w, SRC.h), {
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none',
  })
}

/** `readPixels` reads `READ_FRAMEBUFFER`; `DrawScope.bindTarget` only ever binds `DRAW_FRAMEBUFFER`. */
function readRect(
  ctx: ReturnType<typeof open>,
  texture: WebGLTexture,
  x: number,
  y: number,
  w: number,
  h: number,
): Uint8Array {
  const out = new Uint8Array(w * h * 4)
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
    ctx.gl.readPixels(x, y, w, h, ctx.gl.RGBA, ctx.gl.UNSIGNED_BYTE, out)
    ctx.gl.bindFramebuffer(ctx.gl.READ_FRAMEBUFFER, null)
  })
  ctx.gl.deleteFramebuffer(probe)
  return out
}

/**
 * Splits every texel of `reference` (an RGBA8 buffer) by its own alpha channel into the two
 * classes this file's oracle is measured to hold on (opaque and fully transparent), plus whatever
 * is neither — a partial-alpha texel, which neither test's oracle covers (see the per-test doc
 * comments below for why).
 */
function partitionByAlpha(reference: ArrayLike<number>): {
  opaque: number[]
  empty: number[]
  partial: number[]
} {
  const opaque: number[] = []
  const empty: number[] = []
  const partial: number[] = []
  for (let t = 0; t * 4 < reference.length; t++) {
    const a = reference[t * 4 + 3]
    if (a === 255) opaque.push(t)
    else if (a === 0) empty.push(t)
    else partial.push(t)
  }
  return { opaque, empty, partial }
}

/** `firstDifferences`, restricted to a subset of texel indices — for a partitioned oracle. */
function firstDifferencesAt(
  got: Uint8Array,
  want: ArrayLike<number>,
  texels: readonly number[],
  stride: number,
  limit = 8,
): string[] {
  const out: string[] = []
  for (const texel of texels) {
    if (out.length >= limit) break
    for (let c = 0; c < 4; c++) {
      const i = texel * 4 + c
      if (got[i] !== want[i]) {
        out.push(
          `(${texel % stride},${Math.floor(texel / stride)}).${'rgba'[c]}: ${got[i]} != ${want[i]}`,
        )
      }
    }
  }
  return out
}

/** Flattens the four bytes of each listed texel, in order — for a byte-exact partitioned compare. */
function pickTexels(bytes: ArrayLike<number>, texels: readonly number[]): number[] {
  const out: number[] = []
  for (const texel of texels) {
    for (let c = 0; c < 4; c++) out.push(bytes[texel * 4 + c])
  }
  return out
}

describe("the front's artwork rect through readPixels, partitioned by alpha", () => {
  /**
   * Ruling 1: the oracle is split by the *source's own* alpha, not compared whole against the raw
   * source bytes. This fixture's alpha is only ever 0 or 255 (`sourceBytes` above), so the two
   * classes partition every texel of A.
   *
   * The alpha-255 half is untouched by the move to `uEdgeMode == 1` (see the file header): an
   * opaque texel still has `sheetCov == 1`, so `front = mix(sheet, img.rgb, 1.0)`
   * (`paper-shader.ts:1693`) and the artwork's own bytes survive. The alpha-0 half moved, and is
   * re-measured rather than derived. Measured, of the 1600 texels in the 40x40 artwork rect: all
   * 784 alpha-255 texels still match the source byte for byte, and the 816 alpha-0 texels split
   * 191 covered (opaque paper) / 625 still clear, with no feathered texel between them.
   *
   * The split is the hull's own reach, and nothing else. The hull is traced in `source()`, at
   * *that* call's own front: under `exact: true` the front is the artwork (40x40) plus
   * `ceil(p * 40) = 5` texels of per-axis margin on every side (`handle.ts`'s `frontForArtwork`,
   * §8.6 amendment) = 50, not the 128 this test later builds at, so `minDist`/`maxDist` (22/72
   * reference px) are 1.1/3.6 px there. `build()` then places the artwork 1:1 at
   * `round((size - artwork) / 2)` and carries the polygon into the 128 front translated to that
   * same origin (`sheet.ts`'s `artworkPlacement`, `fillHullMask`'s `tx`/`ty`), so the sheet sits a
   * few px around the 28x28 silhouette: measured, the artwork rect lands at `[44, 84)` — which is
   * what leaves 625 of its alpha-0 texels clear. Before `artworkPlacement`, the field was framed
   * by a flat `p` inset instead, which at `size = 128` stretched the sheet to `[23, 103]` — an
   * overhang of roughly 20 px on every side that covered the whole rect and hid the hull's real
   * reach.
   *
   * Test 2 below traces at a 32 px front, where `maxDist` scales to `72 * 32 / 1000 = 2.3` px, and
   * its split is measured separately.
   */
  it('reads back every texel of A unchanged where opaque, and (0,0,0,0) where transparent', async () => {
    const ctx = open()
    const sheet = paperSheet()
    expect(sheet.mount(ctx)).toBeUndefined()
    const bitmap = await sourceBitmap()
    const handle = await sheet.source(bitmap, { maxSize: 128, exact: true })
    bitmap.close()
    if (GlError.is(handle) || SheetError.is(handle) || isAborted(handle)) {
      return expect.fail(`source() refused: ${String(handle)}`)
    }
    // exact: A === the source, and the front grows around it to fit the paper margin (§7.4.3).
    expect(handle.artwork).toEqual({ w: SRC.w, h: SRC.h })

    const front = sheet.build(handle, { w: 128, h: 128 }, defaultsFor('hull') as never)
    if (front instanceof Error) return expect.fail(front.message)

    // The artwork's origin inside the front: the front is `ceil(source x (1 + 2p))` and A is
    // centred in it (§7.4.3). Derived, never hard-coded — the overscan is 0.101 on the shipped
    // hull defaults, not §8.6's illustrative 0.09.
    const ax = Math.round((front.width - handle.artwork.w) / 2)
    const ay = Math.round((front.height - handle.artwork.h) / 2)
    const got = readRect(ctx, front.texture, ax, ay, handle.artwork.w, handle.artwork.h)

    const want = sourceBytes()
    const { opaque, empty, partial } = partitionByAlpha(want)
    // This fixture's alpha is only ever 0 or 255 (see sourceBytes), so nothing falls here.
    expect(partial).toEqual([])
    expect(opaque.length + empty.length).toBe(handle.artwork.w * handle.artwork.h)

    expect(firstDifferencesAt(got, want, opaque, handle.artwork.w)).toEqual([])
    expect(pickTexels(got, opaque)).toEqual(pickTexels(want, opaque))

    // Under `uEdgeMode == 1` the alpha-0 class is no longer uniformly `(0,0,0,0)`: the texels the
    // hull polygon's sheet covers carry opaque paper, and only the ones it does not reach stay
    // clear. Measured at this build the sheet covers a 1-4 px ring around the silhouette and
    // nothing beyond it — Ruling 1 above gives the mechanism and the numbers. Both counts are
    // pinned individually rather than summed so the split is stated outright rather than implied,
    // and because the sheet's reach is now the hull's own (traced at a 49 px front, carried over
    // 1:1), a hull that lost or gained reach moves them.
    const covered = empty.filter((t) => got[t * 4 + 3] === 255)
    const clear = empty.filter((t) => got[t * 4 + 3] === 0)
    expect(covered.length).toBe(191)
    expect(clear.length).toBe(625)
    expect(covered.length + clear.length).toBe(empty.length)
    // Paper, not a stray copy of the artwork: the default `paperColor` (#f7f4ed) reads high on all
    // three channels. Measured, the per-channel minimum over all 191 covered texels is
    // (241, 238, 231), so the bound below clears it by ~90 counts; the artwork's own RGB at the
    // sixteen texels sampled (the ring's first row) is `g = 40..94, b <= 17`, nowhere near it.
    for (const t of covered.slice(0, 16)) {
      expect(got[t * 4]).toBeGreaterThan(150)
      expect(got[t * 4 + 1]).toBeGreaterThan(150)
      expect(got[t * 4 + 2]).toBeGreaterThan(150)
    }
    expect(pickTexels(got, clear)).toEqual(new Array(clear.length * 4).fill(0))

    sheet.releaseFront(front)
    sheet.dispose()
  })

  /**
   * Ruling 2: `maxSize: 28` is chosen, not the brief's `64`, because at the shipped hull overscan
   * (0.101, not §8.6's illustrative 0.09) `frontForArtwork` (§8.6 amendment, `handle.ts`) picks
   * the largest artwork long side whose front — the artwork plus `ceil(p * A.h)` texels of margin
   * on every side — fits `maxSize`. At `maxSize: 64` that is well above `SRC.w (40)` — no
   * reduction happens at all. `maxSize: 28` gives a 22x22 artwork (front 28x28), a clean margin
   * under 40, and — unlike `32`, which gives a 26x26 artwork whose margin happens to fall exactly
   * outside the reference's alpha-0 ring (F8: `covered` is empty there, so the "paper, not the
   * artwork" check below never ran) — one where the hull's reach still lands inside that ring.
   *
   * Ruling 3: the oracle is measured, not assumed. A reduction blurs the fixture's hard alpha edge,
   * so `identityResample`'s TypeScript reference carries partial alpha in a ring around the old
   * edge. Measured directly against this fixture at `maxSize: 28` (484 texels total): the front's
   * `uEdgeMode == 2` coverage mask reproduces the reference exactly on both the 196 texels where
   * the reference's own alpha is 255 (all four channels, zero mismatches) and the 228 texels where
   * it is 0 (before the sheet's own reach is applied — see the covered/clear/feathered split
   * below, zero mismatches on the ones it does not reach) — but NOT on the 60 texels in
   * between, where the reference carries partial alpha: every one of those 60 mismatches, on both
   * RGB and alpha. That rules out rung 1 (whole-rect exact) and rung 2 (whole-rect
   * alpha exact); rung 3 — assert only the reference's alpha-255 and alpha-0 texels, leave the
   * partial-alpha ring unasserted — is the highest rung this measurement supports, and holds with
   * zero exceptions in both classes it covers.
   */
  it("matches P5's TypeScript reference on a reduction, on the texels the front reproduces exactly", async () => {
    const ctx = open()
    const sheet = paperSheet()
    expect(sheet.mount(ctx)).toBeUndefined()
    const bitmap = await sourceBitmap()
    const handle = await sheet.source(bitmap, { maxSize: 28, exact: false })
    bitmap.close()
    if (GlError.is(handle) || SheetError.is(handle) || isAborted(handle)) {
      return expect.fail(`source() refused: ${String(handle)}`)
    }
    expect(handle.artwork.w).toBeLessThan(SRC.w)

    const front = sheet.build(handle, { w: 28, h: 28 }, defaultsFor('hull') as never)
    if (front instanceof Error) return expect.fail(front.message)

    const reference = identityResample(
      { data: sourceBytes(), width: SRC.w, height: SRC.h },
      { x: 0, y: 0, w: SRC.w, h: SRC.h },
      handle.artwork.w,
      handle.artwork.h,
    )
    if (reference instanceof Error) return expect.fail(reference.message)

    const ax = Math.round((front.width - handle.artwork.w) / 2)
    const ay = Math.round((front.height - handle.artwork.h) / 2)
    const got = readRect(ctx, front.texture, ax, ay, handle.artwork.w, handle.artwork.h)

    const { opaque, empty, partial } = partitionByAlpha(reference)
    // The three classes are pinned individually, not merely summed: `partitionByAlpha` puts every
    // texel in exactly one array, so the sum is true by construction and bounds nothing. These are
    // the measured counts the doc comment above reasons from, so if the reference changed and the
    // partial-alpha ring grew, the ring the oracle deliberately leaves unasserted would be caught
    // here rather than silently widening under a comment that had become false.
    expect(opaque.length).toBe(196)
    expect(empty.length).toBe(228)
    expect(partial.length).toBe(60)
    expect(opaque.length + empty.length + partial.length).toBe(handle.artwork.w * handle.artwork.h)

    expect(firstDifferencesAt(got, reference, opaque, handle.artwork.w)).toEqual([])
    expect(pickTexels(got, opaque)).toEqual(pickTexels(reference, opaque))

    // Under `uEdgeMode == 1` the reference's alpha-0 class is no longer uniformly `(0,0,0,0)` on
    // the front. It splits three ways here, not two as in test 1: `front.h = 28` scales the default
    // `maxDist` of 72 reference px to `72 * 28 / 1000 = 2.0` px, so the sheet's reach and the
    // artwork's own (22x22, one texel smaller than before the §8.6 per-axis amendment would have
    // given at this maxSize) leave 38 texels of the reference's alpha-0 class both inside the
    // sheet's ring AND still within the artwork rect — measured, `covered` is 38 (F8: a maxSize of
    // 32 gives an artwork whose margin happens to land just outside this ring instead, leaving
    // `covered` empty and this check a no-op; 28 is chosen so it still exercises the "paper, not a
    // stray copy of the artwork" assertion below), `clear` is every alpha-0 texel the sheet does
    // not reach, and `feathered` is the polygon's own antialiased edge, wider than in test 1
    // because at 2.0 px the polygon's edge crosses the artwork's own texel grid at an angle almost
    // everywhere. All three counts are measured and pinned individually rather than summed, so a
    // hull that lost its reach into the rect, or a feathered edge that grew, would fail here rather
    // than widen under a stale comment. The feathered class is pinned by count only and its bytes
    // are left unasserted, exactly as Ruling 3 leaves the reference's own partial-alpha ring
    // unasserted, and for the same reason: no oracle in this file predicts them.
    const covered = empty.filter((t) => got[t * 4 + 3] === 255)
    const clear = empty.filter((t) => got[t * 4 + 3] === 0)
    const feathered = empty.filter((t) => got[t * 4 + 3] !== 0 && got[t * 4 + 3] !== 255)
    expect(covered.length).toBe(38)
    expect(clear.length).toBe(136)
    expect(feathered.length).toBe(54)
    expect(covered.length + clear.length + feathered.length).toBe(empty.length)
    // Paper, not a stray copy of the artwork: the default `paperColor` (#f7f4ed) reads high on all
    // three channels, live-checked here (see Ruling 2 above for why `maxSize: 32` could not run
    // this loop). Measured, the per-channel minimum over the sixteen texels sampled is
    // (242, 239, 232) — clears the bound below by 82 counts.
    for (const t of covered.slice(0, 16)) {
      expect(got[t * 4]).toBeGreaterThan(150)
      expect(got[t * 4 + 1]).toBeGreaterThan(150)
      expect(got[t * 4 + 2]).toBeGreaterThan(150)
    }
    expect(pickTexels(got, clear)).toEqual(new Array(clear.length * 4).fill(0))

    sheet.releaseFront(front)
    sheet.dispose()
  })
})
