import type { Aborted, StageCommon, StageEvent } from '../index.js'

export type BindingStage = Pick<StageCommon, 'changes' | 'disposed' | 'lost' | 'on' | 'dispose'>
export type SceneFactory<S extends BindingStage> = (
  signal: AbortSignal,
  onError: (event: StageEvent<'error'>) => void,
) => Promise<S | Error | Aborted>

export type SceneControllerStatus = 'idle' | 'building' | 'ready' | 'failed' | 'disposed'

/** One factory lifetime. Rebuilding requires a new controller, including after raw disposal. */
export interface SceneController<S extends BindingStage> {
  readonly signal: AbortSignal
  readonly status: SceneControllerStatus
  /** Live stages only; cleared synchronously by the raw lifecycle notification. */
  readonly stage: S | null
  readonly error: Error | null
  readonly lost: boolean
  ensure(): Promise<S | Error | Aborted>
  subscribe(listener: () => void): () => void
  /** Factory pre-mount errors and raw stage error events, without double forwarding. */
  onError(listener: (event: StageEvent<'error'>) => void): () => void
  dispose(): void
}
