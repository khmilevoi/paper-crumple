import { ABORTED, GlError } from '../index.js'
import type { Aborted, StageEvent } from '../index.js'
import { rethrowFromMicrotask } from '../emitter.js'
import type { BindingStage, SceneController, SceneControllerStatus, SceneFactory } from './types.js'

export function createSceneController<S extends BindingStage>(
  create: SceneFactory<S>,
): SceneController<S> {
  const controller = new AbortController()
  const listeners = new Set<() => void>()
  const errors = new Set<(event: StageEvent<'error'>) => void>()
  let status: SceneControllerStatus = 'idle'
  let owned: S | null = null
  let live: S | null = null
  let error: Error | null = null
  let lossCause: Error | null = null
  let lost = false
  let resolved = false
  let pending: Promise<S | Error | Aborted> | null = null
  const offs: Array<() => void> = []

  const publish = (): void => {
    for (const listener of [...listeners]) {
      if (!listeners.has(listener)) continue
      try {
        listener()
      } catch (cause) {
        rethrowFromMicrotask(cause)
      }
    }
  }
  const dispatch = (event: StageEvent<'error'>): void => {
    for (const listener of [...errors]) {
      if (!errors.has(listener)) continue
      try {
        listener(event)
      } catch (cause) {
        rethrowFromMicrotask(cause)
      }
    }
  }
  const release = (): void => {
    while (offs.length > 0) offs.pop()?.()
  }
  const dispose = (): void => {
    if (status === 'disposed') return
    status = 'disposed'
    live = null
    const stage = owned
    owned = null
    release()
    controller.abort()
    stage?.dispose()
    publish()
    listeners.clear()
    errors.clear()
  }
  const invalidate = (cause?: Error): void => {
    if (owned?.disposed) {
      dispose()
      return
    }
    if (!owned?.lost) return
    // Lifecycle notification can precede the loss error; replace its fallback once only.
    lossCause ??= cause ?? null
    const next =
      lossCause ??
      error ??
      new GlError('the WebGL2 context was lost; dispose this stage and build a new one')
    const changed = status !== 'failed' || error !== next
    status = 'failed'
    lost = true
    live = null
    error = next
    controller.abort()
    if (changed) publish()
  }
  const preMount = (event: StageEvent<'error'>): void => {
    if (!resolved && !controller.signal.aborted) dispatch(event)
  }

  const ensure = (): Promise<S | Error | Aborted> => {
    if (pending !== null) return pending
    if (status === 'disposed') return Promise.resolve(ABORTED)
    if (status === 'failed') return Promise.resolve(error ?? ABORTED)
    if (live !== null) return Promise.resolve(live)
    status = 'building'
    // Install the promise before publishing: a synchronous subscriber can call ensure again.
    pending = Promise.resolve()
      .then(async (): Promise<S | Error | Aborted> => {
        let built: S | Error | Aborted
        try {
          built = await create(controller.signal, preMount)
        } catch (cause) {
          built = cause instanceof Error ? cause : new Error(String(cause))
        }
        resolved = true
        if (controller.signal.aborted) {
          if (built !== ABORTED && !(built instanceof Error)) built.dispose()
          return ABORTED
        }
        if (built === ABORTED) {
          dispose()
          return ABORTED
        }
        if (built instanceof Error) {
          status = 'failed'
          error = built
          publish()
          return built
        }
        owned = built
        if (built.disposed) {
          dispose()
          return ABORTED
        }
        offs.push(built.changes.subscribe('lifecycle', () => invalidate()))
        offs.push(
          built.on('error', (event) => {
            invalidate(built.lost ? event.error : undefined)
            dispatch(event)
          }),
        )
        if (built.lost) {
          invalidate()
          return error ?? ABORTED
        }
        live = built
        status = 'ready'
        publish()
        // Read again after user listeners: readiness can synchronously dispose the raw stage.
        return live ?? error ?? ABORTED
      })
      .finally(() => {
        pending = null
      })
    publish()
    return pending
  }
  return {
    signal: controller.signal,
    get status() {
      return status
    },
    get disposed() {
      return status === 'disposed'
    },
    get stage() {
      return live
    },
    get error() {
      return error
    },
    get lost() {
      return lost
    },
    ensure,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    onError: (listener) => {
      errors.add(listener)
      return () => {
        errors.delete(listener)
      }
    },
    dispose,
  }
}
