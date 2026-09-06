import { afterEach, describe, expect, it } from 'vitest'
import { GlError, KNOB_REFERENCE_PX } from '@paper-crumple/core'
import { createScratchPools, drawTargetFor } from '@paper-crumple/core/unstable'
import type { EdgeSpec, GlContext, Program, ScratchPools } from '@paper-crumple/core/unstable'
import { createGlFixture, type PaperGlFixture } from './testing/gl-fixture.js'
import { CHEW_REACH, midHigh, tearAmpsFor } from './edge-derive.js'
import { createSdfBuilder, SDF_POOL_SLOTS, sigmaFor } from './gl-sdf.js'
import type { Field } from './gl-sdf.js'
import { createPaperRenderer } from './paper-renderer.js'
import type { FrontRenderRequest, PaperRenderer } from './paper-renderer.js'
import { PAPER_FS, PAPER_UNIFORMS } from './paper-shader.js'
import { mountNeutralTiles } from './paper-tiles.js'
import type { MountedTiles } from './paper-tiles.js'
import { defaultsFor, descriptorsFor } from './paper-knobs.js'
import {
  ALL_FOUR_CELLS as CELLS,
  SMOOTH_CLEAN,
  SMOOTH_PAPER,
  TORN_PAPER,
} from './testing/edge-cells.js'

type Err = InstanceType<typeof GlError>

// Arrays, not a single mutable slot: `scene()` runs once per `renderInto()` call, and the one
// test below (`'produces a different silhouette under torn than under smooth'`) calls
// `renderInto()` twice. A single `let fixture` / `let pools` reassigned by the second call would
// orphan the first call's whole WebGL2 context and `ScratchPools` — `afterEach` would then only
// ever dispose the last one, not every one the test opened. §4.0 caps live WebGL2 contexts at
// roughly sixteen and Vitest opens one page per file, so an orphaned context here is not idle
// bookkeeping — six contexts deep already, it is most of the budget.
const fixtures: PaperGlFixture[] = []
const poolsList: ScratchPools[] = []

afterEach(() => {
  for (const p of poolsList) p.dispose()
  poolsList.length = 0
  for (const f of fixtures) f.dispose()
  fixtures.length = 0
})

const FRONT = { w: 96, h: 96 }
const ARTWORK = { w: 64, h: 64 }
const ARTWORK_RECT = { x: 16, y: 16, w: 64, h: 64 }
const FIELD = 64
/** Working px per reference px on this front — what `scaleKnob` applies (spec 6.4). */
const PX = FRONT.h / KNOB_REFERENCE_PX
/** The width knob's own shipped default, in reference px; never a literal (§2.1). */
const WIDTH_REF = Number(defaultsFor(TORN_PAPER).edgeWidth)

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
 * or the hull mask, so uploading this through the same pass A builds a real polygon field — the
 * one `edgeShape: 'smooth'` binds to BOTH `uSdfTight` and `uSdfLoose` (design 2026-09-05 §6).
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
  const fixture = createGlFixture(8, 8)
  expect(fixture.gl, 'no WebGL2 context — check the SwiftShader launch flags (§11)').not.toBeNull()
  fixtures.push(fixture)
  const ctx = fixture.ctx
  const pools = createScratchPools({ gl: ctx, artwork: ARTWORK, sdfRes: FIELD })
  poolsList.push(pools)
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
    artworkUv: [scale, scale, -p, -p],
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

  // Ruling R28, re-pointed at design 2026-09-05 §6: `shape: 'smooth'` with `paperField: null`
  // falls back to `r.tight`, so the sheet IS the artwork alpha and carries no margin — asserting
  // a margin under that combination is unsatisfiable, not a renderer bug. A test that wants paper
  // in the margin must supply a real polygon field. This uploads a synthetic `RGBA8UI` mask,
  // opaque across its whole texture, and runs it through the landed `buildField` (own
  // `BuildFieldOptions.artwork` doc comment, `gl-sdf.ts:224`: "the RGBA8UI artwork, or the
  // RGBA8UI hull mask — pass A does not care which"). The identity `artworkUv` maps the field 1:1
  // onto the mask, so the resulting field reads "inside" everywhere except right at the front's
  // own outer edge — comfortably covering `at(10, 48)`, this suite's margin sample, well outside
  // `ARTWORK_RECT`. Built into its own `SDF_POOL_SLOTS.hullField` slot so it never displaces
  // `tight`'s target.
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
 * `withPaperField`: pass the real synthetic polygon field (design §6's `smooth` cell with a
 * polygon built) or `null` (no polygon — `smooth` then falls back to `r.tight` and the sheet is
 * the artwork alpha, ruling R28).
 */
function renderInto(spec: EdgeSpec, withPaperField: boolean) {
  const built = scene()
  if (GlError.is(built)) return built
  const { ctx, artwork, tight, loose, tiles, builder, paperMask, paperField } = built
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
    edgeSpec: spec,
    widthRef: WIDTH_REF,
    values: defaultsFor(spec),
    descriptors: descriptorsFor(spec),
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
      // `scene()`'s `builder` was never disposed here before, leaking its four programs and
      // cached framebuffers per test.
      builder.dispose()
    },
  }
}

function expectOk<T>(v: Err | T): T {
  expect(GlError.is(v), GlError.is(v) ? v.message : '').toBe(false)
  if (GlError.is(v)) return v as never
  return v
}

/**
 * Records what `renderFront` uploaded. `Program.uniformLocation` is memoised per name, so the
 * locations are stable within one program and can be reversed into names once.
 *
 * It monkey-patches the LIVE context's `uniform1f` / `uniform1i` / `activeTexture` /
 * `bindTexture`, so the `try/finally` restore is load-bearing: leave one of the four patched and
 * every later test in the file draws through a closure over a disposed capture. The restore is
 * asserted, not assumed — see `'restores the context even when the run fails'` below (ruling R14).
 */
function captureUniforms(
  ctx: GlContext,
  program: { uniformLocation(name: string): WebGLUniformLocation | null },
  run: () => Err | undefined,
): {
  floats: Record<string, number>
  ints: Record<string, number>
  textures: Record<string, WebGLTexture | null>
} {
  const byLocation = new Map<WebGLUniformLocation, string>()
  for (const [key, name] of Object.entries(PAPER_UNIFORMS)) {
    const loc = program.uniformLocation(name)
    if (loc !== null) byLocation.set(loc, key)
  }
  const floats: Record<string, number> = {}
  const ints: Record<string, number> = {}
  const textures: Record<string, WebGLTexture | null> = {}
  const gl = ctx.gl
  // The UNBOUND originals, kept so the restore below is identity-preserving: restoring a
  // `.bind(gl)` copy would leave the context holding a different function object every time this
  // helper ran, which is exactly what the restore assertion would then fail to notice.
  const was = {
    uniform1f: gl.uniform1f,
    uniform1i: gl.uniform1i,
    activeTexture: gl.activeTexture,
    bindTexture: gl.bindTexture,
  }
  const realFloat = was.uniform1f.bind(gl)
  const realInt = was.uniform1i.bind(gl)
  let unit = 0
  const realActive = was.activeTexture.bind(gl)
  const bound = new Map<number, WebGLTexture | null>()
  const realBind = was.bindTexture.bind(gl)
  gl.uniform1f = (loc, v) => {
    if (loc !== null) floats[byLocation.get(loc) ?? '?'] = v
    realFloat(loc, v)
  }
  gl.uniform1i = (loc, v) => {
    const key = loc === null ? '?' : (byLocation.get(loc) ?? '?')
    ints[key] = v
    textures[key] = bound.get(v) ?? null
    realInt(loc, v)
  }
  gl.activeTexture = (t) => {
    unit = t - gl.TEXTURE0
    realActive(t)
  }
  gl.bindTexture = (target, tex) => {
    bound.set(unit, tex)
    realBind(target, tex)
  }
  try {
    expectOk(run())
  } finally {
    gl.uniform1f = was.uniform1f
    gl.uniform1i = was.uniform1i
    gl.activeTexture = was.activeTexture
    gl.bindTexture = was.bindTexture
  }
  return { floats, ints, textures }
}

interface UniformScene {
  readonly ctx: GlContext
  readonly program: Program
  readonly renderer: PaperRenderer
  readonly tiles: MountedTiles
  readonly polygon: Field
  readonly base: FrontRenderRequest
  cleanup(): void
}

/**
 * The whole program, every path compiled in (`PAPER_FRONT_BUILD 0`) — the same test-only string
 * replace `paper-shader-early-out.gl.test.ts` uses.
 *
 * The front build compiles the fold and flap-shadow paths out (P7), and a uniform no surviving
 * statement reads is optimised away by the driver: `uFlapReach` HAS no location in the shipped
 * program, so a capture of it there records nothing at all. Its value is still `renderFront`'s to
 * get right — the 3D layer's poses read it — so the one test that pins it compiles the flap paths
 * back in.
 */
const PAPER_FS_WHOLE = PAPER_FS.replace(
  '#define PAPER_FRONT_BUILD 1',
  '#define PAPER_FRONT_BUILD 0',
)

/**
 * A scene that can be asked what the renderer UPLOADED, not only what it drew.
 *
 * Two things make this more than `renderInto` with a spy. `createPaperRenderer` keeps its
 * `Program` private, and a uniform location is a per-program object — a second
 * `ctx.program(FULLSCREEN_VS, PAPER_FS)` would hand back locations that never equal the ones
 * `renderFront` uploads through — so the context is spread with one method replaced (the idiom
 * `paper-shader-early-out.gl.test.ts` uses) to keep a reference to the renderer's OWN program.
 * And `Program.uniformLocation` memoises `null` as eagerly as it memoises a location
 * (`gl-context.ts`'s `locations` map), so asking before the link has completed poisons every name
 * for the life of the program: `await renderer.ready()` before the first `uniformLocation` call is
 * what keeps this capture from being vacuous.
 *
 * `fs` compiles a variant of `PAPER_FS` in the renderer's place — used by the one test that needs
 * a uniform the front build optimises away (see `PAPER_FS_WHOLE`).
 */
async function uniformScene(fs: string | null = null): Promise<Err | UniformScene> {
  const built = scene()
  if (GlError.is(built)) return built
  const { ctx, artwork, tight, loose, tiles, builder, paperMask, paperField } = built
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

  const programs: Program[] = []
  const spy: GlContext = {
    ...ctx,
    program: (vs, source, label) => {
      const made = ctx.program(vs, fs !== null && source === PAPER_FS ? fs : source, label)
      if (!GlError.is(made)) programs.push(made)
      return made
    },
  }
  const renderer = createPaperRenderer(spy)
  if (GlError.is(renderer)) return renderer
  const linked = await renderer.ready()
  if (linked !== undefined) return linked
  const program = programs[0]
  if (program === undefined) return new GlError('createPaperRenderer created no program')

  const base: FrontRenderRequest = {
    target: drawTargetFor(target),
    front: FRONT,
    artworkRect: ARTWORK_RECT,
    artwork,
    tight,
    loose,
    paperField: null,
    edgeSpec: SMOOTH_CLEAN,
    widthRef: WIDTH_REF,
    // The widest cell's bag and descriptors, so every knob each test overrides below is one the
    // descriptor set actually declares — a bag missing `chew` would make `tearAmpsFor`'s budget
    // and the shader's teeth disagree for a reason that has nothing to do with the binding
    // (ruling R3).
    values: defaultsFor(TORN_PAPER),
    descriptors: descriptorsFor(TORN_PAPER),
  }
  return {
    ctx,
    program,
    renderer,
    tiles,
    polygon: paperField,
    base,
    cleanup() {
      target.dispose()
      front.dispose()
      renderer.dispose()
      tiles.dispose()
      paperMask.dispose()
      builder.dispose()
    },
  }
}

describe('the front build (edge.js:86)', () => {
  // design §6: `smooth` with a real polygon field binds that field to BOTH slots, so the sheet is
  // the polygon's own contour — the case with a margin at all, and the one `source()` uses in
  // production.
  it('puts the artwork inside and paper in the margin around it', () => {
    const { at, cleanup } = expectOk(renderInto(SMOOTH_PAPER, true))
    // Centre: the artwork's red square, composited over the sheet.
    expect(at(48, 48)[0]).toBeGreaterThan(200)
    expect(at(48, 48)[3]).toBe(255)
    // Just outside the artwork rect but inside the polygon: opaque paper, not the artwork's red.
    const margin = at(10, 48)
    expect(margin[3]).toBeGreaterThan(200)
    // The artwork's own red carries G = B = 0 (`square()`'s own bytes); `paperColor`'s default
    // (`#f7f4ed`) does not, and R alone is a weak discriminator here since both the artwork's red
    // and the near-white default `paperColor` read high on that channel.
    expect(margin[1]).toBeGreaterThan(150)
    expect(margin[2]).toBeGreaterThan(150)
    cleanup()
  })

  // design §6: `smooth` with `paperField: null` has no polygon to bind, so both slots fall back to
  // the artwork's own tight field and `uBaseBias` is 0 — the sheet IS the artwork alpha, which
  // reads as no margin at all: the same point that is paper under a real polygon field (above) is
  // transparent here.
  it('is the artwork alpha with no margin when no polygon field is supplied (design §6)', () => {
    const { at, cleanup } = expectOk(renderInto(SMOOTH_PAPER, false))
    expect(at(48, 48)[0]).toBeGreaterThan(200)
    expect(at(48, 48)[3]).toBe(255)
    expect(at(10, 48)[3]).toBe(0)
    cleanup()
  })

  it('leaves the outer corner of the front transparent', () => {
    const { at, cleanup } = expectOk(renderInto(SMOOTH_PAPER, false))
    expect(at(1, 1)[3]).toBe(0)
    cleanup()
  })

  it('produces a different silhouette under torn than under smooth', () => {
    const smooth = expectOk(renderInto(SMOOTH_PAPER, false))
    const alphaSmooth = Array.from(smooth.out)
      .filter((_, i) => i % 4 === 3)
      .reduce((a, b) => a + b, 0)
    smooth.cleanup()
    const torn = expectOk(renderInto(TORN_PAPER, false))
    const alphaTorn = Array.from(torn.out)
      .filter((_, i) => i % 4 === 3)
      .reduce((a, b) => a + b, 0)
    torn.cleanup()
    expect(alphaSmooth).not.toBe(alphaTorn)
  })

  /**
   * The guard against the failure mode this task was dispatched to fix: while the renderer
   * uploaded to uniform names `PAPER_UNIFORMS` no longer carried, `loc(...)` resolved to `null`,
   * `gl-context.ts` cached that `null`, `uEdgeWidth` / `uBaseBias` / `uEdgeFinish` all read 0, and
   * every cell rendered the SAME front — the `edgeWidth = 0` one. A suite that sweeps four cells
   * and renders one is worse than no suite, so the four fronts are asserted to be four fronts.
   *
   * The sum is over ALL bytes, not the alpha plane alone: `finish` at a fixed `shape` changes the
   * deckle band's colour and the fibre fringe long before it changes the silhouette's coverage.
   *
   * `withPaperField: false` throughout, deliberately — not this suite's synthetic all-opaque
   * polygon field, whose only real contour sits in the last ~2% of the texture, where
   * `paperField()`'s own border guard (`smoothstep(0.482, 0.5, ...) * 1e4`) already forces the
   * field to a huge negative number: the rim, and with it every finish decoration that rides
   * `edgeK()`, falls off the canvas and `smooth`/`clean` and `smooth`/`paper` come back
   * byte-identical for a reason that has nothing to do with the uniforms. `paperField: null`
   * falls back to `r.tight` — the square artwork's own field, with its contour tens of pixels
   * inside the canvas, which is where the finish has room to draw.
   */
  it('renders a different front in each of the four cells (design §6)', () => {
    const sums = CELLS.map((spec) => {
      const r = expectOk(renderInto(spec, false))
      const sum = Array.from(r.out).reduce((a, b) => a + b, 0)
      r.cleanup()
      return sum
    })
    expect(new Set(sums).size).toBe(CELLS.length)
  })
})

describe('design 2026-09-05 §6: the four-cell binding table', () => {
  it('binds the polygon field to both slots under smooth and biases nothing (design §6)', async () => {
    const s = expectOk(await uniformScene())
    const seen = captureUniforms(s.ctx, s.program, () =>
      s.renderer.renderFront(s.tiles, {
        ...s.base,
        paperField: s.polygon,
        edgeSpec: SMOOTH_CLEAN,
        widthRef: WIDTH_REF,
      }),
    )
    expect(seen.textures.sdfTight).toBe(s.polygon.target.texture.handle)
    expect(seen.textures.sdfLoose).toBe(s.polygon.target.texture.handle)
    expect(seen.floats.baseBias).toBe(0)
    expect(seen.floats.edgeWidth).toBeCloseTo(WIDTH_REF * PX, 6)
    expect(seen.floats.tearAmp).toBe(0)
    expect(seen.floats.midAmp).toBe(0)
    expect(seen.floats.chew).toBe(0)
    expect(seen.floats.tearAngular).toBe(0) // baseAngular is gated on this, not on an amplitude
    expect(seen.ints.edgeFinish).toBe(0)
    s.cleanup()
  })

  it('binds the artwork pair under torn and biases by W', async () => {
    const s = expectOk(await uniformScene())
    // `base.values` MUST carry the torn shape knobs, or the resolved values below fall back to
    // the descriptor defaults for a reason that has nothing to do with the binding.
    const values = {
      ...s.base.values,
      edgeVariance: 0.53,
      tearMix: 0.6,
      tearAngular: 0.8,
      chew: 1.8,
    }
    const seen = captureUniforms(s.ctx, s.program, () =>
      s.renderer.renderFront(s.tiles, {
        ...s.base,
        values,
        paperField: null,
        edgeSpec: TORN_PAPER,
        widthRef: WIDTH_REF,
      }),
    )
    expect(seen.textures.sdfTight).toBe(s.base.tight.target.texture.handle)
    expect(seen.textures.sdfLoose).toBe(s.base.loose.target.texture.handle)
    expect(seen.floats.baseBias).toBeCloseTo(WIDTH_REF * PX, 6)
    // Take the expected values from the derivation itself rather than from a rounded literal:
    // `13.218` and `10.4284`, and a 4-digit literal misses by 1e-3 once scaled.
    const amps = tearAmpsFor({
      widthRef: WIDTH_REF,
      variance: 0.53,
      tearMix: 0.6,
      tearAngular: 0.8,
      chew: 1.8,
    })
    expect(seen.floats.tearAmp).toBeCloseTo(amps.tearAmp * PX, 6)
    expect(seen.floats.midAmp).toBeCloseTo(amps.midAmp * PX, 6)
    expect(seen.ints.edgeFinish).toBe(1)
    s.cleanup()
  })

  it('honours the zero rule: at width 0 the finish is off whatever the spec says (design §2.5)', async () => {
    const s = expectOk(await uniformScene())
    const seen = captureUniforms(s.ctx, s.program, () =>
      s.renderer.renderFront(s.tiles, {
        ...s.base,
        paperField: null,
        edgeSpec: TORN_PAPER,
        widthRef: 0,
      }),
    )
    expect(seen.ints.edgeFinish).toBe(0)
    expect(seen.floats.edgeWidth).toBe(0)
    expect(seen.floats.baseBias).toBe(0)
    s.cleanup()
  })

  /**
   * Ruling R3, pinned as a uniform capture rather than as an argument about the source.
   *
   * The knob bag carries ONLY `edgeWidth`: no `tearAngular`, no `chew`, no `tearMix`, no
   * `edgeVariance`. If the derivation and the upload resolve that bag separately — the shape the
   * plan's own snippet had, `tearAmpsFor(rawNum('tearAngular', 0))` against
   * `uniform1f(rawNum('tearAngular', 0.8))` — the amplitudes are normalised by `midLow(0)` while
   * the shader applies `midLow(0.8)`, and the inward reach inflates by 3.8x. One resolved value
   * per knob makes the captured `uTearAngular` and the captured `uMidAmp` agree by construction,
   * which is what this asserts.
   */
  it('resolves one value per edge knob for both the derivation and the upload (ruling R3)', async () => {
    const s = expectOk(await uniformScene())
    const seen = captureUniforms(s.ctx, s.program, () =>
      s.renderer.renderFront(s.tiles, {
        ...s.base,
        values: { edgeWidth: WIDTH_REF },
        paperField: null,
        edgeSpec: TORN_PAPER,
        widthRef: WIDTH_REF,
      }),
    )
    const d = defaultsFor(TORN_PAPER)
    const amps = tearAmpsFor({
      widthRef: WIDTH_REF,
      variance: Number(d.edgeVariance),
      tearMix: Number(d.tearMix),
      tearAngular: Number(d.tearAngular),
      chew: Number(d.chew),
    })
    // The uploaded angularity is the SAME number the amplitudes were normalised by.
    expect(seen.floats.tearAngular).toBe(Number(d.tearAngular))
    expect(seen.floats.chew).toBeCloseTo(Number(d.chew) * PX, 6)
    expect(seen.floats.tearAmp).toBeCloseTo(amps.tearAmp * PX, 6)
    expect(seen.floats.midAmp).toBeCloseTo(amps.midAmp * PX, 6)
    s.cleanup()
  })

  /**
   * Ruling R4. `uFlapReach` reserves the whole OUTWARD reach of the tear, not the low octave
   * alone: `tearAmp + midHigh(tearAngular) * midAmp + CHEW_REACH * chew` is 21.16 reference px at
   * the defaults against the 13.22 `amps.tearAmp` alone would reserve. Under-reserving clips
   * flaps at pose 2 under `torn`, intermittently.
   */
  it('reserves the whole outward tear reach in uFlapReach (ruling R4)', async () => {
    expect(PAPER_FS_WHOLE).not.toBe(PAPER_FS)
    const s = expectOk(await uniformScene(PAPER_FS_WHOLE))
    const seen = captureUniforms(s.ctx, s.program, () =>
      s.renderer.renderFront(s.tiles, {
        ...s.base,
        paperField: null,
        edgeSpec: TORN_PAPER,
        widthRef: WIDTH_REF,
      }),
    )
    const d = defaultsFor(TORN_PAPER)
    const angular = Number(d.tearAngular)
    const chew = Number(d.chew)
    const amps = tearAmpsFor({
      widthRef: WIDTH_REF,
      variance: Number(d.edgeVariance),
      tearMix: Number(d.tearMix),
      tearAngular: angular,
      chew,
    })
    const outward = amps.tearAmp + midHigh(angular) * amps.midAmp + CHEW_REACH * chew
    // The reference figure the ruling names, recomputed rather than restated.
    expect(outward).toBeCloseTo(21.16, 2)
    expect(outward).toBeGreaterThan(amps.tearAmp)
    // `jitter` and `fiberLen` at their defaults, and the shader's own 30 reference px of slack —
    // the rest of the expression, so the assertion pins the tear term inside the whole sum.
    const jitterDeg = Number(d.jitter)
    const jitterRadians = (jitterDeg * Math.PI) / 180
    const slack = (jitterDeg / 14) * 0.06
    const expected =
      (outward + Number(d.fiberLen) * 4 + 30) * PX + (jitterRadians * 0.8 + slack) * FRONT.h
    expect(seen.floats.flapReach).toBeCloseTo(expected, 5)
    s.cleanup()
  })

  /**
   * Ruling R14: `captureUniforms` patches the live context, so its `try/finally` must restore the
   * four methods even when the body fails. A run that returns a `GlError` makes `expectOk` throw
   * its assertion out through the `finally` — no `throw` written here (spec §10.8), and no
   * successful path either.
   */
  it('restores the context even when the run fails (ruling R14)', async () => {
    const s = expectOk(await uniformScene())
    const gl = s.ctx.gl
    const before = {
      f: gl.uniform1f,
      i: gl.uniform1i,
      a: gl.activeTexture,
      b: gl.bindTexture,
    }
    expect(() =>
      captureUniforms(s.ctx, s.program, () => new GlError('deliberate: the run refuses')),
    ).toThrow()
    expect(gl.uniform1f).toBe(before.f)
    expect(gl.uniform1i).toBe(before.i)
    expect(gl.activeTexture).toBe(before.a)
    expect(gl.bindTexture).toBe(before.b)
    s.cleanup()
  })
})
