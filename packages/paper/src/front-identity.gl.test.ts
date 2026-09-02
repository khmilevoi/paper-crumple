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
 * Every `edgeMode: 'hull'` call through the public `build()` passes `paperField: null`
 * unconditionally (`sheet.ts`'s `build()`), which forces `uEdgeMode == 2` in the shader regardless
 * of the caller's `minDist`/`maxDist`. At `uEdgeMode == 2` the coverage mask is derived directly
 * from the artwork's own alpha, with no growth margin (`paper-shader.ts`, the `uEdgeMode == 2`
 * branch: "Hull at `minDist = maxDist = 0`: the sheet is the artwork itself, so the mask is the
 * alpha read as a distance"). `main()`'s final `outColor` is `premul / outA`, which is exactly
 * `(0, 0, 0, 0)` wherever that mask is zero — i.e. wherever the source's own alpha was zero. So the
 * front, by design, does not preserve RGB outside the artwork's own opaque silhouette: it composites
 * the artwork onto (present but see-through) nothing, and there is nothing there to read RGB from.
 * A future reader must not "fix" this file's partitioned assertions back into a full-rect
 * byte-for-byte claim — that claim is false at this surface, and true only at Pool A.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { GlError, SheetError, isAborted } from '@paper-crumple/core'
import { identityResample } from '@paper-crumple/core/unstable'
import { defaultsFor } from './paper-knobs.js'
import { paperSheet } from './sheet.js'
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

const SRC = { w: 40, h: 40 }

/** A deterministic source with a hard alpha edge and non-zero RGB under zero alpha. */
function sourceBytes(): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(SRC.w * SRC.h * 4)
  for (let y = 0; y < SRC.h; y++) {
    for (let x = 0; x < SRC.w; x++) {
      const p = (y * SRC.w + x) * 4
      out[p] = (x * 6 + 1) % 256
      out[p + 1] = (y * 9 + 40) % 256
      out[p + 2] = (x * y * 3 + 17) % 256
      // Non-zero RGB survives under zero alpha only if nothing premultiplied on the way in.
      out[p + 3] = x < 6 || x > 33 || y < 6 || y > 33 ? 0 : 255
    }
  }
  return out
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

describe('the front texture under exact: opaque texels match the source, transparent texels are exactly zero', () => {
  /**
   * Ruling 1: the oracle is split by the *source's own* alpha, not compared whole against the raw
   * source bytes. At `uEdgeMode == 2` (see the file header) `outColor` is exactly `(0,0,0,0)`
   * wherever the source's alpha was 0, and byte-identical to the source wherever it was 255 — this
   * fixture's alpha is only ever 0 or 255 (`sourceBytes` above), so the two classes partition every
   * texel of A and nothing is left unasserted. Measured: of the 1600 texels in the 40x40 artwork
   * rect, all 784 alpha-255 texels match the source byte for byte and all 816 alpha-0 texels read
   * exactly `(0,0,0,0)`, with zero exceptions in either class.
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

    const zero = new Array(empty.length * 4).fill(0)
    const wantZero = new Uint8Array(got.length)
    expect(firstDifferencesAt(got, wantZero, empty, handle.artwork.w)).toEqual([])
    expect(pickTexels(got, empty)).toEqual(zero)

    sheet.releaseFront(front)
    sheet.dispose()
  })

  /**
   * Ruling 2: `maxSize: 32` is chosen, not the brief's `64`, because at the shipped hull overscan
   * (0.101, not §8.6's illustrative 0.09) `artworkLongSide(maxSize, overscan) =
   * ceil(maxSize / (1 + 2*overscan))`. At `maxSize: 64` that is `ceil(64 / 1.202) = 54`, which is
   * NOT `< SRC.w (40)` — no reduction happens at all. `maxSize: 32` gives `ceil(32 / 1.202) = 27`,
   * a clean margin under 40.
   *
   * Ruling 3: the oracle is measured, not assumed. A reduction blurs the fixture's hard alpha edge,
   * so `identityResample`'s TypeScript reference carries partial alpha in a ring around the old
   * edge. Measured directly against this fixture at `maxSize: 32` (729 texels total): the front's
   * `uEdgeMode == 2` coverage mask reproduces the reference exactly on both the 289 texels where
   * the reference's own alpha is 255 (all four channels, zero mismatches) and the 368 texels where
   * it is 0 (front reads exactly `(0,0,0,0)`, zero mismatches) — but NOT on the 72 texels in
   * between, where the reference carries partial alpha: every one of those 72 mismatches, on both
   * RGB and alpha (e.g. texel 112: reference `(39,97,136,232)`, front `(53,107,143,249)` — off by
   * double digits on every channel). That rules out rung 1 (whole-rect exact) and rung 2 (whole-rect
   * alpha exact); rung 3 — assert only the reference's alpha-255 and alpha-0 texels, leave the
   * partial-alpha ring unasserted — is the highest rung this measurement supports, and holds with
   * zero exceptions in both classes it covers.
   */
  it("matches P5's TypeScript reference on a reduction, on the texels the front reproduces exactly", async () => {
    const ctx = open()
    const sheet = paperSheet()
    expect(sheet.mount(ctx)).toBeUndefined()
    const bitmap = await sourceBitmap()
    const handle = await sheet.source(bitmap, { maxSize: 32, exact: false })
    bitmap.close()
    if (GlError.is(handle) || SheetError.is(handle) || isAborted(handle)) {
      return expect.fail(`source() refused: ${String(handle)}`)
    }
    expect(handle.artwork.w).toBeLessThan(SRC.w)

    const front = sheet.build(handle, { w: 32, h: 32 }, defaultsFor('hull') as never)
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
    // Every texel is one of these three classes; `partial` (measured non-empty for this fixture at
    // this reduction) is deliberately left unasserted — see the doc comment above.
    expect(opaque.length + empty.length + partial.length).toBe(handle.artwork.w * handle.artwork.h)

    expect(firstDifferencesAt(got, reference, opaque, handle.artwork.w)).toEqual([])
    expect(pickTexels(got, opaque)).toEqual(pickTexels(reference, opaque))

    const zero = new Array(empty.length * 4).fill(0)
    const wantZero = new Uint8Array(got.length)
    expect(firstDifferencesAt(got, wantZero, empty, handle.artwork.w)).toEqual([])
    expect(pickTexels(got, empty)).toEqual(zero)

    sheet.releaseFront(front)
    sheet.dispose()
  })
})
