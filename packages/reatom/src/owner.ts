import { abortVar, bind } from '@reatom/core'

/** Owner cancellation ends the native waiter; cancelling a waiter never cancels the owner. */
export function cancelWithOwner(signal: AbortSignal): () => void {
  const operation = abortVar.require()
  const cancel = bind(() => operation.abort())
  signal.addEventListener('abort', cancel, { once: true })
  if (signal.aborted) cancel()
  return () => signal.removeEventListener('abort', cancel)
}
