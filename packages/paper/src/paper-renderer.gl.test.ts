import { afterEach, describe, expect, it } from 'vitest'
import { GlError } from '@paper-crumple/core'
import { createScratchPools, drawTargetFor } from '@paper-crumple/core/unstable'
import type { ScratchPools } from '@paper-crumple/core/unstable'
import { createGlFixture, type PaperGlFixture } from './testing/gl-fixture.js'
import { createSdfBuilder, SDF_POOL_SLOTS, sigmaFor } from './gl-sdf.js'
import { createPaperRenderer } from './paper-renderer.js'
import { mountNeutralTiles } from './paper-tiles.js'
import { defaultsFor, descriptorsFor } from './paper-knobs.js'

type Err = InstanceType<typeof GlError>

let fixture: PaperGlFixture | null = null
let pools: ScratchPools | null = null

afterEach(() => {
  pools?.dispose()
  pools = null
  // §4.0 caps live WebGL2 contexts at roughly sixteen and Vitest opens one page per file.
  fixture?.dispose()
  fixture = null
})

const FRONT = { w: 96, h: 96 }
const ARTWORK = { w: 64, h: 64 }
const ARTWORK_RECT = { x: 16, y: 16, w: 64, h: 64 }
const FIELD = 64

/** A centred opaque square, as RGBA8UI bytes: solid red inside, fully transparent outside. */
function square(w: number, h: number, r: number): Uint8Array {
  const out = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inside = Math.abs(x - w / 2) < r && Math.abs(y - h / 2) < r
      const p = (y * w + x) * 4
      out[p] = 255
      out[p + 3] = inside ? 255 : 0
    }
  }
  return out
}

/**
 * Fully opaque, as RGBA8UI bytes — everywhere, not just a centred region. This is a synthetic
 * paper mask, not artwork (ruling R28): `buildField`'s own `BuildFieldOptions.artwork` doc
 * comment (`gl-sdf.ts:224`) says pass A does not care whether its `RGBA8UI` source is the artwork
 * or the hull mask, so uploading this through the same pass A `artwork` builds a real
 * `paperField`, the one `uEdgeMode = 1` (`'hull'` with a real paper field) needs.
 */
function opaqueMask(w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h * 4)
  for (let i = 3; i < out.length; i += 4) out[i] = 255
  return out
}

// No `throw`, including here (spec §10.8: only the named boundary helpers may throw). Every step
// below that can fail returns its `GlError` instead, and the caller — ultimately each `it()` —
// asserts it away with the landed idiom (`expect(GlError.is(x)).toBe(false)` then
// `if (GlError.is(x)) return`) before touching the value.
function scene() {
  fixture = createGlFixture(8, 8)
  expect(fixture.gl, 'no WebGL2 context — check the SwiftShader launch flags (§11)').not.toBeNull()
  const ctx = fixture.ctx
  pools = createScratchPools({ gl: ctx, artwork: ARTWORK, sdfRes: FIELD })
  const artwork = pools.poolA.holdArtwork('k', {
    width: ARTWORK.w,
    height: ARTWORK.h,
    format: 'RGBA8UI',
    filter: 'NEAREST',
    label: 'artwork:k',
  })
  if (GlError.is(artwork)) return artwork
  ctx.scope(() => {
    const { gl } = ctx
    gl.bindTexture(gl.TEXTURE_2D, artwork.handle)
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      ARTWORK.w,
      ARTWORK.h,
      gl.RGBA_INTEGER,
      gl.UNSIGNED_BYTE,
      square(ARTWORK.w, ARTWORK.h, 20),
    )
  })
  const builder = createSdfBuilder(ctx, pools.poolA)
  if (GlError.is(builder)) return builder
  const p = (FRONT.w - ARTWORK.w) / 2 / ARTWORK.w
  const scale = FRONT.w / ARTWORK.w
  const tight = builder.buildField({
    artwork,
    artworkUv: [scale, scale, -p * scale, -p * scale],
    width: FIELD,
    height: FIELD,
    sourceLongSide: FRONT.w,
  })
  if (GlError.is(tight)) return tight
  const loose = builder.blurField({
    field: tight,
    sigmaPx: sigmaFor(0.5, FRONT.w),
    frontLongSide: FRONT.w,
  })
  if (GlError.is(loose)) return loose

  // Ruling R28: `edgeMode: 'hull'` with `paperField: null` selects `uEdgeMode = 2`, the
  // degenerate "sheet IS the artwork alpha" mode (`paper.js:117`), which by design carries no
  // margin — asserting a margin under that combination is unsatisfiable, not a renderer bug. A
  // test that wants paper in the margin must drive the real hull path, `uEdgeMode = 1`, which
  // needs a real `paperField`. This uploads a synthetic `RGBA8UI` mask, opaque across its whole
  // texture, and runs it through the landed `buildField` (own `BuildFieldOptions.artwork` doc
  // comment, `gl-sdf.ts:224`: "the RGBA8UI artwork, or the RGBA8UI hull mask — pass A does not
  // care which"). The identity `artworkUv` maps the field 1:1 onto the mask, so the resulting
  // field reads "inside" everywhere except right at the front's own outer edge — comfortably
  // covering `at(10, 48)`, this suite's margin sample, well outside `ARTWORK_RECT`. Built into
  // its own `SDF_POOL_SLOTS.hullField` slot so it never displaces `tight`'s target.
  const paperMask = ctx.texture({
    width: ARTWORK.w,
    height: ARTWORK.h,
    format: 'RGBA8UI',
    filter: 'NEAREST',
    label: 'paper-mask',
  })
  if (GlError.is(paperMask)) return paperMask
  ctx.scope(() => {
    const { gl } = ctx
    gl.bindTexture(gl.TEXTURE_2D, paperMask.handle)
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      ARTWORK.w,
      ARTWORK.h,
      gl.RGBA_INTEGER,
      gl.UNSIGNED_BYTE,
      opaqueMask(ARTWORK.w, ARTWORK.h),
    )
  })
  const paperField = builder.buildField({
    artwork: paperMask,
    artworkUv: [1, 1, 0, 0],
    width: FIELD,
    height: FIELD,
    sourceLongSide: FRONT.w,
    slot: SDF_POOL_SLOTS.hullField,
  })
  if (GlError.is(paperField)) return paperField

  const tiles = mountNeutralTiles(ctx)
  if (GlError.is(tiles)) return tiles
  return { ctx, artwork, tight, loose, tiles, builder, paperMask, paperField }
}

/**
 * `withPaperField`: pass the real synthetic `paperField` (drives `uEdgeMode = 1`, the actual hull
 * path) or `null` (drives `uEdgeMode = 2`, "the sheet IS the artwork alpha" — ruling R28).
 */
function renderInto(mode: 'hull' | 'torn', withPaperField: boolean) {
  const built = scene()
  if (GlError.is(built)) return built
  const { ctx, artwork, tight, loose, tiles, paperMask, paperField } = built
  const front = ctx.texture({
    width: FRONT.w,
    height: FRONT.h,
    format: 'RGBA8',
    filter: 'LINEAR',
    label: 'front',
  })
  if (GlError.is(front)) return front
  const target = ctx.target(front)
  if (GlError.is(target)) return target
  const renderer = createPaperRenderer(ctx)
  if (GlError.is(renderer)) return renderer
  const failed = renderer.renderFront(tiles, {
    target: drawTargetFor(target),
    front: FRONT,
    artworkRect: ARTWORK_RECT,
    artwork,
    tight,
    loose,
    paperField: withPaperField ? paperField : null,
    edgeMode: mode,
    values: defaultsFor(mode),
    descriptors: descriptorsFor(mode),
  })
  expect(failed, failed?.message).toBeUndefined()
  if (failed !== undefined) return failed
  const out = new Uint8Array(FRONT.w * FRONT.h * 4)
  ctx.scope(() => {
    // `DrawScope.bindTarget` binds `DRAW_FRAMEBUFFER` only; `readPixels` reads
    // `READ_FRAMEBUFFER`, so this needs its own explicit bind (gl-sdf.gl.test.ts,
    // artwork.gl.test.ts) — without it this silently reads the fixture's own tiny canvas
    // instead of `target`, and the test would pass while testing nothing.
    ctx.gl.bindFramebuffer(ctx.gl.READ_FRAMEBUFFER, target.framebuffer)
    ctx.gl.readPixels(0, 0, FRONT.w, FRONT.h, ctx.gl.RGBA, ctx.gl.UNSIGNED_BYTE, out)
  })
  const at = (x: number, y: number) =>
    out.subarray((y * FRONT.w + x) * 4, (y * FRONT.w + x) * 4 + 4)
  return {
    out,
    at,
    cleanup: () => {
      target.dispose()
      front.dispose()
      renderer.dispose()
      tiles.dispose()
      paperMask.dispose()
    },
  }
}

function expectOk<T>(v: Err | T): T {
  expect(GlError.is(v), GlError.is(v) ? v.message : '').toBe(false)
  if (GlError.is(v)) return v as never
  return v
}

describe('the front build (edge.js:86)', () => {
  // Ruling R28: `'hull'` + a real `paperField` is `uEdgeMode = 1`, the genuine hull path — the
  // one with a margin at all, and the one `source()` uses in production.
  it('puts the artwork inside and paper in the margin around it', () => {
    const { at, cleanup } = expectOk(renderInto('hull', true))
    // Centre: the artwork's red square, composited over the sheet.
    expect(at(48, 48)[0]).toBeGreaterThan(200)
    expect(at(48, 48)[3]).toBe(255)
    // Just outside the artwork rect but inside the hull: opaque paper, not the artwork's red.
    const margin = at(10, 48)
    expect(margin[3]).toBeGreaterThan(200)
    // The artwork's own red carries G = B = 0 (`square()`'s own bytes); `paperColor`'s default
    // (`#f7f4ed`) does not, and R alone is a weak discriminator here since both the artwork's red
    // and the near-white default `paperColor` read high on that channel.
    expect(margin[1]).toBeGreaterThan(150)
    expect(margin[2]).toBeGreaterThan(150)
    cleanup()
  })

  // Ruling R28: `'hull'` + `paperField: null` is `uEdgeMode = 2` — `paper.js:117`'s "hull with
  // minDist = maxDist = 0: the sheet IS the artwork alpha". That is correct, not a bug, and reads
  // as no margin at all: the same point that is paper under a real hull field (above) is
  // transparent here, because nothing paper-shaped exists beyond the artwork's own alpha.
  it('is the artwork alpha with no margin when no paper field is supplied (paper.js:117)', () => {
    const { at, cleanup } = expectOk(renderInto('hull', false))
    expect(at(48, 48)[0]).toBeGreaterThan(200)
    expect(at(48, 48)[3]).toBe(255)
    expect(at(10, 48)[3]).toBe(0)
    cleanup()
  })

  it('leaves the outer corner of the front transparent', () => {
    const { at, cleanup } = expectOk(renderInto('hull', false))
    expect(at(1, 1)[3]).toBe(0)
    cleanup()
  })

  it('produces a different silhouette in torn mode than in hull mode', () => {
    const hull = expectOk(renderInto('hull', false))
    const alphaHull = Array.from(hull.out)
      .filter((_, i) => i % 4 === 3)
      .reduce((a, b) => a + b, 0)
    hull.cleanup()
    const torn = expectOk(renderInto('torn', false))
    const alphaTorn = Array.from(torn.out)
      .filter((_, i) => i % 4 === 3)
      .reduce((a, b) => a + b, 0)
    torn.cleanup()
    expect(alphaHull).not.toBe(alphaTorn)
  })
})
