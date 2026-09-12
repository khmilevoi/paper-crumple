import type { PlayResult, Run, SwapResult } from '../index.js'

export interface RequestGate {
  readonly signal: AbortSignal
  current(): boolean
  adopt(run: Run<PlayResult | SwapResult>): void
  cancel(): void
  finish(): void
}

export function createRequestGate(isCurrent: () => boolean, signal?: AbortSignal): RequestGate {
  const controller = new AbortController()
  let owned: Run<PlayResult | SwapResult> | null = null
  let finished = false
  const finish = (): void => {
    if (finished) return
    finished = true
    signal?.removeEventListener('abort', cancel)
    owned = null
  }
  const cancel = (): void => {
    if (finished || controller.signal.aborted) return
    // Abort listeners can synchronously finish the gate and release its reference.
    const run = owned
    controller.abort()
    run?.stop()
    finish()
  }
  signal?.addEventListener('abort', cancel, { once: true })
  if (signal?.aborted) cancel()
  return {
    signal: controller.signal,
    current: () => !finished && !controller.signal.aborted && isCurrent(),
    adopt: (run) => {
      if (finished || controller.signal.aborted) {
        run.stop()
        return
      }
      owned = run
      if (controller.signal.aborted || !isCurrent()) cancel()
    },
    cancel,
    finish,
  }
}
