import type { Aborted, Run } from '@paper-crumple/core'
import { abortVar, action, type Action, type AsyncDataExt, withAsyncData, wrap } from '@reatom/core'
import { toAsyncValue } from './result.js'

type Completion<R> = Readonly<
  Pick<
    AsyncDataExt<[], R, R | null, R | null, Error | undefined>,
    'data' | 'error' | 'pending' | 'ready'
  > & { readonly done: Promise<R> }
>

type ReatomRun<R> = Readonly<{
  raw: Run<R | Error | Aborted>
  stop: Action<[], void>
  completion: Completion<R>
}>

/** Add native Reatom completion state to an already-started core Run. */
export function reatomRun<R>(run: Run<R | Error | Aborted>, name: string): ReatomRun<R> {
  const trackCompletion = action(async () => {
    const signal = abortVar.require().signal
    const stopOnAbort = () => run.stop()
    signal.addEventListener('abort', stopOnAbort, { once: true })
    if (signal.aborted) stopOnAbort()
    try {
      return toAsyncValue<R>(await wrap(run.done))
    } finally {
      signal.removeEventListener('abort', stopOnAbort)
    }
  }, `${name}.completion`).extend(withAsyncData({ initState: null as R | null }))
  const stop = action(() => run.stop(), `${name}.stop`)
  const done = trackCompletion()
  void done.catch(() => {})

  const completion = Object.freeze({
    done,
    data: trackCompletion.data,
    error: trackCompletion.error,
    pending: trackCompletion.pending,
    ready: trackCompletion.ready,
  })

  return { raw: run, stop, completion }
}

export type RunModel<R> = ReturnType<typeof reatomRun<R>>
