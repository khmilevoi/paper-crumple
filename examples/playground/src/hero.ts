import { useCallback } from 'react'
import type * as pc from '@paper-crumple/core'
import { useCrumple } from '@paper-crumple/react'
import type { Crumple, Scene } from '@paper-crumple/react'

import type { BuiltStage } from './config'
import { frameArtwork } from './framing'
import type { Sample } from './samples'

/** What a swap gets when sound is off or silent — the fold has to last *something*. */
export const SWAP_DURATION_MS = 900

export interface SlotStyle {
  readonly width: string
  readonly height: string
}

export interface HeroOptions {
  readonly scene: Scene
  readonly built: BuiltStage | null
  readonly shown: Sample
  readonly duration: number
  readonly onEnd: () => void
  readonly observed: (where: string, error: Error) => void
}

export interface Hero {
  readonly crumple: Crumple
  readonly slotStyle: SlotStyle | null
}

/**
 * The `.stage-frame` box.
 *
 * `<Crumple>`'s `frameStyle` sizes the WRAPPER to the paper box and offsets it so the artwork lands
 * where the wrapper would otherwise have been — `frameStyleFor` is `frameArtwork(...).canvas` plus
 * `.offset`, the same four multiplications by one scale. What the package does not produce is
 * `frameArtwork(...).image`, the artwork's own rectangle, and the playground needs it: the slot is
 * what the layout reserves, and the paper hangs off it out of flow so no edge parameter can move
 * the picture (`framing.ts`).
 */
export function heroSlotStyle(frame: pc.ViewFrame | null, cssPx: number): SlotStyle | null {
  if (frame === null) return null
  const { image } = frameArtwork(frame, cssPx)
  return { width: `${String(image.w)}px`, height: `${String(image.h)}px` }
}

/**
 * A dropped file, as a sample.
 *
 * `seq` is in the key and is not decoration: `useCrumple` keeps a `Map<spriteKey, src>` and refuses
 * a key it has already seen bound to a different source, comparing by identity — *"a key names a
 * PICTURE, not a slot"*. Two files of one name would otherwise collide, and the second drop would
 * be reported instead of shown.
 */
export function droppedSample(file: File, seq: number): Sample {
  return { id: `dropped-${String(seq)}`, label: file.name, src: file }
}

/**
 * `duration` is WALL TIME IN MILLISECONDS for the whole traversal (§5.1), not a multiplier, so a
 * zero would be a swap with no traversal at all rather than a request for the default.
 */
export function swapDurationFor(fromAudio: number | null | undefined): number {
  return fromAudio === null || fromAudio === undefined || fromAudio <= 0
    ? SWAP_DURATION_MS
    : fromAudio
}

/**
 * The hero: one `useCrumple` over the whole demo.
 *
 * `spriteKey` and `src` come from `shown`, so changing the picture IS the swap. The hook decides
 * entrance-or-swap by whether its view is showing anything (§5.4), which is also what makes a scene
 * rebuild replay the entrance on a stage that has nothing in it (§5.2).
 *
 * `frameTo` is `built.artworkCssPx`, the same number the stage was built with, so the result is 1:1
 * at `devicePixelRatio` (§6). It is an option rather than something the binding works out because
 * the consumer writes the `paperStage(...)` call and that number never passes through the package.
 *
 * `fit: 'contain'` and not `'stretch'`, exactly as the pre-migration `mountHero`
 * (`075dc4e:examples/playground/src/stage.ts`, deleted by this plan's rewire) chose: the wrapper
 * carries the drawn box's own aspect, so there is nothing left to letterbox, and the two differ
 * only by the sub-pixel rounding between them — `contain` spends that on a sub-pixel bar rather
 * than a sub-pixel stretch.
 * It is fixed at `stage.view()` and a later change is silently ignored, which is why it is a hook
 * option and never a prop.
 */
export function useHero(o: HeroOptions): Hero {
  const { observed } = o
  const onError = useCallback(
    (e: pc.StageEvent<'error'>): void => {
      // §7's orphan channel: `observed: true` means the error is, or will be, a return value
      // someone can narrow, so reporting it here as well double-counts it.
      if (!e.observed) observed('useCrumple', e.error)
    },
    [observed],
  )

  const crumple = useCrumple({
    scene: o.scene,
    spriteKey: o.shown.id,
    src: o.shown.src,
    fit: 'contain',
    tag: o.shown.id,
    duration: o.duration,
    frameTo: o.built?.artworkCssPx,
    onEnd: o.onEnd,
    onError,
  })

  // When there is no build yet, return null to let the stylesheet's default size stand during
  // rebuild, matching `frameStyleFor`'s pattern — a real 0px × 0px box is reachable because
  // crumple.frame stays stale until an effect runs while built becomes null synchronously.
  return {
    crumple,
    slotStyle: o.built === null ? null : heroSlotStyle(crumple.frame, o.built.artworkCssPx),
  }
}
