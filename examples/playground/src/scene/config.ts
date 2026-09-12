import * as pc from '@paper-crumple/core'
import {
  defaultsFor,
  descriptorsFor,
  edgeParamsFrom,
  optionsFor,
  paperSheet,
} from '@paper-crumple/paper'
import type { EdgeFinish, EdgeShape, EdgeWidthUnit, PaperSheet } from '@paper-crumple/paper'
import { overscanRadius, percentWidthReserve } from '@paper-crumple/core/unstable'
import { tiles } from '@paper-crumple/paper/tiles'
import { bakedMotion } from '@paper-crumple/motion'
import pack1x1 from '@paper-crumple/motion/packs/1x1'
import pack2x3 from '@paper-crumple/motion/packs/2x3'
import pack3x2 from '@paper-crumple/motion/packs/3x2'
import type { PackModule } from '@paper-crumple/motion'
import type { StageErrorListener } from '@paper-crumple/react'

export type BucketName = '1x1' | '2x3' | '3x2'

const PACKS: Readonly<Record<BucketName, PackModule>> = {
  '1x1': pack1x1,
  '2x3': pack2x3,
  '3x2': pack3x2,
}

export const BUCKET_NAMES: readonly BucketName[] = ['1x1', '2x3', '3x2']

/**
 * Everything §6.5 calls a factory option: a setting that changes the shape of the program, the
 * set of resources, or the set of other knobs. Changing any of these rebuilds the stage. Knobs,
 * by contrast, are live and cost one draw.
 */
export interface DemoConfig {
  readonly edgeShape: EdgeShape
  readonly edgeFinish: EdgeFinish
  readonly edgeWidthUnit: EdgeWidthUnit
  readonly tiles: boolean
  readonly packs: readonly BucketName[]
  readonly artworkCssPx: number
  readonly budgetMb: number
  readonly overscanHeadroom: number
}

export const DEFAULT_CONFIG: DemoConfig = {
  // The control panel this demo is built to (`Paper Crumple Control Panel v2.dc.html`) boots into
  // the plain cut sheet — `smooth`/`clean`, `paperSheet()`'s own default cell (design 2026-09-05
  // §6, `sheet.ts`'s `PaperSheetOptions` doc comment). `Torn` and `Paper` are one toggle away in
  // "02 Edge" and each rebuilds the stage, exactly as the deleted `edgeMode` segment did.
  edgeShape: 'smooth',
  edgeFinish: 'clean',
  edgeWidthUnit: 'px',
  tiles: true,
  packs: ['1x1', '2x3', '3x2'],
  // The ARTWORK's on-screen long side — the picture is laid out like a 360-px `<img>` and the
  // paper overflows it (`framing.ts`). Matches the width the control panel's own stage gives its
  // sheet (`width: min(360px, 74%)`).
  artworkCssPx: 360,
  budgetMb: 64,
  // The library reserves exactly the paint radius (spec 8.6's `p = r / (1000 - 2r)`), which
  // leaves a silhouette that fills its own bitmap — `camel-coat`, "a photo that still carries
  // its background" — no clearance at all for the shader's guard band, the outer 1.8 % of the
  // front (`GUARD_BAND_INNER = 0.482`) that it cuts flat. Headroom buys that clearance as a
  // fraction of the radius.
  //
  // Raised from 0.25 to 0.3 for task 9 (edge redesign, §9): at 0.25 the live `edgeVariance`
  // ceiling (design §8.6's frozen reserve, `examples/playground/src/paper/edge-ceilings.ts`) tops out
  // at 0.976 of its 0..1 range on `torn`/`clean` — just short of the descriptor's own maximum, so
  // the slider's top few percent silently refused. `torn`/`clean` needs 0.263 of headroom to reach
  // `edgeVariance = 1` exactly (solving `R * (1 + room) = 2 * W_default + 2 * slop` for `room`);
  // 0.3 clears that with margin and, at the library's own defaults, costs about 1.4 additional
  // reference px of guard-margin texels per side on a 324-texel front (`overscanHeadroom` only
  // widens the SLIDER's live room — a build with no live edge knobs moved pays nothing extra). The
  // samples with a transparent border of their own (every other one) need none of it either way.
  overscanHeadroom: 0.3,
}

function numberKnob(knobs: pc.Knobs, key: string, fallback: number): number {
  const value = knobs[`sheet.${key}`]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * A restored hull-tier knob is visible to the first `source()` call, so its factory reserve must
 * be bought before the stage starts adding sprites. The public config remains the user's desired
 * spare room; the returned config translates that room from the restored edge values back onto
 * the library's fixed factory defaults.
 */
export function configForInitialKnobs(config: DemoConfig, knobs: pc.Knobs): DemoConfig {
  const spec = {
    shape: config.edgeShape,
    finish: config.edgeFinish,
    widthUnit: config.edgeWidthUnit,
  } as const
  const defaults = defaultsFor(spec)
  const value = (key: string): number =>
    numberKnob(knobs, key, typeof defaults[key] === 'number' ? defaults[key] : 0)
  const radiusFor = (live: boolean, headroom: number, aspect: number): number => {
    const width = live ? value('edgeWidth') : Number(defaults.edgeWidth)
    const variance = live ? value('edgeVariance') : Number(defaults.edgeVariance)
    const finishTerms =
      spec.finish === 'paper' && width > 0
        ? 4 * (live ? value('fiberLen') : Number(defaults.fiberLen)) +
          (live ? value('deckleWidth') : Number(defaults.deckleWidth))
        : 0
    if (spec.widthUnit === 'percent') {
      return percentWidthReserve({
        pct: Math.max(0, width) / 100,
        aspect,
        variance,
        finishTerms,
        headroom,
      }).radius
    }
    const values = live
      ? {
          ...defaults,
          edgeWidth: width,
          edgeVariance: variance,
          fiberLen: value('fiberLen'),
          deckleWidth: value('deckleWidth'),
        }
      : defaults
    return (
      overscanRadius(edgeParamsFrom(spec, values, Math.max(0, width))) * (1 + Math.max(0, headroom))
    )
  }

  // For percent widths, cross-multiplying the two fractional-linear radius formulas cancels the
  // quadratic term, so their difference can change sign only at an endpoint. `0` is the portrait
  // limit and `1` is square/landscape. The px formula ignores aspect, making the same check inert.
  const aspects = spec.widthUnit === 'percent' ? [0, 1] : [1]
  const covers = (headroom: number): boolean =>
    aspects.every(
      (aspect) =>
        radiusFor(false, headroom, aspect) >= radiusFor(true, config.overscanHeadroom, aspect),
    )
  if (covers(config.overscanHeadroom)) return config

  let low = Math.max(0, config.overscanHeadroom)
  let high = Math.max(1, low * 2)
  while (!covers(high)) high *= 2
  for (let i = 0; i < 48; i++) {
    const mid = (low + high) / 2
    if (!covers(mid)) low = mid
    else high = mid
  }
  return { ...config, overscanHeadroom: high }
}

/** Drop sheet knobs that do not exist in the selected factory cell before React replays them. */
export function knobsForConfig(config: DemoConfig, knobs: pc.Knobs): pc.Knobs {
  const sheetKeys = new Set(
    descriptorsFor({
      shape: config.edgeShape,
      finish: config.edgeFinish,
      widthUnit: config.edgeWidthUnit,
    }).map((descriptor) => `sheet.${descriptor.key}`),
  )
  const out: Record<string, pc.Knobs[string]> = {}
  for (const [key, value] of Object.entries(knobs)) {
    if (!key.startsWith('sheet.') || sheetKeys.has(key)) out[key] = value
  }
  return out
}

/**
 * What one built stage is: the stage itself, and the two slot objects that fed it. The slot objects
 * are kept and handed back, not discarded — `docs/USAGE.md` §7 builds the panel from the slots
 * rather than from `stage.knobs`, because a descriptor's key is slot-local.
 *
 * A plain interface, and no longer a discriminated union: `present: 'direct'` went with the React
 * migration, because `@paper-crumple/react` v1 binds `present: 'blit'` only (react spec §11) and
 * `SceneOptions.create` is typed to return a `pc.BlitStage`.
 */
export interface BuiltStage {
  readonly stage: pc.BlitStage
  readonly sheet: PaperSheet
  readonly motion: ReturnType<typeof bakedMotion>
  readonly buildMs: number
  /**
   * Carried through so the hero is framed at the same number the stage was built with — it is what
   * `useCrumple`'s `frameTo` is given, so the two cannot drift apart.
   */
  readonly artworkCssPx: number
}

/**
 * The slot objects are kept and handed back, not discarded: `docs/USAGE.md` §7 builds the panel
 * from the slots rather than from `stage.knobs`, because a descriptor's key is slot-local and
 * only the slot knows which namespace it belongs to.
 */
export async function buildStage(
  config: DemoConfig,
  onError: StageErrorListener,
  signal: AbortSignal,
): Promise<BuiltStage | Error | pc.Aborted> {
  const started = performance.now()

  const sheet = paperSheet({
    ...optionsFor({
      shape: config.edgeShape,
      finish: config.edgeFinish,
      widthUnit: config.edgeWidthUnit,
    }),
    tiles: config.tiles ? tiles : null,
    overscanHeadroom: config.overscanHeadroom,
  })
  const motion = bakedMotion({ packs: config.packs.map((b) => PACKS[b]) })

  const base = {
    sheet,
    motion,
    artworkCssPx: config.artworkCssPx,
    budget: config.budgetMb * 1024 * 1024,
    onError,
    signal,
  }

  const stage = await pc.paperStage({ ...base, present: 'blit' })
  if (stage === pc.ABORTED) return pc.ABORTED
  if (stage instanceof Error) return stage
  return {
    stage,
    sheet,
    motion,
    buildMs: performance.now() - started,
    artworkCssPx: config.artworkCssPx,
  }
}
