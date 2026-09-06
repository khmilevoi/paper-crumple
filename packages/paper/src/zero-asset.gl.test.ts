/**
 * # The zero-asset path against a flat-normal reference (§14, §14.1)
 *
 * §14 claims `tiles: null` gives "exactly the render with the photograph turned off". §14.1 shows
 * the spike's `[128, 128, 255, 128]` did not, because Chromium premultiplies an `ImageBitmap` and
 * `UNPACK_PREMULTIPLY_ALPHA_WEBGL` is ignored for that source, so the shader read `0.251` — a
 * `(-0.5, -0.5)` tilt. This is the tier that turns the corrected claim into a test **so it cannot
 * quietly become false a second time**.
 *
 * Three arms, and the third is what gives the first two teeth:
 *
 * 1. `tiles: null` — the shipped zero-asset path, four 1x1 `R8` textures at `NEUTRAL_TILE_BYTE`.
 * 2. A flat-normal reference — the same value delivered the ordinary way, through the decode and
 *    upload path a real tile takes. Must agree with (1) byte for byte.
 * 3. The spike's effective value, `round(128 * 128 / 255) = 64`. Must **not** agree, or the
 *    comparison above is vacuous.
 *
 * **A named exception to "raw bytes, never PNGs" (§7.4.1):** the decode and upload path is what
 * arms 2 and 3 are testing, so they must go through it.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { GlError, SheetError, isAborted } from '@paper-crumple/core'
import { defaultsFor } from './paper-knobs.js'
import { NEUTRAL_TILE_BYTE } from './paper-tiles.js'
import { paperSheet } from './sheet.js'
import type { PaperTileSet } from './tile-set.js'
import { createGlFixture, type PaperGlFixture } from './testing/gl-fixture.js'
import { SMOOTH_CLEAN } from './testing/edge-cells.js'

let fixture: PaperGlFixture | null = null
const revoke: string[] = []
afterEach(() => {
  for (const url of revoke.splice(0)) URL.revokeObjectURL(url)
  fixture?.dispose()
  fixture = null
})

function open() {
  fixture = createGlFixture(8, 8)
  expect(fixture.gl, 'no WebGL2 context — check the SwiftShader launch flags (§11)').not.toBeNull()
  return fixture.ctx
}

/** The spike's constant as the shader actually read it (§14.1): `round(128 * 128 / 255)`. */
const SPIKE_EFFECTIVE_BYTE = Math.round((128 * 128) / 255)

/** One 1x1 opaque grayscale image at `byte`, as an object URL the tile loader can fetch. */
async function grayTile(byte: number): Promise<URL | Error> {
  const canvas = new OffscreenCanvas(1, 1)
  const c2d = canvas.getContext('2d')
  if (c2d === null) return new GlError('zero-asset: no 2D context for the tile fixture')
  // Opaque: an image with no alpha to be premultiplied by is the whole point of §14.1's fix.
  c2d.fillStyle = `rgb(${byte}, ${byte}, ${byte})`
  c2d.fillRect(0, 0, 1, 1)
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  const url = URL.createObjectURL(blob)
  revoke.push(url)
  return new URL(url)
}

async function tileSetAt(byte: number): Promise<PaperTileSet | Error> {
  const one = await grayTile(byte)
  if (one instanceof Error) return one
  // The same plane four times: this fixture is about the constant, not about the crease detail.
  return { crumpleR: one, crumpleG: one, crumpleA: one, fibreA: one }
}

async function sprite(): Promise<ImageBitmap> {
  const w = 48
  const h = 48
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4
      data[p] = 200
      data[p + 1] = 120
      data[p + 2] = 60
      data[p + 3] = x >= 6 && x < 42 && y >= 6 && y < 42 ? 255 : 0
    }
  }
  return createImageBitmap(new ImageData(data, w, h), {
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none',
  })
}

const FRONT = { w: 128, h: 128 }

/** Builds one front with the given tiles and returns its texels. */
async function render(
  ctx: ReturnType<typeof open>,
  tiles: PaperTileSet | null,
): Promise<Uint8Array | Error> {
  const sheet = paperSheet({ tiles })
  const mounted = sheet.mount(ctx)
  if (mounted !== undefined) return mounted
  const ready = await sheet.tilesReady
  if (ready !== true) return ready
  const bitmap = await sprite()
  const handle = await sheet.source(bitmap, { maxSize: FRONT.w, exact: false })
  bitmap.close()
  if (GlError.is(handle) || SheetError.is(handle)) return handle
  if (isAborted(handle)) return new GlError('zero-asset: source() aborted with no signal given')
  const front = sheet.build(handle, FRONT, defaultsFor(SMOOTH_CLEAN) as never)
  if (front instanceof Error) return front

  const out = new Uint8Array(front.width * front.height * 4)
  const probe = ctx.gl.createFramebuffer()
  ctx.scope(() => {
    ctx.gl.bindFramebuffer(ctx.gl.READ_FRAMEBUFFER, probe)
    ctx.gl.framebufferTexture2D(
      ctx.gl.READ_FRAMEBUFFER,
      ctx.gl.COLOR_ATTACHMENT0,
      ctx.gl.TEXTURE_2D,
      front.texture,
      0,
    )
    ctx.gl.readPixels(0, 0, front.width, front.height, ctx.gl.RGBA, ctx.gl.UNSIGNED_BYTE, out)
    ctx.gl.bindFramebuffer(ctx.gl.READ_FRAMEBUFFER, null)
  })
  ctx.gl.deleteFramebuffer(probe)
  sheet.releaseFront(front)
  sheet.dispose()
  return out
}

function differingTexels(a: Uint8Array, b: Uint8Array): number {
  let n = 0
  for (let p = 0; p < a.length; p += 4) {
    if (a[p] !== b[p] || a[p + 1] !== b[p + 1] || a[p + 2] !== b[p + 2] || a[p + 3] !== b[p + 3]) {
      n += 1
    }
  }
  return n
}

describe('the zero-asset path is the render with the photograph turned off (§14, §14.1)', () => {
  it('agrees with a flat-normal reference delivered through the real decode and upload path', async () => {
    const ctx = open()
    const flat = await tileSetAt(NEUTRAL_TILE_BYTE)
    if (flat instanceof Error) return expect.fail(flat.message)

    const zero = await render(ctx, null)
    if (zero instanceof Error) return expect.fail(zero.message)
    const reference = await render(ctx, flat)
    if (reference instanceof Error) return expect.fail(reference.message)

    expect(differingTexels(zero, reference)).toBe(0)
  })

  it("does not agree with the spike's constant, which is what §14.1 says was false", async () => {
    const ctx = open()
    const spike = await tileSetAt(SPIKE_EFFECTIVE_BYTE)
    if (spike instanceof Error) return expect.fail(spike.message)

    const zero = await render(ctx, null)
    if (zero instanceof Error) return expect.fail(zero.message)
    const asSpike = await render(ctx, spike)
    if (asSpike instanceof Error) return expect.fail(asSpike.message)

    // If this ever reaches 0, the comparison above has become vacuous and the claim §14.1 corrected
    // could quietly become false again without anything going red. Measured on the level-2 lane:
    // 316 of the 16384 texels of the 128x128 front differ on this arm — recorded here because it
    // is the margin the `toBeGreaterThan(0)` is standing on, and a drift towards 0 is the failure
    // this assertion exists to catch.
    expect(differingTexels(zero, asSpike)).toBeGreaterThan(0)
  })

  it("records the re-derived constant, so a copy of the spike's value cannot creep back", () => {
    // Only `NEUTRAL_TILE_BYTE` pins shipped source: it is imported from `paper-tiles.ts`, so a
    // change there goes red here. `SPIKE_EFFECTIVE_BYTE` is computed locally at the top of this
    // file, so the two assertions that mention it pin this file's own arithmetic — the spike's
    // value is not shipped anywhere and there is nothing else to pin it against.
    expect(NEUTRAL_TILE_BYTE).toBe(128)
    expect(SPIKE_EFFECTIVE_BYTE).toBe(64)
    // 128/255 = 0.50196: a residual tilt of 0.00392 against a 0.5 centre, 127x smaller than the
    // spike's -0.498. 0.5 is not representable in an 8-bit plane, so this is the smallest one
    // admits.
    expect(Math.abs(NEUTRAL_TILE_BYTE / 255 - 0.5)).toBeLessThan(0.004)
    expect(Math.abs(SPIKE_EFFECTIVE_BYTE / 255 - 0.5)).toBeGreaterThan(0.24)
  })
})
