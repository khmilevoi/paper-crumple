import { isAborted } from './abort.js'
import { type EventBus, logUnobserved } from './emitter.js'
import type { StageEvent } from './events.js'
import type { View } from './forward.js'

/**
 * # §10.6 with amendment 5
 *
 * A `GlError` produced inside a `setTimeout` step has no stack to propagate to and no return
 * value to become. Its only escape is the `error` event; with nothing subscribed it vanishes, and
 * because nothing throws there is no unhandled rejection and no console entry. That is strictly
 * worse than a throwing library, and it is the **motive** of §10.6.
 *
 * But "every error the library returns is also emitted" re-emits the returned ones too, so a
 * consumer following both documented practices — narrowing every return **and** wiring
 * `stage.on('error', toSentry)` — reports every handled error twice, including the 404 the
 * getting-started path gracefully warns about and continues past. `observed` keeps the motive and
 * removes the double count: telemetry filters `!observed`.
 */
export interface ErrorPolicy {
  /**
   * Route a value that is about to be **returned**. An `Error` is emitted with `observed: true`
   * and handed back unchanged; `ABORTED` and every non-Error pass through untouched and are not
   * emitted at all — abort is not a failure (§10.5).
   */
  returned<T>(value: T, view: View | null): T
  /**
   * Route an error with **no caller on the stack** — raised inside a step, a timer or a listener.
   * Emitted with `observed: false`, and the one-time console fallback fires for exactly these.
   */
  orphan(error: Error, view: View | null): void
}

export function createErrorPolicy(o: {
  bus: Pick<EventBus, 'emit' | 'listenerCount'>
  /** Injected so a level-1 test asserts the fallback without writing to the real console. */
  log?: (error: Error) => void
}): ErrorPolicy {
  const log = o.log ?? logUnobserved
  let logged = false

  const emit = (error: Error, view: View | null, observed: boolean): void => {
    const payload: StageEvent<'error'> = { error, observed, view }
    o.bus.emit('error', payload)
    if (observed) return
    // Node's `EventEmitter` convention inverted: Node throws for an unobserved 'error', we log,
    // because throwing here would fire inside a `setTimeout` where nobody can catch it. Only for
    // `observed: false` — an error the caller is about to narrow needs no console entry, and
    // logging it teaches consumers to ignore the console.
    if (logged || o.bus.listenerCount('error') > 0) return
    logged = true
    log(error)
  }

  return {
    returned(value, view) {
      if (isAborted(value)) return value
      if (value instanceof Error) emit(value, view, true)
      return value
    },
    orphan(error, view) {
      emit(error, view, false)
    },
  }
}
