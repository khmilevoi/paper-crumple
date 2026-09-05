/**
 * `PaperRenderer` — one program (`PAPER_FS`), one call, the whole uniform upload.
 *
 * **Source: `paper.js:2139-2276`, `PaperRenderer.render`, transcribed uniform by uniform, with
 * every comment carried across.** The differences from the spike are mechanical, not semantic
 * (task 9's brief):
 *
 *   - `bindUnit(gl, unit, texture, location)` becomes an explicit `activeTexture` /
 *     `bindTexture` / `uniform1i` triple inside one `ctx.scope`.
 *   - `bindTarget(gl, target)` becomes `s.bindTarget(r.target)`; the caller owns the
 *     `DrawTarget`, this module never allocates one (spec 7.3: a slot never chooses its
 *     destination and never clears the default framebuffer — the front is the caller's own
 *     offscreen target, so clearing it here is legal, spec 7.3).
 *   - The spike's two RGBA tile binds become four `R8` plane binds (spec 14), so the eight
 *     texture units this shader needs are `0 uImage, 1 uSdfTight, 2 uSdfLoose, 3 uPaperField,
 *     4 uCrumpleR, 5 uCrumpleG, 6 uCrumpleA, 7 uFibreA` — `uPaperField` moved to unit 3 to make
 *     room for the two extra tile planes.
 *
 * **The front's parameters are fixed by `edge.js:86`, and are not negotiable**: `pose: 0,
 * shadow: 0, crumpleFill: 0, debug: 0`. That is why `renderFront` forces `uFoldCount = 0`,
 * `uShadow = 0`, `uCrumpleFill = 0` and `uDebug = 0` regardless of what the caller's knob
 * values say — "the crumpling and the lighting are the 3D layer's job" (spec 8.6), and the
 * `shadow` / `debug` knobs stay declared for a `/unstable` consumer driving `PaperRenderer`
 * directly, outside the front build.
 *
 * **This port never attaches a pre-baked field** (see `./gl-sdf.ts`'s `BLUR_FS` comment, spec
 * 3.3), so `uTightUv` — the spike's `asset.tight.uvScale` / `uvOffset` — is always the identity
 * `(1, 1, 0, 0)` here; the spike's own line computing it from `asset.tight.uvScale ?? [1, 1]`
 * would be dead code in this port and is dropped rather than carried across unused.
 *
 * **`uEdgeMode` and `edge.js`'s third mode.** `paper.js:2157-2163`: `hullMode = edgeMode !==
 * 'torn'`; `edgeMode = hullMode ? (paperField === null ? 2 : 1) : 0`; `uPaperField` is bound to
 * `paperField ?? tight`. For `'both'` — the hull polygon as the silhouette, decorated by the
 * torn shader path — `edge.js:104-110`'s trick is reproduced by choosing which textures are
 * bound, never by editing the shader: both `uSdfTight` and `uSdfLoose` point at the hull's own
 * field (`paperField ?? tight`), which collapses `scrapBase`'s tight/loose union to the
 * polygon's own contour, and `uEdgeMode` is forced to 0 (the torn path) so the tear, fibre,
 * deckle and shadow maths switch on. `edge.js`'s `renderAsset.loose = hullField` carries no
 * `sigmaPx` (a `Field`, not a `LooseField`), so `paper.js:2191`'s `(asset.loose.sigmaPx ?? 0) *
 * LOOSE_PUSH` collapses to `uLoosePush = 0` for `'both'`, exactly as here.
 *
 * **Every px-valued knob passes through `scaleKnob(descriptor, value, front.h)`** (spec 6.4),
 * which is `value * front.h / KNOB_REFERENCE_PX` for a `reference: 'sprite-px'` descriptor and
 * the identity otherwise — so the same helper covers every knob, scaled or not, without this
 * module having to know which keys are which. `uPxScale = front.h / KNOB_REFERENCE_PX` is
 * uploaded once for the shader's own internal reference-px constants (`FRINGE_SPACING`,
 * `EDGE_K_PX`, ...), exactly as the spike does.
 *
 * `paperColor` and `paperBack` are core-declared shared knobs (spec 6.2) and are therefore
 * absent from `descriptorsFor(mode)` / `defaultsFor(mode)` — a slot's own knob bag never
 * carries them. A caller driving `PaperRenderer` straight from `defaultsFor` (as this task's
 * own test does) supplies neither, so a value missing from `r.values` falls back to the
 * core-declared default in `SHARED_KNOBS`.
 */
import { GlError, SHARED_KNOBS } from '@paper-crumple/core'
import type { DrawTarget, KnobDescriptor, Rect, SharedKnob, Size } from '@paper-crumple/core'
import type { GlContext, Texture } from '@paper-crumple/core/unstable'
import {
  FULLSCREEN_VS,
  hexToRgb,
  pxScale as pxScaleOf,
  scaleKnob,
} from '@paper-crumple/core/unstable'
import type { Field, LooseField } from './gl-sdf.js'
import type { PaperEdgeMode } from './paper-knobs.js'
import {
  FIBRE_TILE_PX,
  LOOSE_PUSH,
  MAX_FOLDS,
  PAPER_FS,
  PAPER_UNIFORMS,
  SHEET_TILE_PX,
} from './paper-shader.js'
import type { MountedTiles } from './paper-tiles.js'

// `FIBRE_TILE_PX` is not sampled from this module — the fibre-tile reference scale stays inside
// the shader, at the site `paper-shader.ts`'s own comment names (spike `paper.js:1523`,
// `:1704-1705`). It is imported and re-exported here anyway, per task 9's own interface: it is a
// module constant of this package's public surface, not shader-private, and this is the file a
// `/unstable` consumer driving the fibre tile's own reference scale would otherwise have to
// reach into `./paper-shader.js` directly for.
export { FIBRE_TILE_PX }

type Err = InstanceType<typeof GlError>

const SHARED_DEFAULTS = new Map(SHARED_KNOBS.map((d) => [d.key, d.default] as const))

/** `SHARED_KNOBS`' own default, so a hard-coded literal here can never drift from spec 6.2's. */
function sharedColorDefault(key: SharedKnob): string {
  return SHARED_DEFAULTS.get(key) ?? '#000000'
}

export interface FrontRenderRequest {
  /** Where the front is drawn. A caller-owned offscreen target — this module never allocates
   *  one (spec 7.3: a slot never chooses its own destination). */
  readonly target: DrawTarget
  /** The front's own size, in texels — the padded texture height every px-valued knob is
   *  rescaled against (spec 6.4, spec 8.6). */
  readonly front: Size
  /** Where the unpadded artwork sits inside the front, in front texels. */
  readonly artworkRect: Rect
  /** The unpadded `RGBA8UI` artwork (spec 7.4.1: read with `texelFetch`, never `LINEAR`). */
  readonly artwork: Texture
  readonly tight: Field
  readonly loose: LooseField
  /** The hull polygon's own field, or `null` when none has been built (the degenerate
   *  minDist = maxDist = 0 case, `uEdgeMode = 2`; spike `paper.js:2159`). */
  readonly paperField: Field | null
  readonly edgeMode: PaperEdgeMode
  readonly values: Readonly<Record<string, string | number | boolean>>
  readonly descriptors: readonly KnobDescriptor[]
}

export interface PaperRenderer {
  renderFront(tiles: MountedTiles, r: FrontRenderRequest): Err | undefined
  /**
   * Resolves once `PAPER_FS` has linked — `undefined`, or the link failure (P7, `Program.ready()`,
   * spec 5.2 amendment). `createPaperRenderer` no longer waits for the driver: on ANGLE/D3D11 the
   * HLSL compile ran 42–48 s cold inside `mount()` before P7, seconds after it, and neither belongs
   * on the main thread. `paperSheet`'s `source()` awaits this at its start, so `build()` — and
   * `renderFront` on the library's own path — always finds a linked program; a `/unstable` caller
   * driving `renderFront` directly should await it too, or accept that the first draw blocks on
   * the link exactly as `mount()` used to.
   */
  ready(): Promise<Err | undefined>
  dispose(): void
}

export function createPaperRenderer(ctx: GlContext): Err | PaperRenderer {
  const program = ctx.program(FULLSCREEN_VS, PAPER_FS, 'paper')
  if (GlError.is(program)) return program

  // `paper.js:2220-2221`: `uFolds` / `uFoldJitter` are always uploaded, always zero-filled here
  // (the front build's fold count is forced to 0), and allocated once rather than per call.
  const folds = new Float32Array(MAX_FOLDS * 3)
  const foldJitter = new Float32Array(MAX_FOLDS)

  // A `const` arrow, not a hoisted `function` declaration: `program` is narrowed to `Program`
  // above by the early-return `GlError.is()` check, but that narrowing does not survive into a
  // nested `function` declaration's body (see `gl-sdf.ts`'s `buildField` for the same fix, with
  // the fuller explanation). A `const` arrow has no such hoisting hazard.
  const renderFront = (tiles: MountedTiles, r: FrontRenderRequest): Err | undefined => {
    const descByKey = new Map(r.descriptors.map((d) => [d.key, d] as const))

    function rawNum(key: string, fallback: number): number {
      const v = r.values[key]
      return typeof v === 'number' && Number.isFinite(v) ? v : fallback
    }
    // `scaleKnob` is the identity for a descriptor that is not `reference: 'sprite-px'`, so this
    // one helper covers every knob below whether or not it is quoted in reference px (spec 6.4).
    function scaled(key: string, fallback: number): number {
      const raw = rawNum(key, fallback)
      const d = descByKey.get(key)
      return d === undefined ? raw : scaleKnob(d, raw, r.front.h)
    }
    function rawStr(key: string, fallback: string): string {
      const v = r.values[key]
      return typeof v === 'string' ? v : fallback
    }

    const paperColorRgb = hexToRgb(rawStr('paperColor', sharedColorDefault('paperColor')))
    if (paperColorRgb instanceof Error) {
      return new GlError('paper.renderFront: paperColor', { cause: paperColorRgb })
    }
    const paperBackRgb = hexToRgb(rawStr('paperBack', sharedColorDefault('paperBack')))
    if (paperBackRgb instanceof Error) {
      return new GlError('paper.renderFront: paperBack', { cause: paperBackRgb })
    }

    // `paper.js:2157-2163` and `edge.js`'s third mode (see this module's header comment).
    // `edge.js:116` rewrites `renderParams.edgeMode` to `'torn'` for `'both'` before calling
    // `engine.render`, so `hullMode` inside that call is `false` for `'both'` too — a single
    // `effectiveEdgeMode` reproduces that rewrite instead of computing `hullMode` twice with two
    // different answers for the same request.
    const both = r.edgeMode === 'both'
    const effectiveEdgeMode = both ? 'torn' : r.edgeMode
    const hullMode = effectiveEdgeMode !== 'torn'
    const hullField: Field = r.paperField ?? r.tight
    const uEdgeModeValue = hullMode ? (r.paperField === null ? 2 : 1) : 0
    const tightField: Field = both ? hullField : r.tight
    const looseTexture = both ? hullField.target.texture : r.loose.target.texture
    const looseDecode = both ? hullField.decode : r.loose.decode
    // `edge.js:104-110`: `renderAsset.loose` becomes the hull field for 'both', which carries no
    // `sigmaPx`; `paper.js:2191`'s `?? 0` then zeroes `uLoosePush`.
    const uLoosePushValue = (both ? 0 : r.loose.sigmaPx) * LOOSE_PUSH

    const pxs = pxScaleOf(r.front.h)

    return ctx.scope((s): Err | undefined => {
      const { gl } = ctx
      gl.useProgram(program.handle)
      s.bindTarget(r.target)

      s.enable('BLEND', false)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)

      const loc = (key: keyof typeof PAPER_UNIFORMS) => program.uniformLocation(PAPER_UNIFORMS[key])
      const bind = (unit: number, texture: WebGLTexture, key: keyof typeof PAPER_UNIFORMS) => {
        gl.activeTexture(gl.TEXTURE0 + unit)
        gl.bindTexture(gl.TEXTURE_2D, texture)
        gl.uniform1i(loc(key), unit)
      }

      bind(0, r.artwork.handle, 'image')
      bind(1, tightField.target.texture.handle, 'sdfTight')
      bind(2, looseTexture.handle, 'sdfLoose')
      bind(3, hullField.target.texture.handle, 'paperField')
      bind(4, tiles.crumpleR.handle, 'crumpleR')
      bind(5, tiles.crumpleG.handle, 'crumpleG')
      bind(6, tiles.crumpleA.handle, 'crumpleA')
      bind(7, tiles.fibreA.handle, 'fibreA')

      gl.uniform2f(loc('decodePaper'), hullField.decode[0], hullField.decode[1])
      gl.uniform1i(loc('edgeMode'), uEdgeModeValue)
      gl.uniform2f(loc('decodeTight'), tightField.decode[0], tightField.decode[1])
      gl.uniform2f(loc('decodeLoose'), looseDecode[0], looseDecode[1])
      // Always identity — see this module's header comment.
      gl.uniform4f(loc('tightUv'), 1, 1, 0, 0)

      // `uFrontSize`, port edit 2 (`paper-shader.ts`'s header): `FULLSCREEN_VS` emits no varying,
      // so the shader derives its own uv from `gl_FragCoord.xy / uFrontSize`.
      gl.uniform2f(loc('frontSize'), r.front.w, r.front.h)
      gl.uniform4f(
        loc('artworkRect'),
        r.artworkRect.x,
        r.artworkRect.y,
        r.artworkRect.w,
        r.artworkRect.h,
      )

      // The spike's `asset.image.width / height` were the padded texture's, which is the front
      // here (task 9's brief).
      gl.uniform1f(loc('aspect'), r.front.w / r.front.h)
      gl.uniform1f(loc('planePx'), r.front.h)
      gl.uniform1f(loc('aaPx'), Math.max(0.5, r.front.w / Math.max(1, r.target.viewport.w)))

      gl.uniform1f(loc('pxScale'), pxs)
      // The sheet relief is the same material in both edge modes, so a flap looks the same
      // whichever way the edge was cut.
      gl.uniform1f(loc('sheetCrumple'), rawNum('sheetCrumple', 0.12))
      gl.uniform1f(loc('sheetTile'), SHEET_TILE_PX * pxs)

      gl.uniform1f(loc('looseness'), rawNum('looseness', 0.5))
      // Blurring an SDF with sigma pulls its zero level set inward by roughly half a sigma on
      // anything with curvature. LOOSE_PUSH puts it back, and a little more, which is what turns
      // "smoothed silhouette" into "scrap the artwork sits inside".
      gl.uniform1f(loc('loosePush'), uLoosePushValue)
      gl.uniform1f(loc('thickness'), scaled('thickness', 22))
      gl.uniform1f(loc('tearFreq'), rawNum('tearFreq', 9))
      gl.uniform1f(loc('tearAmp'), scaled('tearAmp', 44))
      gl.uniform1f(loc('midAmp'), scaled('midAmp', 26))
      gl.uniform1f(loc('chew'), scaled('chew', 1.8))
      gl.uniform1f(loc('tearAngular'), rawNum('tearAngular', 0.8))
      gl.uniform1f(loc('fiberDens'), rawNum('fibers', 0.8))
      gl.uniform1f(loc('fiberLen'), scaled('fiberLen', 4))
      gl.uniform1f(loc('grain'), rawNum('grain', 0.09))
      gl.uniform1f(loc('deckleWidth'), scaled('deckleWidth', 7))
      gl.uniform1f(loc('deckleLight'), rawNum('deckleLight', 0.6))
      gl.uniform1f(loc('deckleTex'), rawNum('deckleTex', 0.3))
      gl.uniform1f(loc('tearShadow'), rawNum('tearShadow', 0.4))
      gl.uniform1f(loc('creases'), rawNum('creases', 0.035))
      gl.uniform3f(loc('paperColor'), paperColorRgb[0], paperColorRgb[1], paperColorRgb[2])
      gl.uniform3f(loc('paperBack'), paperBackRgb[0], paperBackRgb[1], paperBackRgb[2])
      // The front build forces the shadow off regardless of the `shadow` knob's value — the 3D
      // layer owns the lighting (spec 8.6, edge.js:86).
      gl.uniform1f(loc('shadow'), 0)
      gl.uniform1f(loc('shadowBlur'), scaled('shadowBlur', 13))
      // Offset in uv, down-right on screen. y is up here, hence the negative.
      gl.uniform2f(loc('shadowOffset'), (5 * pxs) / r.front.w, (-7 * pxs) / r.front.h)
      const seed = rawNum('seed', 3)
      gl.uniform1f(loc('seed'), (seed % 17) + 0.31 * seed)

      gl.uniform3fv(loc('folds'), folds)
      gl.uniform1fv(loc('foldJitter'), foldJitter)
      // The front build renders pose 0, whose fold list is empty (edge.js:86) — the crumpling is
      // the 3D layer's job (spec 8.6) — regardless of what the caller's knob values say.
      gl.uniform1i(loc('foldCount'), 0)
      gl.uniform1f(loc('creaseDark'), rawNum('creaseDark', 0.42))
      gl.uniform1f(loc('creaseWidth'), scaled('creaseWidth', 2.5))
      gl.uniform1f(loc('facetStrength'), rawNum('facetStrength', 0.8))
      const lightRadians = (rawNum('lightAngle', 125) * Math.PI) / 180
      gl.uniform2f(loc('lightDir'), Math.cos(lightRadians), Math.sin(lightRadians))
      gl.uniform1f(loc('depthDark'), rawNum('depthDark', 0.2))
      // One knob drives both halves of the crumple: how far each flap is rotated as it lands,
      // and how far it is allowed to overhang the folds made after it.
      const jitterDeg = rawNum('jitter', 3)
      const jitterRadians = (jitterDeg * Math.PI) / 180
      const slack = (jitterDeg / 14) * 0.06
      gl.uniform1f(loc('slack'), slack)
      // Worst case a flap can overshoot the envelope: the tear itself, plus the arc the jitter
      // rotation swings the far end of a flap through, plus the slack. In hull mode the sheet's
      // envelope is the polygon's own field, so only the arc and the slack reach past it.
      gl.uniform1f(
        loc('flapReach'),
        (hullMode ? 30 : rawNum('tearAmp', 44) + rawNum('fiberLen', 4) * 4 + 30) * pxs +
          (jitterRadians * 0.8 + slack) * r.front.h,
      )
      // The front build always renders pose 0's fill, 0 (edge.js:86) — the 3D layer owns the
      // crumple fill (spec 8.6) — regardless of what the caller's knob values say.
      gl.uniform1f(loc('crumpleFill'), 0)
      const crumpleDepthLo = rawNum('crumpleDepthLo', 1.4)
      gl.uniform2f(
        loc('crumpleDepth'),
        crumpleDepthLo,
        Math.max(crumpleDepthLo + 0.05, rawNum('crumpleDepthHi', 1.9)),
      )
      // Cells per unit of the working space, chosen so the finished ball carries roughly
      // uCrumpleCellsAcross of them edge to edge whatever size the scrap ends at.
      gl.uniform1f(
        loc('crumpleCells'),
        rawNum('crumpleCells', 12) / Math.max(0.05, 2 * rawNum('scrapSize', 0.3)),
      )
      gl.uniform1f(loc('crumpleBite'), rawNum('crumpleBite', 0.11))
      gl.uniform1f(loc('photoCrumple'), rawNum('photoCrumple', 0.2))
      gl.uniform1f(loc('photoFibre'), rawNum('photoFibre', 0.8))
      // `paper.js:2265-2272`'s `ballR` is a reduction over `folds.lines`, folded here to its own
      // `folds.count === 0` branch — the front build's fold count is always 0 — which is 0.3,
      // already inside the spike's own `[0.06, 1]` clamp.
      gl.uniform1f(loc('ballR'), 0.3)
      // Debug views are a `/unstable` concern; the front build never selects one.
      gl.uniform1i(loc('debug'), 0)

      gl.drawArrays(gl.TRIANGLES, 0, 3)
      return undefined
    })
  }

  return {
    renderFront,
    ready: () => program.ready(),
    dispose() {
      program.dispose()
    },
  }
}
