import * as pc from '@paper-crumple/core'
import { paperSheet } from '@paper-crumple/paper'
import type { PaperSheet } from '@paper-crumple/paper'
import { tiles } from '@paper-crumple/paper/tiles'
import { bakedMotion } from '@paper-crumple/motion'
import pack1x1 from '@paper-crumple/motion/packs/1x1'
import pack2x3 from '@paper-crumple/motion/packs/2x3'
import pack3x2 from '@paper-crumple/motion/packs/3x2'
import type { PackModule } from '@paper-crumple/motion'

export type PresentMode = 'blit' | 'direct'
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
  readonly edgeMode: 'torn' | 'hull'
  readonly tiles: boolean
  readonly packs: readonly BucketName[]
  readonly present: PresentMode
  readonly cssPx: number
  readonly budgetMb: number
  readonly overscanHeadroom: number
}

export const DEFAULT_CONFIG: DemoConfig = {
  edgeMode: 'torn',
  tiles: true,
  packs: ['1x1', '2x3', '3x2'],
  present: 'blit',
  cssPx: 320,
  budgetMb: 64,
  overscanHeadroom: 0,
}

/**
 * A discriminated union, not a plain interface with `stage: pc.BlitStage | pc.DirectStage`: the
 * two fields must be paired so `built.present === 'direct'` narrows `built.stage` too. A flat
 * interface leaves them uncorrelated — `scene.ts`'s direct branch would then call `.view()` on
 * the *union* `BlitStage | DirectStage`, which TypeScript can only accept an argument assignable
 * to the intersection `DirectTarget & BlitTarget`, and no real target satisfies that. Same reason
 * `buildStage` below branches fully on the literal rather than tagging a shared object afterward.
 */
export type BuiltStage =
  | {
      readonly present: 'blit'
      readonly stage: pc.BlitStage
      readonly sheet: PaperSheet
      readonly motion: ReturnType<typeof bakedMotion>
      readonly buildMs: number
      /**
       * Carried through so `scene.ts` can give the `blit` hero canvas a display size that does
       * NOT follow its own backing store — see `heroCanvas`. It is the same number that fed
       * `sizeForDisplay` above, so the two cannot drift apart.
       */
      readonly cssPx: number
    }
  | {
      readonly present: 'direct'
      readonly stage: pc.DirectStage
      readonly sheet: PaperSheet
      readonly motion: ReturnType<typeof bakedMotion>
      readonly buildMs: number
      /**
       * Carried through so `scene.ts` can give the `blit` hero canvas a display size that does
       * NOT follow its own backing store — see `heroCanvas`. It is the same number that fed
       * `sizeForDisplay` above, so the two cannot drift apart.
       */
      readonly cssPx: number
    }

/**
 * The slot objects are kept and handed back, not discarded: `docs/USAGE.md` §7 builds the panel
 * from the slots rather than from `stage.knobs`, because a descriptor's key is slot-local and
 * only the slot knows which namespace it belongs to.
 */
export async function buildStage(
  config: DemoConfig,
  onError: (e: pc.StageEvent<'error'>) => void,
  signal: AbortSignal,
): Promise<BuiltStage | Error | pc.Aborted> {
  const started = performance.now()

  const sheet = paperSheet({
    edgeMode: config.edgeMode,
    tiles: config.tiles ? tiles : null,
    overscanHeadroom: config.overscanHeadroom,
  })
  const motion = bakedMotion({ packs: config.packs.map((b) => PACKS[b]) })

  const base = {
    sheet,
    motion,
    cssPx: config.cssPx,
    budget: config.budgetMb * 1024 * 1024,
    onError,
    signal,
  }

  // The `present` literal selects the overload, so the branch is on the literal and not on a
  // variable — a `present: config.present` would collapse both overloads into a union that
  // neither `resize` nor `view` can be called on. The whole return is built inside each branch,
  // for the same reason: `present` and `stage` must come from the same narrowed arm.
  if (config.present === 'direct') {
    const stage = await pc.paperStage({ ...base, present: 'direct' })
    if (stage === pc.ABORTED) return pc.ABORTED
    if (stage instanceof Error) return stage
    return {
      stage,
      sheet,
      motion,
      present: 'direct',
      buildMs: performance.now() - started,
      cssPx: config.cssPx,
    }
  }

  const stage = await pc.paperStage({ ...base, present: 'blit' })
  if (stage === pc.ABORTED) return pc.ABORTED
  if (stage instanceof Error) return stage
  return {
    stage,
    sheet,
    motion,
    present: 'blit',
    buildMs: performance.now() - started,
    cssPx: config.cssPx,
  }
}
