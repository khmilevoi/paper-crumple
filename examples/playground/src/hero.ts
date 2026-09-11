import { useCrumple, useScene } from '@paper-crumple/react'
import type { Crumple, CrumpleSettleEvent } from '@paper-crumple/react'

import type { BuiltStage } from './config'
import type { Sample } from './samples'

export interface HeroOptions {
  readonly shown: Sample
  readonly duration: number
  readonly onSettle: (event: CrumpleSettleEvent) => void
  readonly observed: (where: string, error: Error) => void
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
 * Both `fit` and `tag` are fixed at `stage.view()`: the tag identifies this persistent hero view,
 * not whichever sample it currently shows.
 */
export function useHero(o: HeroOptions): Crumple {
  const scene = useScene<BuiltStage>()
  const frameTo = scene.status === 'ready' ? scene.meta?.artworkCssPx : undefined

  return useCrumple({
    spriteKey: o.shown.id,
    src: o.shown.src,
    fit: 'contain',
    tag: 'hero',
    duration: o.duration,
    frameTo,
    onSettle: o.onSettle,
    onError(e) {
      if (!e.observed) o.observed('useCrumple', e.error)
    },
  })
}
