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
 *   - The spike's two RGBA tile binds become four `R8` plane binds (spec 14), so the texture units
 *     this shader needs are `0 uImage, 1 uSdfTight, 2 uSdfLoose, 4 uCrumpleR, 5 uCrumpleG,
 *     6 uCrumpleA, 7 uFibreA`. Unit 3 held `uPaperField` until Task 5 deleted it (design
 *     2026-09-05 §6) and is now free.
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
 * **The four-cell binding table (design 2026-09-05 §6).** There is no `uEdgeMode` and no mode int
 * to switch on: the CONTOUR SOURCE is expressed by WHICH TEXTURES this module binds, and the
 * decoration by `uEdgeFinish` alone. The ancestor spike's `edge.js:104-110` trick — bind one field
 * to both `uSdf*` slots — stops being one mode's special case and becomes the general rule.
 *
 * | `edgeSpec.shape` | `uSdfTight` / `uSdfLoose`     | `uEdgeFinish` | `uEdgeWidth` | `uBaseBias` | `uTearAmp` / `uMidAmp` / `uChew` |
 * |------------------|-------------------------------|---------------|--------------|-------------|----------------------------------|
 * | `smooth`         | polygon field / polygon field | 0 or 1        | `W`          | `0`         | `0`                              |
 * | `torn`           | artwork tight / artwork loose | 0 or 1        | `W`          | `W`         | derived (`edge-derive.ts`)       |
 *
 * Under `smooth` both slots point at the polygon's own field, so `scrapUnguarded` returns
 * `max(pf, pf) + 0 = pf` — the polygon's contour exactly, border guard included. There is no
 * polygon-field uniform to bind it to instead: `uPaperField` / `uDecodePaper` and `samplePaper`
 * were deleted in Task 5, and the fold loop's own lookups go through `paperFieldFast`, which reads
 * the same two `uSdf*` slots as everything else.
 *
 * `looseness` is NOT uploaded and never was a uniform of its own after §6.1: it reaches the shader
 * through the CONTENTS of `uSdfLoose` (`sigmaFor` -> `blurField`, `sheet.ts`), which is why the
 * `torn` row binds the artwork's genuinely blurred loose field rather than its tight one twice.
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
import type { EdgeSpec, GlContext, Texture } from '@paper-crumple/core/unstable'
import {
  FULLSCREEN_VS,
  hexToRgb,
  pxScale as pxScaleOf,
  scaleKnob,
} from '@paper-crumple/core/unstable'
import { CHEW_REACH, midHigh, tearAmpsFor } from './edge-derive.js'
import type { TearAmps } from './edge-derive.js'
import type { Field, LooseField } from './gl-sdf.js'
import { defaultsFor } from './paper-knobs.js'
import {
  FIBRE_TILE_PX,
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

/**
 * Ruling R3's fallback, once and in one place: the edge knobs' own SHIPPED defaults.
 *
 * Every value that feeds BOTH `tearAmpsFor` and a uniform upload has to be ONE resolved number.
 * The plan's own snippet resolved them twice — `tearAmpsFor(rawNum('tearAngular', 0))` against
 * `uniform1f(rawNum('tearAngular', 0.8))` — and on an incomplete knob bag those are different
 * numbers: the amplitudes come out normalised by `midLow(0) = 0.225` while the shader applies
 * `midLow(0.8) = 0.845`, inflating the inward reach by 3.8x and breaking the `W (1 +- v)` identity
 * the whole redesign rests on. So: no bare-literal fallback for any edge knob, here or at the
 * upload.
 *
 * This is the WIDEST cell's bag (`torn`/`paper`) rather than `defaultsFor(r.edgeSpec)`, and
 * deliberately: `descriptorsFor` composes the same descriptor objects into all four cells, so a
 * knob's default does not vary by cell, while a knob the rendered cell does not declare is still
 * read by the shader — `tearFreq` is a torn-shape knob (§2.2) and the deckle band's own width
 * noise reads it under `smooth` too. The one descriptor whose default DOES vary by cell is
 * `edgeWidth` (`WIDTH_PX_KNOB` 47 against `WIDTH_PCT_KNOB` 5.9), and it is never read here: the
 * width arrives already resolved to reference px as `FrontRenderRequest.widthRef` (§3.1).
 */
const EDGE_DEFAULTS: Readonly<Record<string, string | number | boolean>> = defaultsFor({
  shape: 'torn',
  finish: 'paper',
  widthUnit: 'px',
})

const NO_TEAR: TearAmps = { tearAmp: 0, midAmp: 0 }

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
  /**
   * The hull polygon's own field, or `null` when no polygon was built.
   *
   * Under `edgeSpec.shape === 'smooth'` this IS the contour source and is bound to BOTH `uSdfTight`
   * and `uSdfLoose` (design 2026-09-05 §6). `null` falls back to `r.tight`, which collapses the
   * sheet onto the artwork's own alpha — the degenerate case the deleted `uEdgeMode = 2` used to
   * name (spike `paper.js:2159`), reached now by having no polygon rather than by a mode. Ignored
   * under `torn`, which always binds the artwork's own tight/loose pair.
   */
  readonly paperField: Field | null
  /** Which cell of design 2026-09-05 §6's table this front is. Replaces `edgeMode`. */
  readonly edgeSpec: EdgeSpec
  /**
   * `W`, in REFERENCE px — this module scales it by `front.h / KNOB_REFERENCE_PX` itself.
   *
   * Resolved by the CALLER, not read off `values`: the `percent` width unit's conversion needs the
   * sprite's aspect and the frozen reserve, neither of which a knob bag carries (design §3.1), so
   * `paperSheet`'s `build()` / `source()` owns that step and hands the answer down.
   */
  readonly widthRef: number
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
    const pxs = pxScaleOf(r.front.h)

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
    /**
     * An EDGE knob, resolved ONCE (ruling R3): the caller's value if it set one, otherwise that
     * knob's own shipped default from `EDGE_DEFAULTS`. Never a bare literal — the same number has
     * to reach `tearAmpsFor` and the uniform, or the shader and the derivation disagree about the
     * band. `NaN` rather than `0` if a key reaches this that no descriptor declares, for the reason
     * `edgeParamsFrom` gives: a missing value must never be indistinguishable from a deliberate
     * zero.
     */
    function edgeNum(key: string): number {
      const v = r.values[key]
      if (typeof v === 'number' && Number.isFinite(v)) return v
      const d = EDGE_DEFAULTS[key]
      return typeof d === 'number' ? d : NaN
    }
    /**
     * The same value, in working px. Every DIMENSIONAL edge knob is `reference: 'sprite-px'` (§2.3),
     * so the conversion is `pxs` and does not need the descriptor — which the rendered cell may not
     * even declare (`fiberLen` under `finish: 'clean'`, `chew` under `shape: 'smooth'`), and where
     * `scaled` would silently hand back an UNSCALED number.
     */
    const edgePx = (key: string): number => edgeNum(key) * pxs

    const paperColorRgb = hexToRgb(rawStr('paperColor', sharedColorDefault('paperColor')))
    if (paperColorRgb instanceof Error) {
      return new GlError('paper.renderFront: paperColor', { cause: paperColorRgb })
    }
    const paperBackRgb = hexToRgb(rawStr('paperBack', sharedColorDefault('paperBack')))
    if (paperBackRgb instanceof Error) {
      return new GlError('paper.renderFront: paperBack', { cause: paperBackRgb })
    }

    // design 2026-09-05 §6: the CONTOUR SOURCE is expressed by WHICH TEXTURES are bound, never by
    // editing the shader — the general form of the ancestor spike's `edge.js:104-110` trick that
    // `'both'` used to be the only user of. Under `smooth` both slots point at the polygon's own
    // field, which collapses `scrapUnguarded`'s tight/loose union onto the polygon's contour;
    // under `torn` they are the artwork's own pair, as they always were. `looseness` still reaches
    // the shader here — through the CONTENTS of `r.loose` (`sigmaFor` -> `blurField`), never
    // through a uniform of its own.
    const smooth = r.edgeSpec.shape === 'smooth'
    const contour: Field = smooth ? (r.paperField ?? r.tight) : r.tight
    const looseTexture = smooth ? contour.target.texture : r.loose.target.texture
    const looseDecode = smooth ? contour.decode : r.loose.decode
    // §2.5's zero rule, stated once: no rim means nothing to decorate, so the finish knobs stay in
    // the bag and stop having an effect.
    const widthRef = Number.isFinite(r.widthRef) && r.widthRef > 0 ? r.widthRef : 0
    const finishOn = r.edgeSpec.finish === 'paper' && widthRef > 0
    // Under `smooth` the polygon already sits at `W (1 +- v)`, so biasing it again would reach
    // `2 W` (§6.1 item 1, and ruling R12's correction to the spec's own table); under `torn` the
    // bias IS the band (§5).
    const baseBias = smooth ? 0 : widthRef

    // Ruling R3: ONE resolved number per edge knob, above BOTH the derivation and the upload.
    // `uTearAngular` is not an amplitude — `baseAngular` (`paper-shader.ts`) is gated on
    // `uTearAngular * edgeK()` and on nothing else, so a non-zero value here would POLYGONISE the
    // polygon under `smooth`, chamfering every concavity on a coarse lattice, and would put
    // `farOutside`'s `angTerm` back into the early-out's reach. Zeroing it under `smooth` and
    // zeroing the amplitudes are the same decision and are taken here together.
    const tearAngular = smooth ? 0 : edgeNum('tearAngular')
    const chewRef = smooth ? 0 : edgeNum('chew')
    const amps = smooth
      ? NO_TEAR
      : tearAmpsFor({
          widthRef,
          variance: edgeNum('edgeVariance'),
          tearMix: edgeNum('tearMix'),
          tearAngular,
          chew: chewRef,
        })
    // Ruling R4: the whole OUTWARD reach of the tear, not its low octave alone. `midAmp` reaches
    // out by `midHigh(tearAngular)` per unit (`midAng`'s `+tab * 0.55` branch mixed against
    // `midSmooth`), and the teeth add `CHEW_REACH * chew` on top of both, independently of the
    // width. 21.16 reference px at the defaults, against the 13.22 `amps.tearAmp` alone reserves —
    // under-reserving clips flaps at pose 2 under `torn`, intermittently.
    const tearReach = amps.tearAmp + midHigh(tearAngular) * amps.midAmp + CHEW_REACH * chewRef

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
      bind(1, contour.target.texture.handle, 'sdfTight')
      bind(2, looseTexture.handle, 'sdfLoose')
      // Unit 3 is free: `uPaperField` / `uDecodePaper` and `samplePaper` were deleted in Task 5
      // (design 2026-09-05 §6). Under `edgeShape: 'smooth'` the polygon's own field goes to
      // `sdfTight` AND `sdfLoose` — a third slot carrying the same texture had no reader.
      bind(4, tiles.crumpleR.handle, 'crumpleR')
      bind(5, tiles.crumpleG.handle, 'crumpleG')
      bind(6, tiles.crumpleA.handle, 'crumpleA')
      bind(7, tiles.fibreA.handle, 'fibreA')

      gl.uniform2f(loc('decodeTight'), contour.decode[0], contour.decode[1])
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

      // design 2026-09-05 §6's table, uploaded. `uEdgeFinish` carries the DECORATION and nothing
      // else; the contour source was decided by the two binds above. `uEdgeWidth` is the master
      // ramp `edgeK()` reads, `uBaseBias` the outward offset of the contour source — the same
      // number under `torn`, deliberately different under `smooth` (ruling R12).
      gl.uniform1i(loc('edgeFinish'), finishOn ? 1 : 0)
      gl.uniform1f(loc('edgeWidth'), widthRef * pxs)
      gl.uniform1f(loc('baseBias'), baseBias * pxs)
      gl.uniform1f(loc('tearFreq'), edgeNum('tearFreq'))
      gl.uniform1f(loc('tearAmp'), amps.tearAmp * pxs)
      gl.uniform1f(loc('midAmp'), amps.midAmp * pxs)
      gl.uniform1f(loc('chew'), chewRef * pxs)
      // The same resolved number `amps` was normalised by (ruling R3), and 0 under `smooth` — see
      // the derivation block above for why that pair is not optional.
      gl.uniform1f(loc('tearAngular'), tearAngular)
      gl.uniform1f(loc('fiberDens'), edgeNum('fibers'))
      gl.uniform1f(loc('fiberLen'), edgePx('fiberLen'))
      gl.uniform1f(loc('grain'), rawNum('grain', 0.09))
      gl.uniform1f(loc('deckleWidth'), edgePx('deckleWidth'))
      gl.uniform1f(loc('deckleLight'), edgeNum('deckleLight'))
      gl.uniform1f(loc('deckleTex'), edgeNum('deckleTex'))
      gl.uniform1f(loc('tearShadow'), edgeNum('tearShadow'))
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
      // Worst case a flap can overshoot the envelope: the tear's own OUTWARD reach (0 under a
      // polygon contour, where the amplitudes are all 0), plus the fibre fringe, plus the arc the
      // jitter rotation swings the far end of a flap through, plus the slack.
      gl.uniform1f(
        loc('flapReach'),
        (tearReach + (finishOn ? edgeNum('fiberLen') * 4 : 0) + 30) * pxs +
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
