import type { Events, View } from '@paper-crumple/core'
import { bind, reatomObservable, type Frame } from '@reatom/core'

export type Progress = Pick<Events['step'], 'pose' | 'frame' | 'ms'> | null

/** Numeric telemetry is owned by observation, never by the model's lifetime. */
export function createProgress(scope: {
  name: string
  owner: Frame
  assertOwner(): void
  view(): View | null
  subscribeReplacement(listener: () => void): () => void
}) {
  return reatomObservable<Progress>((trigger) => {
    let current: View | null = null
    let sample: Progress = null
    let pose: number | null = null
    return {
      getState: () => {
        scope.assertOwner()
        const next = scope.view()
        return next === current && next?.pose === pose ? sample : null
      },
      subscribe: () => {
        scope.assertOwner()
        let offStep: (() => void) | undefined
        const sync = bind(() => {
          const next = scope.view()
          if (next !== current) {
            offStep?.()
            current = next
            pose = next?.pose ?? null
            sample = null
            offStep = next?.on(
              'step',
              bind((event) => {
                if (scope.view() !== next) return
                pose = next.pose
                sample = { pose: event.pose, frame: event.frame, ms: event.ms }
                trigger()
              }, scope.owner),
            )
            trigger()
          }
        }, scope.owner)
        const offReplacement = scope.subscribeReplacement(sync)
        sync()
        return () => {
          offReplacement()
          offStep?.()
          current = null
          sample = null
          pose = null
        }
      },
    }
  }, scope.name)
}
