import { afterEach, describe, expect, it } from 'vitest'
import { GlError, KNOB_REFERENCE_PX } from '@paper-crumple/core'
import { createScratchPools, drawTargetFor, FULLSCREEN_VS } from '@paper-crumple/core/unstable'
import { TORN_PAPER as TORN_PAPER_SPEC } from './testing/edge-cells.js'
import { createGlFixture, type PaperGlFixture } from './testing/gl-fixture.js'
import { silhouetteBytes } from './testing/silhouette.js'
import { createSdfBuilder, SDF_POOL_SLOTS, sigmaFor } from './gl-sdf.js'
import { tearAmpsFor } from './edge-derive.js'
import { defaultsFor } from './paper-knobs.js'
import { mountNeutralTiles } from './paper-tiles.js'
import { MAX_FOLDS, PAPER_FS, PAPER_UNIFORMS, SHEET_TILE_PX } from './paper-shader.js'

type Err = InstanceType<typeof GlError>

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

describe('PAPER_FS', () => {
  it('compiles and links against core FULLSCREEN_VS', () => {
    const ctx = open()
    const program = ctx.program(FULLSCREEN_VS, PAPER_FS, 'paper')
    expect(GlError.is(program), GlError.is(program) ? program.message : '').toBe(false)
    if (GlError.is(program)) return
    program.dispose()
  })

  it('resolves every name PAPER_UNIFORMS declares in the whole program, and all but the fold and crumple ones in the front build (P7)', () => {
    const ctx = open()
    const missingIn = (fs: string): string[] | Error => {
      const program = ctx.program(FULLSCREEN_VS, fs, 'paper')
      if (GlError.is(program)) return program
      const missing = Object.values(PAPER_UNIFORMS).filter(
        (name) => program.uniformLocation(name) === null,
      )
      program.dispose()
      return missing
    }
    // The whole program (edits 1-8) reaches every uniform.
    //
    // It did not, for one round: the edge redesign left `uPaperField` / `uDecodePaper` with no
    // reader at all — `samplePaper` was called from `baseField`, `paperField`, `paperFieldFast`,
    // `deepInside`, `farOutside` and the flap envelope, and every one of those now goes through
    // `scrapBase`, while the fold loop reads `paperFieldFast` rather than `uPaperField`. The plan's
    // "they survive for the fold loop's own lookups" was simply false. They are deleted, so this
    // list is empty again and a future dead uniform shows up here rather than in a comment.
    const whole = missingIn(
      PAPER_FS.replace('#define PAPER_FRONT_BUILD 1', '#define PAPER_FRONT_BUILD 0'),
    )
    expect(whole).toEqual([])
    // The shipped front build compiles the fold loops, the flap shadow and the crumple mosaic
    // out, so the uniforms only they read are optimised away — and `renderFront`'s uploads to
    // them are the no-ops WebGL defines for a null location. The set is pinned so that a guard
    // moved by a later edit shows up here rather than as a silently dropped upload.
    const front = missingIn(PAPER_FS)
    expect(front).toEqual([
      'uFolds',
      'uFoldJitter',
      'uCreaseDark',
      'uCreaseWidth',
      'uSlack',
      'uFlapReach',
      'uCrumpleDepth',
      'uCrumpleCells',
      'uPhotoCrumple',
      'uBallR',
      'uCrumpleBite',
    ])
  })

  it('reads the artwork with texelFetch and never with LINEAR (spec 7.4.1)', () => {
    expect(PAPER_FS).toContain('usampler2D uImage')
    expect(PAPER_FS).toContain('texelFetch(uImage')
    expect(PAPER_FS).not.toContain('texture(uImage')
  })

  it('samples four R8 tile planes and no packed RGBA tile (spec 14)', () => {
    for (const name of ['uCrumpleR', 'uCrumpleG', 'uCrumpleA', 'uFibreA']) {
      expect(PAPER_FS).toContain(`uniform sampler2D ${name}`)
    }
    expect(PAPER_FS).not.toContain('uCrumpleTex')
    expect(PAPER_FS).not.toContain('uFibreTex')
  })

  it('declares highp int, because the fragment default would break the index arithmetic', () => {
    expect(PAPER_FS).toContain('precision highp int;')
  })

  it('keeps the fold model whole at MAX_FOLDS 12 (spec 15)', () => {
    expect(MAX_FOLDS).toBe(12)
    expect(PAPER_FS).toContain('#define MAX_FOLDS 12')
    expect(PAPER_FS).toContain('uFoldJitter')
    expect(PAPER_FS).toContain('uCrumpleFill')
    expect(PAPER_FS).toContain('uShadowBlur')
  })

  // The title's "1977-line" names the spike's own line count, not this file's — 1988 lines ship
  // here (1977 spike lines + 11 accounted-for), and `.superpowers/sdd/2026-08-26-p10-paper-sheet-
  // renderer/handcheck-1-shader.md` records the exact line-by-line audit behind that difference.
  it('is the whole 1977-line shader, not an excerpt', () => {
    expect(PAPER_FS.split('\n').length).toBeGreaterThan(1900)
  })
})

// =================================================================================================
// A uniform-driving harness for PAPER_FS, and the design's §11 measurements on top of it.
//
// It does NOT go through `paper-renderer.ts`. Task 5 replaces the shader's uniform set and Task 6
// is the one that teaches the renderer to speak it, so a Task 5 measurement routed through
// `renderFront` would be measuring a renderer that is mid-surgery by construction. Driving the
// program directly is also what the brief's step 6 describes ("drive uniforms directly"), and it
// keeps the two §11 numbers below attributable to the SHADER rather than to an upload path.
//
// One WebGL2 context per `it`, reused across every draw inside it: §4.0 caps live contexts at
// roughly sixteen per page and these cases render up to fifteen frames each.
// =================================================================================================

const FRONT = { w: 128, h: 128 }
const ARTWORK = { w: 96, h: 96 }
const ARTWORK_RECT = { x: 16, y: 16, w: 96, h: 96 }
const FIELD = 128
/** Working px per reference px at this front, i.e. `pxScale(FRONT.h)`. */
const PXS = FRONT.h / KNOB_REFERENCE_PX

/** The cell every measurement below is quoted against (`testing/edge-cells.ts` owns the four). */
const TORN_PAPER_DEFAULTS = defaultsFor(TORN_PAPER_SPEC)

/**
 * One knob's default, read out of the knob table — or `NaN`.
 *
 * Ruling R3's shape, applied here. A silent `?? 0` (which is what this helper used to be) would
 * quietly measure the `edgeWidth = 0` cell and report the numbers as "the defaults"; Task 4 had
 * exactly that pattern removed from `paper-knobs.ts` for exactly that reason. `NaN` is the loud
 * value: it is not a legal edge width, it poisons every uniform it reaches, and
 * `MEASURED_KNOBS`'s own case below names the key that went missing before any measurement runs.
 * It does not throw — spec §10.8 bans that outside `eslint.boundaries.js`, test files included.
 */
function knobDefault(key: string): number {
  const v: unknown = TORN_PAPER_DEFAULTS[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : Number.NaN
}

// Every one of these comes from the descriptors, never from a literal, so the measurements follow
// the knob table rather than a snapshot of it. (They did not, for one round: `tearMix` was
// hard-coded here as 0.7 while the table already said 0.6.)
const MEASURED_KNOBS = ['edgeWidth', 'edgeVariance', 'tearAngular', 'tearMix', 'chew'] as const
const W_REF = knobDefault('edgeWidth')
const VARIANCE = knobDefault('edgeVariance')
const TEAR_ANGULAR = knobDefault('tearAngular')
const TEAR_MIX = knobDefault('tearMix')
const CHEW_REF = knobDefault('chew')

/** A convex control: a centred opaque square, as tightly packed `RGBA8UI` bytes. */
function squareBytes(w: number, h: number, r: number): Uint8Array {
  const out = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4
      out[p] = 200
      out[p + 1] = 90
      out[p + 2] = 90
      out[p + 3] = Math.abs(x - w / 2) < r && Math.abs(y - h / 2) < r ? 255 : 0
    }
  }
  return out
}

type Sample = 'figure' | 'square'

/** Half-width of the `square` sample, in artwork px — which are front texels here, 1:1. */
const SQUARE_R = ARTWORK.w * 0.3

function bytesFor(sample: Sample): Uint8Array {
  return sample === 'figure'
    ? silhouetteBytes(ARTWORK.w, ARTWORK.h)
    : squareBytes(ARTWORK.w, ARTWORK.h, SQUARE_R)
}

interface DrawOptions {
  readonly looseness: number
  readonly edgeWidthRef: number
  readonly baseBiasRef: number
  readonly edgeFinish: 0 | 1
  readonly seed: number
  readonly tearAmpRef: number
  readonly midAmpRef: number
  readonly chewRef: number
  readonly tearAngular: number
  /**
   * The `edgeShape: 'smooth'` binding (design 2026-09-05 §6): the polygon's own field goes to
   * `uSdfTight` AND `uSdfLoose`, and no loose blur is built at all. Requires `openScene`'s
   * `polygonRadius`.
   */
  readonly bindPolygonToBoth?: boolean
}

interface Scene {
  draw(o: DrawOptions): Err | Uint8Array
  dispose(): void
}

/**
 * One context, one program, one artwork, one tight field — and a `draw` that rebuilds only the
 * loose field (which depends on `looseness`) before uploading the whole uniform set and reading
 * the front back as RGBA8 bytes.
 *
 * `polygonRadius` (artwork px, i.e. front texels) builds a SECOND field from a square mask of that
 * half-width, standing in for the hull polygon `hull.ts` builds under `edgeShape: 'smooth'`. It is
 * deliberately LARGER than the artwork, so a contour measured against it cannot be confounded by
 * `sheetCov = max(paperMask, img.a)`'s artwork-alpha floor.
 */
function openScene(sample: Sample, polygonRadius?: number): Err | Scene {
  const fixture = createGlFixture(8, 8)
  expect(fixture.gl, 'no WebGL2 context — check the SwiftShader launch flags (§11)').not.toBeNull()
  const ctx = fixture.ctx
  const pools = createScratchPools({ gl: ctx, artwork: ARTWORK, sdfRes: FIELD })
  const artwork = pools.poolA.holdArtwork('measure', {
    width: ARTWORK.w,
    height: ARTWORK.h,
    format: 'RGBA8UI',
    filter: 'NEAREST',
    label: 'artwork:measure',
  })
  if (GlError.is(artwork)) return artwork
  ctx.scope(() => {
    const { gl } = ctx
    gl.bindTexture(gl.TEXTURE_2D, artwork.handle)
    // prettier-ignore
    gl.texSubImage2D(
      gl.TEXTURE_2D, 0, 0, 0, ARTWORK.w, ARTWORK.h,
      gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, bytesFor(sample),
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

  // The stand-in hull polygon: a square mask `polygonRadius` from the centre, run through the same
  // pass A (`BuildFieldOptions.artwork`'s own doc comment: pass A does not care whether its
  // `RGBA8UI` source is the artwork or a hull mask), into its own pool slot so it never displaces
  // `tight`'s target.
  let polygon: typeof tight | null = null
  if (polygonRadius !== undefined) {
    const mask = ctx.texture({
      width: ARTWORK.w,
      height: ARTWORK.h,
      format: 'RGBA8UI',
      filter: 'NEAREST',
      label: 'polygon-mask',
    })
    if (GlError.is(mask)) return mask
    ctx.scope(() => {
      const { gl } = ctx
      gl.bindTexture(gl.TEXTURE_2D, mask.handle)
      // prettier-ignore
      gl.texSubImage2D(
        gl.TEXTURE_2D, 0, 0, 0, ARTWORK.w, ARTWORK.h,
        gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, squareBytes(ARTWORK.w, ARTWORK.h, polygonRadius),
      )
    })
    const built = builder.buildField({
      artwork: mask,
      artworkUv: [scale, scale, -p, -p],
      width: FIELD,
      height: FIELD,
      sourceLongSide: FRONT.w,
      slot: SDF_POOL_SLOTS.hullField,
    })
    mask.dispose()
    if (GlError.is(built)) return built
    polygon = built
  }

  const tiles = mountNeutralTiles(ctx)
  if (GlError.is(tiles)) return tiles
  const program = ctx.program(FULLSCREEN_VS, PAPER_FS, 'paper-measure')
  if (GlError.is(program)) return program
  const front = ctx.texture({
    width: FRONT.w,
    height: FRONT.h,
    format: 'RGBA8',
    filter: 'LINEAR',
    label: 'front:measure',
  })
  if (GlError.is(front)) return front
  const target = ctx.target(front)
  if (GlError.is(target)) return target

  const folds = new Float32Array(MAX_FOLDS * 3)
  const foldJitter = new Float32Array(MAX_FOLDS)
  const out = new Uint8Array(FRONT.w * FRONT.h * 4)

  const draw = (o: DrawOptions): Err | Uint8Array => {
    // `edgeShape: 'smooth'`: one field into both slots, no blur at all. `edgeShape: 'torn'`: the
    // artwork's tight field and its blur.
    let tightSrc = tight
    let looseTex = tight.target.texture
    let looseDecode: readonly [number, number] = tight.decode
    if (o.bindPolygonToBoth === true) {
      if (polygon === null) {
        return new GlError('paper-shader.gl.test: bindPolygonToBoth without a polygonRadius')
      }
      tightSrc = polygon
      looseTex = polygon.target.texture
      looseDecode = polygon.decode
    } else {
      const loose = builder.blurField({
        field: tight,
        sigmaPx: sigmaFor(o.looseness, FRONT.w),
        frontLongSide: FRONT.w,
      })
      if (GlError.is(loose)) return loose
      looseTex = loose.target.texture
      looseDecode = loose.decode
    }
    const failed = ctx.scope((s): Err | undefined => {
      const { gl } = ctx
      gl.useProgram(program.handle)
      s.bindTarget(drawTargetFor(target))
      s.enable('BLEND', false)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      const loc = (key: keyof typeof PAPER_UNIFORMS) => program.uniformLocation(PAPER_UNIFORMS[key])
      const bind = (unit: number, texture: WebGLTexture, key: keyof typeof PAPER_UNIFORMS) => {
        gl.activeTexture(gl.TEXTURE0 + unit)
        gl.bindTexture(gl.TEXTURE_2D, texture)
        gl.uniform1i(loc(key), unit)
      }
      bind(0, artwork.handle, 'image')
      bind(1, tightSrc.target.texture.handle, 'sdfTight')
      bind(2, looseTex.handle, 'sdfLoose')
      // Unit 3 is free since `uPaperField` was deleted (design 2026-09-05 §6).
      bind(4, tiles.crumpleR.handle, 'crumpleR')
      bind(5, tiles.crumpleG.handle, 'crumpleG')
      bind(6, tiles.crumpleA.handle, 'crumpleA')
      bind(7, tiles.fibreA.handle, 'fibreA')
      gl.uniform2f(loc('decodeTight'), tightSrc.decode[0], tightSrc.decode[1])
      gl.uniform2f(loc('decodeLoose'), looseDecode[0], looseDecode[1])
      gl.uniform4f(loc('tightUv'), 1, 1, 0, 0)
      gl.uniform2f(loc('frontSize'), FRONT.w, FRONT.h)
      // prettier-ignore
      gl.uniform4f(
        loc('artworkRect'), ARTWORK_RECT.x, ARTWORK_RECT.y, ARTWORK_RECT.w, ARTWORK_RECT.h,
      )
      gl.uniform1f(loc('aspect'), FRONT.w / FRONT.h)
      gl.uniform1f(loc('planePx'), FRONT.h)
      gl.uniform1f(loc('aaPx'), 1)
      gl.uniform1f(loc('pxScale'), PXS)
      // The three uniforms this task exists for.
      gl.uniform1f(loc('edgeWidth'), o.edgeWidthRef * PXS)
      gl.uniform1f(loc('baseBias'), o.baseBiasRef * PXS)
      gl.uniform1i(loc('edgeFinish'), o.edgeFinish)
      gl.uniform1f(loc('tearFreq'), 9)
      gl.uniform1f(loc('tearAmp'), o.tearAmpRef * PXS)
      gl.uniform1f(loc('midAmp'), o.midAmpRef * PXS)
      gl.uniform1f(loc('chew'), o.chewRef * PXS)
      gl.uniform1f(loc('tearAngular'), o.tearAngular)
      gl.uniform1f(loc('fiberDens'), 0.8)
      gl.uniform1f(loc('fiberLen'), 4 * PXS)
      gl.uniform1f(loc('grain'), 0.09)
      gl.uniform1f(loc('deckleWidth'), 7 * PXS)
      gl.uniform1f(loc('deckleLight'), 0.6)
      gl.uniform1f(loc('deckleTex'), 0.3)
      gl.uniform1f(loc('tearShadow'), 0.4)
      gl.uniform1f(loc('creases'), 0.035)
      gl.uniform3f(loc('paperColor'), 0.97, 0.96, 0.93)
      gl.uniform3f(loc('paperBack'), 0.99, 0.98, 0.96)
      // The front build's four fixed uniforms (spec 8.6): shadow off, no folds, no crumple, no
      // debug view. `uShadowBlur > 0` is part of `frontFastPath()`'s guard, so it is not optional.
      gl.uniform1f(loc('shadow'), 0)
      gl.uniform1f(loc('shadowBlur'), 13 * PXS)
      gl.uniform2f(loc('shadowOffset'), (5 * PXS) / FRONT.w, (-7 * PXS) / FRONT.h)
      gl.uniform1f(loc('seed'), (o.seed % 17) + 0.31 * o.seed)
      gl.uniform3fv(loc('folds'), folds)
      gl.uniform1fv(loc('foldJitter'), foldJitter)
      gl.uniform1i(loc('foldCount'), 0)
      gl.uniform1f(loc('creaseDark'), 0.42)
      gl.uniform1f(loc('creaseWidth'), 2.5 * PXS)
      gl.uniform1f(loc('facetStrength'), 0.8)
      gl.uniform2f(
        loc('lightDir'),
        Math.cos((125 * Math.PI) / 180),
        Math.sin((125 * Math.PI) / 180),
      )
      gl.uniform1f(loc('depthDark'), 0.2)
      gl.uniform1f(loc('slack'), 0)
      gl.uniform1f(loc('flapReach'), 30 * PXS)
      gl.uniform1f(loc('crumpleFill'), 0)
      gl.uniform2f(loc('crumpleDepth'), 1.4, 1.9)
      gl.uniform1f(loc('crumpleCells'), 20)
      gl.uniform1f(loc('crumpleBite'), 0.11)
      gl.uniform1f(loc('photoCrumple'), 0.2)
      gl.uniform1f(loc('photoFibre'), 0.8)
      gl.uniform1f(loc('ballR'), 0.3)
      gl.uniform1f(loc('sheetCrumple'), 0.12)
      gl.uniform1f(loc('sheetTile'), SHEET_TILE_PX * PXS)
      gl.uniform1i(loc('debug'), 0)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, target.framebuffer)
      gl.readPixels(0, 0, FRONT.w, FRONT.h, gl.RGBA, gl.UNSIGNED_BYTE, out)
      return undefined
    })
    if (failed !== undefined) return failed
    return out.slice()
  }

  return {
    draw,
    dispose() {
      target.dispose()
      front.dispose()
      program.dispose()
      tiles.dispose()
      builder.dispose()
      pools.dispose()
      fixture.dispose()
    },
  }
}

function expectOk<T>(v: Err | T): T {
  expect(GlError.is(v), GlError.is(v) ? v.message : '').toBe(false)
  if (GlError.is(v)) return v as never
  return v
}

/** Texels the sheet covers: alpha over half. */
function coveredTexels(pixels: Uint8Array): number {
  let n = 0
  for (let i = 3; i < pixels.length; i += 4) if ((pixels[i] ?? 0) > 127) n++
  return n
}

/**
 * The outermost radius, along `angle` from the front's centre, at which the sheet is still
 * covered — the silhouette's own contour on that ray, in front texels. `NaN` when the ray never
 * finds paper (a direction the sheet does not reach at all).
 */
function contourRadius(pixels: Uint8Array, angle: number): number {
  const cx = FRONT.w / 2
  const cy = FRONT.h / 2
  const dx = Math.cos(angle)
  const dy = Math.sin(angle)
  const maxR = Math.min(FRONT.w, FRONT.h) / 2 - 1
  const step = 0.25
  for (let r = maxR; r > 0; r -= step) {
    const x = Math.round(cx + dx * r)
    const y = Math.round(cy + dy * r)
    if (x < 0 || y < 0 || x >= FRONT.w || y >= FRONT.h) continue
    if ((pixels[(y * FRONT.w + x) * 4 + 3] ?? 0) > 127) return r
  }
  return Number.NaN
}

const RAYS = 720

/** Per-ray contour displacement of `on` relative to `off`, in front texels. */
function displacements(on: Uint8Array, off: Uint8Array): number[] {
  const out: number[] = []
  for (let i = 0; i < RAYS; i++) {
    const a = (i / RAYS) * Math.PI * 2
    const rOn = contourRadius(on, a)
    const rOff = contourRadius(off, a)
    if (Number.isNaN(rOn) || Number.isNaN(rOff)) continue
    out.push(rOn - rOff)
  }
  return out
}

const mean = (xs: readonly number[]): number =>
  xs.length === 0 ? Number.NaN : xs.reduce((a, b) => a + b, 0) / xs.length

/**
 * The contour's mean radius along the four axes, in front texels. For the centred square sample
 * every axis reads the same half-width, so averaging them only cancels the ray walk's own rounding.
 */
function axisRadius(pixels: Uint8Array): number {
  const rs = [0, 0.5, 1, 1.5].map((q) => contourRadius(pixels, q * Math.PI))
  expect(rs.some(Number.isNaN), 'a ray found no paper at all').toBe(false)
  return mean(rs)
}

const W_WORKING = W_REF * PXS
/** The stand-in hull polygon sits exactly one edge width outside the artwork, as `hullBandFor` puts it. */
const POLYGON_R = SQUARE_R + W_WORKING
/** Field quantisation, the jump flood's own error, the 0.6 px alpha ramp and the ray walk's rounding. */
const RADIUS_TOL = 2

/**
 * The `edgeShape: 'smooth'` binding, and the two halves of the uniform split it exists to protect.
 *
 * This is the regression case for **ruling R12**. The design document's own §6 table says the
 * width uniform is `W` in all four cells; the plan corrects that to `uBaseBias = 0` under
 * `smooth`, because the polygon already sits at `W (1 +/- v)` and biasing it again reaches `2W`.
 * Before this case existed, someone "restoring the spec" by uploading `uBaseBias = W` under
 * `smooth` — or by making `scrapUnguarded` add `uEdgeWidth` instead — broke nothing in this
 * repository. Case A vs case B is exactly that difference, measured.
 *
 * The setup is what Task 6 must implement: ONE field (a square standing in for the hull polygon,
 * built one edge width outside the artwork) bound to `uSdfTight` AND `uSdfLoose`, no blur, and
 * `uBaseBias = 0`. `scrapUnguarded` then returns `max(pf, pf) + 0 = pf`.
 */
describe('PAPER_FS — the smooth binding and the uniform split (design 2026-09-05 §6, ruling R12)', () => {
  let scenes: Scene[] = []
  afterEach(() => {
    for (const s of scenes) s.dispose()
    scenes = []
  })

  /**
   * Every number the cases below and the §11 measurements are quoted against comes out of
   * `defaultsFor(torn/paper/px)`. If the knob table drops or renames one, this fails first and
   * names it, rather than a measurement silently reporting the `edgeWidth = 0` cell (ruling R3).
   */
  it('resolves every measured knob default from the knob table', () => {
    for (const key of MEASURED_KNOBS) {
      expect(Number.isFinite(knobDefault(key)), `no finite default for knob '${key}'`).toBe(true)
    }
  })

  const SMOOTH = {
    looseness: 0,
    edgeWidthRef: W_REF,
    baseBiasRef: 0,
    edgeFinish: 0,
    seed: 3,
    tearAmpRef: 0,
    midAmpRef: 0,
    chewRef: 0,
    tearAngular: 0,
    bindPolygonToBoth: true,
  } as const satisfies DrawOptions

  it('puts the contour at the polygon, not at twice the width', () => {
    const scene = expectOk(openScene('square', POLYGON_R))
    scenes.push(scene)

    // A. The smooth cell as the redesign specifies it: the polygon's own contour, untouched.
    const a = axisRadius(expectOk(scene.draw(SMOOTH)))
    expect(a).toBeGreaterThan(POLYGON_R - RADIUS_TOL)
    expect(a).toBeLessThan(POLYGON_R + RADIUS_TOL)

    // B. The spec's version of the table, i.e. the bug R12 forbids: bias the polygon by W again.
    // The contour lands a whole edge width further out — at the artwork plus 2W. This half is
    // what makes A's assertion mean something: the bias demonstrably CAN move the contour, so A
    // pins that it does not.
    const b = axisRadius(expectOk(scene.draw({ ...SMOOTH, baseBiasRef: W_REF })))
    expect(b - a).toBeGreaterThan(W_WORKING - RADIUS_TOL)
    expect(b - a).toBeLessThan(W_WORKING + RADIUS_TOL)
    expect(b).toBeGreaterThan(SQUARE_R + 2 * W_WORKING - RADIUS_TOL)

    // C. edgeK() reads uEdgeWidth, NOT uBaseBias. Under `smooth` the bias is 0, so if the master
    // ramp read it the octaves would be gated off entirely and a large tearAmp would do nothing.
    // It reads the width, which is W here, so the ramp is at its top and the tear moves the
    // contour. (`smooth` uploads zero amplitudes in production — this drives them by hand
    // precisely because the uniform they are gated by is what is under test.)
    const c = expectOk(scene.draw({ ...SMOOTH, tearAmpRef: 40, tearAngular: 0 }))
    const moved = displacements(c, expectOk(scene.draw(SMOOTH)))
    expect(Math.max(...moved.map(Math.abs))).toBeGreaterThan(1)

    // D. edgeWidth 0 bottoms the ramp out at the artwork's own alpha — design §7's "the sheet IS
    // the artwork", which is where the deleted `uEdgeMode == 2` branch went. The polygon field is
    // still bound to both slots and the tear amplitude is still large; neither reaches the mask.
    const d = axisRadius(
      expectOk(scene.draw({ ...SMOOTH, edgeWidthRef: 0, tearAmpRef: 40, tearAngular: 0 })),
    )
    expect(d).toBeGreaterThan(SQUARE_R - RADIUS_TOL)
    expect(d).toBeLessThan(SQUARE_R + RADIUS_TOL)
  })
})

describe('PAPER_FS — the design §11 measurements (ruling R13: measurements, not gates)', () => {
  let scenes: Scene[] = []
  afterEach(() => {
    for (const s of scenes) s.dispose()
    scenes = []
  })

  const AMPS = tearAmpsFor({
    widthRef: W_REF,
    variance: VARIANCE,
    tearMix: TEAR_MIX,
    tearAngular: TEAR_ANGULAR,
    chew: CHEW_REF,
  })

  const TORN_PAPER = {
    edgeWidthRef: W_REF,
    baseBiasRef: W_REF,
    edgeFinish: 1,
    seed: 3,
    tearAmpRef: AMPS.tearAmp,
    midAmpRef: AMPS.midAmp,
    chewRef: CHEW_REF,
    tearAngular: TEAR_ANGULAR,
  } as const satisfies Omit<DrawOptions, 'looseness'>

  /**
   * §11 item 1 — what `looseness` still does now that the outward push is zero.
   *
   * `uLoosePush` is gone (design §6.1 item 2), so `looseness` reaches the shader only through the
   * pass B blur sigma that produced `uSdfLoose`. The question the design asks is whether the knob
   * still MOVES the silhouette, i.e. whether `max(tight, loose)` still fills concavities without
   * the push putting the blur's shrink back.
   *
   * The brief names the `sweater` and `trench` demo samples; those are playground PNG assets and
   * are reachable from neither this package's fixtures nor its GL suite (deviation, recorded in
   * the task report). The pair used instead answers the same question more sharply: `figure` is
   * the bench silhouette (a head over two legs — a deep concavity between the legs and two more
   * under the head), `square` is a convex control on which a concavity-filling term must do
   * nothing at all.
   *
   * measurement, not a gate — the verdict line lives in the task report.
   */
  it('reports what looseness still does with the push at zero (design §11, item 1)', () => {
    const rows: string[] = []
    for (const sample of ['figure', 'square'] as const) {
      const scene = expectOk(openScene(sample))
      scenes.push(scene)
      for (const looseness of [0, 0.5, 1]) {
        const covered = coveredTexels(expectOk(scene.draw({ ...TORN_PAPER, looseness })))
        rows.push(`${sample} looseness ${looseness}: ${covered}`)
      }
    }
    console.log(`[§11 item 1]\n${rows.join('\n')}`)
    expect(rows).toHaveLength(6)
  })

  /**
   * §11 item 2 — the tear's own displacement distribution.
   *
   * The contour is cast as 720 rays from the front's centre and the outermost covered radius on
   * each is compared between a render with the octaves ON and one with every octave amplitude at
   * zero, for seeds 3, 7 and 11. The difference is what the tear did to the silhouette, in front
   * texels, converted to reference px by `PXS`.
   *
   * Three further renders isolate the octaves: low only, mid only, teeth only. `bite` and `tab`
   * are NOT separable this way — they are summed inside one GLSL expression with no uniform
   * between them (`midAng = -bite * 1.0 + tab * 0.55`) — so what is reported for the mid octave is
   * their combined mean. That is a deviation from the brief's `E[bite]` / `E[tab]` breakdown and
   * is recorded as one in the task report.
   *
   * measurement, not a gate. The `± 0.25 · W · v` bound below is roughly 78x the magnitude the
   * design's §5 estimate predicts (−0.08 … −0.09 reference px per unit), so it is a SMOKE TEST
   * that the tear has not acquired a gross bias — not a bound on anything. The real deliverable
   * is the histogram and the four means in the task report.
   */
  it('reports the tear displacement distribution (design §11, item 2)', () => {
    const scene = expectOk(openScene('figure'))
    scenes.push(scene)
    const rows: string[] = []
    const all: number[] = []
    for (const seed of [3, 7, 11]) {
      const base = { ...TORN_PAPER, seed, looseness: 0.5 }
      const off = expectOk(scene.draw({ ...base, tearAmpRef: 0, midAmpRef: 0, chewRef: 0 }))
      const on = expectOk(scene.draw(base))
      const lowOnly = expectOk(scene.draw({ ...base, midAmpRef: 0, chewRef: 0 }))
      const midOnly = expectOk(scene.draw({ ...base, tearAmpRef: 0, chewRef: 0 }))
      const teethOnly = expectOk(scene.draw({ ...base, tearAmpRef: 0, midAmpRef: 0 }))
      const d = displacements(on, off)
      all.push(...d)
      const px = (xs: number[]) => (mean(xs) / PXS).toFixed(4)
      rows.push(
        `seed ${seed}: n=${d.length} mean=${px(d)} low=${px(displacements(lowOnly, off))} ` +
          `mid=${px(displacements(midOnly, off))} teeth=${px(displacements(teethOnly, off))}`,
      )
    }
    // Twenty bins over the observed range, in reference px.
    const ref = all.map((x) => x / PXS)
    const lo = Math.min(...ref)
    const hi = Math.max(...ref)
    const bins = new Array<number>(20).fill(0)
    for (const x of ref) {
      const i = Math.min(19, Math.max(0, Math.floor(((x - lo) / (hi - lo || 1)) * 20)))
      bins[i] = (bins[i] ?? 0) + 1
    }
    const overall = mean(ref)
    console.log(
      `[§11 item 2]\n${rows.join('\n')}\n` +
        `range ${lo.toFixed(3)}..${hi.toFixed(3)} reference px, overall mean ${overall.toFixed(4)}\n` +
        `bins ${bins.join(',')}`,
    )
    expect(Math.abs(overall)).toBeLessThanOrEqual(0.25 * W_REF * VARIANCE)
  })
})
