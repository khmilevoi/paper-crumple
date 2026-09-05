/**
 * # P6a — the front build's early-outs change no byte, and the drop shadow is still there
 *
 * `PAPER_FS` (`paper-shader.ts`) answers two classes of fragment before `paperField` runs: an
 * opaque artwork texel the tear's floor already covers, and an empty texel further outside the
 * noise-free scrap than any edge term can reach. The block above `main()` in the shader derives
 * both answers from the code; this file is the evidence, on SwiftShader, that the derivation
 * holds byte for byte on the RGBA8 front.
 *
 * The comparison is on/off: the same request rendered through the shipped `PAPER_FS` and through
 * a copy with `#define PAPER_EARLY_OUT 0` (the early-outs compiled out — a test-only string
 * replace, not a knob and not a uniform), read back with `readPixels` and compared as bytes. The
 * "off" copy reaches the renderer through a `CoreGlContext` whose `program()` swaps the fragment
 * source, so both variants go through the real `renderFront` / `build()` and the real uniform
 * upload; nothing here mirrors the renderer's uniforms.
 *
 * A third variant paints a sentinel colour where an early-out fires. It is what keeps the on/off
 * comparison from being vacuous: both branches are asserted to fire on the bench-style artwork
 * (soft edge, holes — `silhouetteBytes` in `tools/bench/gl/harness.ts`, with an antialiased edge
 * and two holes added) in every cell of design 2026-09-05 §6's table.
 *
 * Three surfaces are covered: `renderFront` on explicit fields (the bench's own set-up), and the
 * two `paperSheet()` fixtures `front-identity.gl.test.ts` and `front-holes.gl.test.ts` build
 * (shared through `testing/fixture-sources.ts`), in `hull` and in `torn` mode (the legacy factory
 * option `sheet.ts` still takes — Task 7's to convert).
 *
 * P7 added one more comparison to the first two suites: the shipped text compiles the fold,
 * flap-shadow, crumple, drop-shadow-cut and debug paths out (`#define PAPER_FRONT_BUILD 1`,
 * which is what took ANGLE/D3D11's HLSL compile from 42–48 s to seconds), and every front it
 * renders is compared byte for byte with the whole program (`PAPER_FRONT_BUILD 0`) — through
 * `renderFront` in all four §6 cells, and through `paperSheet()` on the two fixtures.
 *
 * The last suite is about P6a's other edit, the drop-shadow base skipped at `uShadow == 0`: it
 * forces `uShadow = 1` through the real `renderFront` (whose own write of 0 is neutralised by
 * hiding the uniform's location from it) and pins that the shadow is still rendered, byte for byte
 * as the unguarded shadow path renders it. A `float sa` re-declared inside the guard's block —
 * which is what the first cut of P6a shipped — compiles, shadows the outer `sa`, and silently
 * removes the drop shadow for every `uShadow != 0`; nothing else in the suite renders with a
 * non-zero shadow, so this is the one test that sees it.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { GlError, SheetError, isAborted } from '@paper-crumple/core'
import {
  createScratchPools,
  drawTargetFor,
  sdfResFor,
  uploadBytes,
} from '@paper-crumple/core/unstable'
import type { CoreGlContext, EdgeSpec, ScratchPools } from '@paper-crumple/core/unstable'
import {
  HOLES_FIXTURE,
  IDENTITY_SRC,
  identitySourceBytes,
  twoComponentsWithAHole,
} from './testing/fixture-sources.js'
import { createGlFixture, type PaperGlFixture } from './testing/gl-fixture.js'
import { createSdfBuilder, SDF_POOL_SLOTS, sigmaFor } from './gl-sdf.js'
import { defaultsFor, descriptorsFor } from './paper-knobs.js'
import { createPaperRenderer } from './paper-renderer.js'
import { PAPER_FS } from './paper-shader.js'
import { mountNeutralTiles } from './paper-tiles.js'
import { paperSheet } from './sheet.js'

const fixtures: PaperGlFixture[] = []
const poolsList: ScratchPools[] = []

afterEach(() => {
  for (const p of poolsList) p.dispose()
  poolsList.length = 0
  // §4.0 caps live WebGL2 contexts at roughly sixteen and Vitest opens one page per file.
  for (const f of fixtures) f.dispose()
  fixtures.length = 0
})

function open(): CoreGlContext {
  const fixture = createGlFixture(8, 8)
  expect(fixture.gl, 'no WebGL2 context — check the SwiftShader launch flags (§11)').not.toBeNull()
  fixtures.push(fixture)
  return fixture.ctx
}

// --- the shader variants ------------------------------------------------------------------------

const SWITCH_ON = '#define PAPER_EARLY_OUT 1'
const SWITCH_OFF = '#define PAPER_EARLY_OUT 0'
const EARLY_OUT_A = 'outColor = vec4(img.rgb, 1.0); return; } // P6a early-out (a)'
const EARLY_OUT_B = 'outColor = vec4(0.0); return; } // P6a early-out (b)'
const SENTINEL_A = 'outColor = vec4(1.0, 0.0, 1.0, 1.0); return; } // sentinel (a)'
const SENTINEL_B = 'outColor = vec4(0.0, 1.0, 0.0, 1.0); return; } // sentinel (b)'
/** The D2 guard; replaced by a bare block, the shadow base runs unconditionally, as before P6a. */
const D2_GUARD = '  if (uShadow != 0.0 || uShadowBlur <= 0.0) {'
const D2_GUARD_OFF = '  { // the D2 guard, removed by the test: the shadow base always runs'
/**
 * P7: the front build compiles the fold, flap-shadow, crumple, drop-shadow-cut and debug paths
 * out (`PAPER_FRONT_BUILD 1`, the shipped text); 0 is the whole program of edits 1–8, the one
 * every P6a comparison above ran against before P7, and what the front build must match byte
 * for byte for the uniforms `renderFront` fixes (the P7 block above `main()` is the proof).
 */
const FRONT_ON = '#define PAPER_FRONT_BUILD 1'
const FRONT_OFF = '#define PAPER_FRONT_BUILD 0'

/**
 * design 2026-09-05 §6's four cells, which is what the `renderFront` half of this suite now
 * sweeps. `EdgeMode`'s three values collapsed onto the SHAPE column alone — `hull` and `both`
 * were both "one field bound to both `uSdf*` slots", i.e. `smooth`; `torn` is `torn` — and the
 * FINISH column is new coverage the mode int could not express: the P6a derivation block reasons
 * explicitly about `uEdgeFinish == 0` ("paperField never enters the fringe block, so fringe = 0.0
 * outright"), so the `clean` half of the table is where that half of the derivation is checked.
 *
 * Every cell renders at the width knob's own default, never at 0: at `uEdgeWidth == 0` `edgeK()`
 * is 0, every border decoration is gated off and all four cells render the SAME front — which is
 * how this suite passed while testing one cell four times.
 */
const RENDER_CELLS = [
  ['smooth/clean', { shape: 'smooth', finish: 'clean', widthUnit: 'px' }],
  ['smooth/paper', { shape: 'smooth', finish: 'paper', widthUnit: 'px' }],
  ['torn/clean', { shape: 'torn', finish: 'clean', widthUnit: 'px' }],
  ['torn/paper', { shape: 'torn', finish: 'paper', widthUnit: 'px' }],
] as const satisfies ReadonlyArray<readonly [string, EdgeSpec]>

/**
 * TASK 7 REPLACES THIS. `paperSheet()` still takes the legacy `edgeMode` factory option; Task 7
 * turns it into `edgeShape` / `edgeFinish` / `edgeWidthUnit` (design §2, ruling R5's
 * `optionsFor(spec)`), and the `paperSheet()` half of this file moves to `RENDER_CELLS` with it.
 * The `renderFront` half above has already moved.
 */
type LegacyEdgeMode = 'hull' | 'torn'

/** The sentinel bytes the two branches paint: magenta for (a), green for (b). */
const SENTINEL_A_RGBA = [255, 0, 255, 255] as const
const SENTINEL_B_RGBA = [0, 255, 0, 255] as const

function replaceExactlyOnce(source: string, from: string, to: string): string {
  const first = source.indexOf(from)
  expect(first, `PAPER_FS no longer contains ${JSON.stringify(from)}`).toBeGreaterThanOrEqual(0)
  expect(source.indexOf(from, first + 1), `${JSON.stringify(from)} occurs twice`).toBe(-1)
  return source.slice(0, first) + to + source.slice(first + from.length)
}

const PAPER_FS_OFF = replaceExactlyOnce(PAPER_FS, SWITCH_ON, SWITCH_OFF)
const PAPER_FS_SENTINEL = replaceExactlyOnce(
  replaceExactlyOnce(PAPER_FS, EARLY_OUT_A, SENTINEL_A),
  EARLY_OUT_B,
  SENTINEL_B,
)
/** Early-outs off and the shadow base unconditional: the shader as it was before P6a. */
const PAPER_FS_PRE_P6A = replaceExactlyOnce(PAPER_FS_OFF, D2_GUARD, D2_GUARD_OFF)
/** The whole program: every path compiled in, as it shipped before P7. */
const PAPER_FS_FULL = replaceExactlyOnce(PAPER_FS, FRONT_ON, FRONT_OFF)

/**
 * The same context, compiling `fs` wherever the renderer asks for `PAPER_FS`. `CoreGlContext` is
 * a bag of closures over the one `gl` (`gl-context.ts`'s `createGlContext`), so a spread with one
 * method replaced is the same context; every resource it creates is still tracked by, and released
 * with, the original.
 *
 * With `shadow` given, the program's `uShadow` is set to it up front and its location is hidden
 * from the renderer (`uniformLocation('uShadow')` returns `null`, and `uniform1f(null, …)` is a
 * no-op), so `renderFront`'s own `uniform1f(loc('shadow'), 0)` no longer wins: the real renderer
 * path runs with a non-zero shadow, which no production caller can ask for.
 */
function withPaperShader(ctx: CoreGlContext, fs: string, shadow?: number): CoreGlContext {
  return {
    ...ctx,
    program: (vs, source, label) => {
      if (source !== PAPER_FS) return ctx.program(vs, source, label)
      const program = ctx.program(vs, fs, label)
      if (GlError.is(program) || shadow === undefined) return program
      const location = program.uniformLocation('uShadow')
      expect(location).not.toBeNull()
      ctx.scope(() => {
        ctx.gl.useProgram(program.handle)
        ctx.gl.uniform1f(location, shadow)
        ctx.gl.useProgram(null)
      })
      return {
        ...program,
        uniformLocation: (name) => (name === 'uShadow' ? null : program.uniformLocation(name)),
      }
    },
  }
}

// --- readback and comparison --------------------------------------------------------------------

/** `readPixels` reads `READ_FRAMEBUFFER`; `DrawScope.bindTarget` only ever binds `DRAW_FRAMEBUFFER`. */
function readAll(ctx: CoreGlContext, texture: WebGLTexture, w: number, h: number): Uint8Array {
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
    ctx.gl.readPixels(0, 0, w, h, ctx.gl.RGBA, ctx.gl.UNSIGNED_BYTE, out)
    ctx.gl.bindFramebuffer(ctx.gl.READ_FRAMEBUFFER, null)
  })
  ctx.gl.deleteFramebuffer(probe)
  return out
}

/** The first differing texels, as `(x,y): got != want` strings — empty when the buffers match. */
function firstDifferences(a: Uint8Array, b: Uint8Array, stride: number, limit = 8): string[] {
  const out: string[] = []
  expect(a.length).toBe(b.length)
  for (let i = 0; i < a.length && out.length < limit; i += 4) {
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) {
      const t = i / 4
      out.push(
        `(${t % stride},${Math.floor(t / stride)}): ` +
          `[${a[i]},${a[i + 1]},${a[i + 2]},${a[i + 3]}] != [${b[i]},${b[i + 1]},${b[i + 2]},${b[i + 3]}]`,
      )
    }
  }
  return out
}

function isTexel(bytes: Uint8Array, i: number, rgba: readonly [number, number, number, number]) {
  return (
    bytes[i] === rgba[0] &&
    bytes[i + 1] === rgba[1] &&
    bytes[i + 2] === rgba[2] &&
    bytes[i + 3] === rgba[3]
  )
}

function countTexels(bytes: Uint8Array, rgba: readonly [number, number, number, number]): number {
  let n = 0
  for (let i = 0; i < bytes.length; i += 4) if (isTexel(bytes, i, rgba)) n++
  return n
}

// --- the bench-style artwork, with a soft edge and holes --------------------------------------

/**
 * `tools/bench/gl/harness.ts`'s silhouette — a disc over two legs — drawn from its signed
 * distance so the edge carries a one-pixel alpha ramp (0 < a < 255, like a decoded PNG), with
 * two holes punched through it (alpha 0 inside the paper, the case that exercises the deep-inside
 * branch's neighbours) and the bench's own RGB gradient, which is non-zero under alpha 0.
 */
function softSilhouette(w: number, h: number): Uint8Array {
  const cx = w / 2
  const cy = h * 0.36
  const r = Math.min(w, h) * 0.27
  const legW = w * 0.15
  const legTop = cy
  const legBottom = h * 0.93
  const leftLeg = cx - w * 0.22
  const rightLeg = cx + w * 0.07
  const holes: ReadonlyArray<readonly [number, number, number]> = [
    [cx, cy - r * 0.35, r * 0.28],
    [leftLeg + legW / 2, (legTop + legBottom) / 2, legW * 0.3],
  ]
  const box = (px: number, py: number, x0: number, y0: number, x1: number, y1: number): number => {
    const dx = Math.max(x0 - px, 0, px - x1)
    const dy = Math.max(y0 - py, 0, py - y1)
    const outside = Math.hypot(dx, dy)
    const inside = Math.min(px - x0, x1 - px, py - y0, y1 - py)
    return outside > 0 ? outside : -inside
  }
  const out = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = x + 0.5
      const py = y + 0.5
      let d = Math.hypot(px - cx, py - cy) - r
      d = Math.min(d, box(px, py, leftLeg, legTop, leftLeg + legW, legBottom))
      d = Math.min(d, box(px, py, rightLeg, legTop, rightLeg + legW, legBottom))
      for (const [hx, hy, hr] of holes) d = Math.max(d, hr - Math.hypot(px - hx, py - hy))
      const coverage = Math.min(1, Math.max(0, 0.5 - d))
      const p = (y * w + x) * 4
      out[p] = Math.round((x * 255) / w)
      out[p + 1] = Math.round((y * 255) / h)
      out[p + 2] = 140
      out[p + 3] = Math.round(coverage * 255)
    }
  }
  return out
}

interface FrontScene {
  readonly ctx: CoreGlContext
  readonly front: number
  /**
   * One `renderFront` and the whole front read back: through the shipped shader when `fs` is
   * `null`, otherwise through a renderer whose context compiles `fs` in its place — and, with
   * `shadow`, with `uShadow` forced to that value (see `withPaperShader`).
   */
  readonly render: (spec: EdgeSpec, fs: string | null, shadow?: number) => Uint8Array
  dispose(): void
}

/**
 * The bench's `gl.front.render.<N>` set-up (`tools/bench/gl/front.gl.bench.ts`): an N x N front,
 * the artwork centred at 72 % of it, the fields at `sdfResFor(N)`, the neutral tiles, and one
 * `renderFront` per call.
 */
function frontScene(N: number): FrontScene | Error {
  const ctx = open()
  const A = Math.round(N * 0.72)
  const placement = { x: Math.round((N - A) / 2), y: Math.round((N - A) / 2), w: A, h: A }
  const res = sdfResFor(N)

  const pools = createScratchPools({ gl: ctx, artwork: { w: A, h: A }, sdfRes: res })
  poolsList.push(pools)
  const artwork = pools.poolA.holdArtwork('p6a', {
    width: A,
    height: A,
    format: 'RGBA8UI',
    filter: 'NEAREST',
    label: 'artwork:p6a',
  })
  if (GlError.is(artwork)) return artwork
  const uploaded = ctx.scope(() => uploadBytes(ctx.gl, artwork, softSilhouette(A, A)))
  if (uploaded !== undefined) return uploaded

  const builder = createSdfBuilder(ctx, pools.poolA)
  if (GlError.is(builder)) return builder
  // `artworkUvFor(placement, front)` in sheet.ts: field uv -> artwork uv.
  const artworkUv: readonly [number, number, number, number] = [
    N / A,
    N / A,
    -placement.x / A,
    -placement.y / A,
  ]
  const tight = builder.buildField({
    artwork,
    artworkUv,
    width: res,
    height: res,
    sourceLongSide: N,
  })
  if (GlError.is(tight)) return tight
  const loose = builder.blurField({ field: tight, sigmaPx: sigmaFor(0.5, N), frontLongSide: N })
  if (GlError.is(loose)) return loose
  const paperField = builder.buildField({
    artwork,
    artworkUv,
    width: res,
    height: res,
    sourceLongSide: N,
    slot: SDF_POOL_SLOTS.hullField,
  })
  if (GlError.is(paperField)) return paperField

  const frontTexture = ctx.texture({
    width: N,
    height: N,
    format: 'RGBA8',
    filter: 'LINEAR',
    label: 'front:p6a',
  })
  if (GlError.is(frontTexture)) return frontTexture
  const target = ctx.target(frontTexture)
  if (GlError.is(target)) return target
  const tiles = mountNeutralTiles(ctx)
  if (GlError.is(tiles)) return tiles

  const renderers = new Map<string, ReturnType<typeof createPaperRenderer>>()
  const rendererFor = (fs: string | null, shadow: number | undefined) => {
    const key = `${shadow ?? ''}|${fs ?? ''}`
    let r = renderers.get(key)
    if (r === undefined) {
      r = createPaperRenderer(fs === null ? ctx : withPaperShader(ctx, fs, shadow))
      renderers.set(key, r)
    }
    return r
  }

  return {
    ctx,
    front: N,
    render(spec, fs, shadow) {
      const renderer = rendererFor(fs, shadow)
      expect(GlError.is(renderer), GlError.is(renderer) ? renderer.message : '').toBe(false)
      if (GlError.is(renderer)) return new Uint8Array(0)
      const err = renderer.renderFront(tiles, {
        target: drawTargetFor(target),
        front: { w: N, h: N },
        artworkRect: placement,
        artwork,
        tight,
        loose,
        // design 2026-09-05 §6: under `smooth` the polygon field IS the contour source (both
        // `uSdf*` slots); under `torn` it is unread and the artwork's own pair is bound.
        paperField: spec.shape === 'smooth' ? paperField : null,
        edgeSpec: spec,
        widthRef: Number(defaultsFor(spec).edgeWidth),
        values: defaultsFor(spec),
        descriptors: descriptorsFor(spec),
      })
      expect(err, err?.message).toBeUndefined()
      return readAll(ctx, frontTexture.handle, N, N)
    },
    dispose() {
      for (const r of renderers.values()) if (!GlError.is(r)) r.dispose()
      tiles.dispose()
      target.dispose()
      frontTexture.dispose()
      builder.dispose()
    },
  }
}

describe('PAPER_FS early-outs on the bench-style front (renderFront, explicit fields)', () => {
  it('keeps the switch, the two marked early-outs and the D2 guard a test can compile out', () => {
    expect(PAPER_FS).toContain(SWITCH_ON)
    expect(PAPER_FS).not.toContain(SWITCH_OFF)
    expect(PAPER_FS).toContain(EARLY_OUT_A)
    expect(PAPER_FS).toContain(EARLY_OUT_B)
    expect(PAPER_FS).toContain(D2_GUARD)
    expect(PAPER_FS_OFF).not.toContain(SWITCH_ON)
    expect(PAPER_FS_SENTINEL).toContain(SENTINEL_A)
    expect(PAPER_FS_SENTINEL).toContain(SENTINEL_B)
    expect(PAPER_FS_PRE_P6A).not.toContain(D2_GUARD)
    expect(PAPER_FS).toContain(FRONT_ON)
    expect(PAPER_FS_FULL).not.toContain(FRONT_ON)
    // The whole program still carries every path the front build compiles out (spec 15: the
    // text is kept whole; P7 only guards it).
    for (const kept of [
      'flapCoverage(p,',
      'flapShadowAt(p, top)',
      'crumpleShade(p, q, b, mosaicK)',
      'uDebug == 7',
    ]) {
      expect(PAPER_FS_FULL).toContain(kept)
    }
  })

  /**
   * The proof that every loop below sweeps four cells rather than rendering one cell four times.
   *
   * This suite spent a whole task green over a renderer that uploaded nothing: `loc('thickness')`
   * resolved through a `PAPER_UNIFORMS` key that no longer existed, `gl-context.ts` cached the
   * `null`, `uEdgeWidth` / `uBaseBias` / `uEdgeFinish` all read 0, and its three mode strings
   * rendered the same `edgeWidth = 0` front three times — every byte-identity assertion in the
   * file still passed. A byte comparison between two renders is only worth what the two renders
   * differ by, so the file has to establish that difference itself rather than borrow it from a
   * sibling suite.
   */
  it('renders a different front in each of the four cells (design 2026-09-05 §6)', () => {
    const scene = frontScene(256)
    expect(scene).not.toBeInstanceOf(Error)
    if (scene instanceof Error) return
    const fronts = RENDER_CELLS.map(([name, spec]) => [name, scene.render(spec, null)] as const)
    for (let i = 0; i < fronts.length; i++) {
      for (let j = i + 1; j < fronts.length; j++) {
        const a = fronts[i]
        const b = fronts[j]
        if (a === undefined || b === undefined) continue
        expect(
          firstDifferences(a[1], b[1], scene.front),
          `${a[0]} and ${b[0]} rendered the same front`,
        ).not.toEqual([])
      }
    }
    scene.dispose()
  }, 120_000)

  for (const [name, spec] of RENDER_CELLS) {
    it(`renders byte-identical fronts through the front build and the whole program (P7) — ${name}`, () => {
      const scene = frontScene(256)
      expect(scene).not.toBeInstanceOf(Error)
      if (scene instanceof Error) return
      const front = scene.render(spec, null)
      const whole = scene.render(spec, PAPER_FS_FULL)
      expect(front.length).toBe(scene.front * scene.front * 4)
      expect(firstDifferences(front, whole, scene.front)).toEqual([])
      scene.dispose()
    }, 120_000)
  }

  for (const [name, spec] of RENDER_CELLS) {
    it(`renders byte-identical fronts with the early-outs on and off — ${name}`, () => {
      const scene = frontScene(256)
      expect(scene).not.toBeInstanceOf(Error)
      if (scene instanceof Error) return

      const on = scene.render(spec, null)
      const off = scene.render(spec, PAPER_FS_OFF)
      expect(on.length).toBe(scene.front * scene.front * 4)
      expect(firstDifferences(on, off, scene.front)).toEqual([])

      // Not vacuous: both branches fire on this artwork, and together they cover a substantial
      // share of the front (the bench silhouette is mostly margin and mostly opaque interior).
      // The per-mode figures this comment used to quote were measured on the deleted `hull` /
      // `torn` mode ints at the old uniform set; the bounds below are what the assertion actually
      // holds to, and they hold in all four cells of design 2026-09-05 §6.
      const sentinel = scene.render(spec, PAPER_FS_SENTINEL)
      const texels = scene.front * scene.front
      const deepInside = countTexels(sentinel, SENTINEL_A_RGBA)
      const farOutside = countTexels(sentinel, SENTINEL_B_RGBA)
      expect(deepInside).toBeGreaterThan(texels * 0.1)
      expect(farOutside).toBeGreaterThan(texels * 0.1)
      expect(deepInside + farOutside).toBeGreaterThan(texels * 0.3)
      // The sentinel render differs from the shipped one ONLY where a sentinel was painted, which
      // pins the two marked lines as the only writes the early-outs make.
      let elsewhere = 0
      for (let i = 0; i < on.length; i += 4) {
        if (isTexel(sentinel, i, SENTINEL_A_RGBA) || isTexel(sentinel, i, SENTINEL_B_RGBA)) continue
        if (
          sentinel[i] !== on[i] ||
          sentinel[i + 1] !== on[i + 1] ||
          sentinel[i + 2] !== on[i + 2] ||
          sentinel[i + 3] !== on[i + 3]
        ) {
          elsewhere++
        }
      }
      expect(elsewhere).toBe(0)

      scene.dispose()
      // Three 256² renders plus the field builds on SwiftShader, with sibling suites sharing
      // the CPU, run past the default 15 s.
    }, 120_000)
  }
})

// --- the two paperSheet() fixtures ----------------------------------------------------------------

interface SourceBytes {
  readonly bytes: Uint8ClampedArray<ArrayBuffer>
  readonly w: number
  readonly h: number
}

/** `front-identity.gl.test.ts`'s source: a hard alpha edge and non-zero RGB under zero alpha. */
function identitySource(): SourceBytes {
  return { bytes: identitySourceBytes(), w: IDENTITY_SRC.w, h: IDENTITY_SRC.h }
}

/** `front-holes.gl.test.ts`'s source: two disjoint opaque squares, the left one with a hole. */
function holesSource(): SourceBytes {
  return { bytes: twoComponentsWithAHole(), w: HOLES_FIXTURE.S, h: HOLES_FIXTURE.S }
}

/**
 * `paperSheet()` end to end — `mount`, `source`, `build` — on `ctx`, and the whole front read back.
 * Built from `ImageData` directly, never through a canvas round trip (which premultiplies).
 */
async function buildFront(
  ctx: CoreGlContext,
  mode: LegacyEdgeMode,
  source: SourceBytes,
  size: number,
): Promise<{ bytes: Uint8Array; w: number; h: number } | Error> {
  const sheet = paperSheet({ edgeMode: mode })
  const mounted = sheet.mount(ctx)
  if (mounted !== undefined) return mounted
  const bitmap = await createImageBitmap(new ImageData(source.bytes, source.w, source.h), {
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none',
  })
  const handle = await sheet.source(bitmap, { maxSize: size, exact: true })
  bitmap.close()
  if (GlError.is(handle) || SheetError.is(handle) || isAborted(handle)) {
    return new Error(`source() refused: ${String(handle)}`)
  }
  const front = sheet.build(handle, { w: size, h: size }, defaultsFor(mode) as never)
  if (front instanceof Error) return front
  const bytes = readAll(ctx, front.texture, front.width, front.height)
  const out = { bytes, w: front.width, h: front.height }
  sheet.releaseFront(front)
  sheet.dispose()
  return out
}

describe('PAPER_FS early-outs through paperSheet() (the front-identity and front-holes fixtures)', () => {
  const cases = [
    { name: 'front-identity source', source: identitySource, size: 128 },
    { name: 'front-holes source', source: holesSource, size: 128 },
  ] as const

  for (const c of cases) {
    for (const mode of ['hull', 'torn'] as const satisfies readonly LegacyEdgeMode[]) {
      it(`builds a byte-identical front with the early-outs on and off — ${c.name}, ${mode}`, async () => {
        const ctx = open()
        const on = await buildFront(ctx, mode, c.source(), c.size)
        expect(on).not.toBeInstanceOf(Error)
        if (on instanceof Error) return
        const off = await buildFront(withPaperShader(ctx, PAPER_FS_OFF), mode, c.source(), c.size)
        expect(off).not.toBeInstanceOf(Error)
        if (off instanceof Error) return
        expect([on.w, on.h]).toEqual([off.w, off.h])
        expect(firstDifferences(on.bytes, off.bytes, on.w)).toEqual([])

        const sentinel = await buildFront(
          withPaperShader(ctx, PAPER_FS_SENTINEL),
          mode,
          c.source(),
          c.size,
        )
        expect(sentinel).not.toBeInstanceOf(Error)
        if (sentinel instanceof Error) return
        // The opaque interior of every fixture is deep inside; whether the margin reaches "far
        // outside" depends on the fixture's front, so only (a) is required to fire here.
        expect(countTexels(sentinel.bytes, SENTINEL_A_RGBA)).toBeGreaterThan(0)
        // Three `source()` + `build()` round trips on SwiftShader run well past the default 15 s.
      }, 120_000)

      it(`builds a byte-identical front through the front build and the whole program (P7) — ${c.name}, ${mode}`, async () => {
        const ctx = open()
        const front = await buildFront(ctx, mode, c.source(), c.size)
        expect(front).not.toBeInstanceOf(Error)
        if (front instanceof Error) return
        const whole = await buildFront(
          withPaperShader(ctx, PAPER_FS_FULL),
          mode,
          c.source(),
          c.size,
        )
        expect(whole).not.toBeInstanceOf(Error)
        if (whole instanceof Error) return
        expect([front.w, front.h]).toEqual([whole.w, whole.h])
        expect(firstDifferences(front.bytes, whole.bytes, front.w)).toEqual([])
      }, 120_000)
    }
  }
})

// --- D2: the drop shadow at uShadow != 0 ----------------------------------------------------------

describe('PAPER_FS drop shadow at uShadow != 0 (D2 skips the shadow base, it does not remove it)', () => {
  for (const [name, spec] of RENDER_CELLS) {
    it(`still renders the drop shadow, byte-identical to the unguarded path — ${name}`, () => {
      const scene = frontScene(256)
      expect(scene).not.toBeInstanceOf(Error)
      if (scene instanceof Error) return

      // The shipped shader as the renderer drives it (uShadow = 0), the shipped shader with
      // uShadow forced to 1, and the pre-P6a shader (early-outs off, shadow base unconditional)
      // with the same forced shadow.
      const noShadow = scene.render(spec, null)
      const shadow = scene.render(spec, PAPER_FS, 1)
      const reference = scene.render(spec, PAPER_FS_PRE_P6A, 1)

      // The shadow is there: texels the sheet leaves clear (alpha 0) now carry the shadow's alpha.
      // The default shadowBlur (13 reference px, 3.3 px on this front) and offset put a soft
      // band of it just outside the scrap.
      let shaded = 0
      for (let i = 0; i < noShadow.length; i += 4) {
        if (noShadow[i + 3] === 0 && shadow[i + 3]! > 0) shaded++
      }
      expect(shaded).toBeGreaterThan(0)
      // And it is the shadow the unguarded path renders, byte for byte, over the whole front.
      expect(firstDifferences(shadow, reference, scene.front)).toEqual([])

      scene.dispose()
    }, 120_000)
  }
})
