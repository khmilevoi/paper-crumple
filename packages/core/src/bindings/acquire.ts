import { ABORTED, SheetError } from '../index.js'
import type { Aborted, AddError, Sprite, SpriteSource, StageCommon } from '../index.js'

export type AcquisitionStage = Pick<
  StageCommon,
  'changes' | 'disposed' | 'lost' | 'get' | 'prepare' | 'add'
>
export type Acquisition = Promise<Sprite | AddError | Aborted>
export interface Acquisitions {
  readonly signal: AbortSignal
  pending(key: string): Acquisition | undefined
  acquire(key: string, source: SpriteSource, pin?: true, signal?: AbortSignal): Acquisition
}

const registry = new WeakMap<AcquisitionStage, Acquisitions>()

/** The registry belongs to the raw stage, never to the first adapter or view that uses it. */
export function createAcquisitions(stage: AcquisitionStage): Acquisitions {
  const found = registry.get(stage)
  if (found !== undefined) return found
  const controller = new AbortController()
  const inFlight = new Map<string, Acquisition>()
  let off = (): void => {}
  const invalidate = (): void => {
    if (!stage.disposed && !stage.lost) return
    controller.abort()
    inFlight.clear()
    off()
  }
  off = stage.changes.subscribe('lifecycle', invalidate)
  invalidate()
  const acquisitions: Acquisitions = {
    signal: controller.signal,
    pending: (key) => inFlight.get(key),
    async acquire(key, source, pin, signal) {
      if (controller.signal.aborted || signal?.aborted) return ABORTED
      let shared = inFlight.get(key)
      if (shared === undefined) {
        const started =
          stage.get(key) !== undefined
            ? stage.prepare(key, { signal: controller.signal })
            : stage.add(source, { key, signal: controller.signal, ...(pin && { pin }) })
        inFlight.set(key, started)
        const release = (): void => {
          if (inFlight.get(key) === started) inFlight.delete(key)
        }
        // Handle both settlements without creating an unobserved rejecting finally promise.
        void started.then(release, release)
        shared = started
      }
      let got = await shared
      if (
        got instanceof SheetError &&
        got.message.startsWith(`add() was called with the live key '${key}'`)
      ) {
        // Preserve React's existing one-shot workaround. A raw reserved add is NOT joinable;
        // if prepare cannot see it yet, keep the original refusal instead of its symptom.
        const prepared = await stage.prepare(key, { signal: controller.signal })
        if (!(
          prepared instanceof SheetError &&
          prepared.message.startsWith(`prepare('${key}') has no sprite under that key`)
        )) {
          got = prepared
        }
      }
      return signal?.aborted || controller.signal.aborted ? ABORTED : got
    },
  }
  registry.set(stage, acquisitions)
  return acquisitions
}
