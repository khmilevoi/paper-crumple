import type { Aborted, BlitStage, DirectStage, HostedStage, StageEvent } from '../index.js'

export type BindingStage = BlitStage | DirectStage | HostedStage
export type SceneFactory<S extends BindingStage = BlitStage> = (
  signal: AbortSignal,
  onError: (event: StageEvent<'error'>) => void,
) => Promise<S | Error | Aborted>

export type SceneControllerStatus = 'idle' | 'building' | 'ready' | 'failed' | 'disposed'

/** One factory lifetime. Rebuilding requires a new controller, including after raw disposal. */
export interface SceneController<S extends BindingStage = BlitStage> {
  readonly signal: AbortSignal
  readonly status: SceneControllerStatus
  readonly disposed: boolean
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
