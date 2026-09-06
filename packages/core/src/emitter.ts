import type { EventName, Events } from './events.js'
import { unwrap } from './unwrap.js'

/**
 * # The event bus (§7.1)
 *
 * Everything §7.1 says about subscription and emission, and nothing about runs. A run's ordering
 * rules are `runner.ts`'s; this file only guarantees that an emit visits its listeners in
 * registration order, that one listener's exception cannot silence the next, and that the
 * `relay` runs synchronously after the last listener returns — which is how a view's bus hands
 * each event on to the stage's.
 *
 * There is no deferral here. A call made from inside a handler runs synchronously, like a call
 * made from anywhere else; what keeps it from recursing without bound is the runner's own
 * ordering — `current` is nulled before `end` is emitted, and a run a handler tries to install
 * from inside a supersession is refused — not a queue in front of the listeners.
 *
 * **Subscribing cannot fail, so `on` is not an `Error | T`.** §7.1 states this so it is not
 * "corrected" into a union during implementation; the type test asserts it.
 */

/**
 * Any payload map the bus accepts. Constrained to widenings of `Events` so that the `error`
 * member always carries `observed`, which is what lets §10.6's fallback read the flag without a
 * cast. The two instantiations that exist are `Events` (a view's bus) and
 * `{ [E in EventName]: StageEvent<E> }` (the stage's, which adds `view`).
 */
export type EventPayloads = { [E in EventName]: Events[E] }

export type Listener<T> = (e: T) => void

export interface EventBusOptions<M extends EventPayloads = Events> {
  /**
   * Called after the last listener of an emit returns, still **inside** that emit — §7.1: "a
   * view's own listeners run first, in registration order; the stage re-emits synchronously
   * after the last returns". The stage passes its re-emission here for every view's bus.
   *
   * An option rather than a listener, and that is the whole point of it: `emit` knows only
   * registration order, so a listener the stage registered when it built the view would run
   * *before* every listener the consumer registers afterwards — the reverse of what §7.1
   * promises. Running inside the emit also puts a throwing relay on the same `rethrow` path as a
   * throwing listener, rather than letting it escape the emit.
   */
  relay?: <E extends EventName>(event: E, payload: M[E]) => void
  /**
   * §10.6's fallback. Called **at most once per bus**, for the first `error` emitted with
   * `observed: false` while no `error` listener is attached. Absent means silent.
   *
   * Once, and not once per error: a hundred-view grid dropping one frame each would otherwise
   * print a hundred console entries a second, which teaches consumers to ignore the console —
   * the failure §10.6 is trying to prevent. The stage passes `logUnobserved`; a view's bus passes
   * nothing, because §10.6 says *the stage* logs.
   *
   * It never fires for `observed: true`: an error the caller is about to narrow needs no console
   * entry. A returned `ABORTED` is not an error and never reaches this bus at all (§10.5).
   */
  onUnobserved?: (error: Error) => void
  /**
   * How a listener's exception escapes. Defaults to `rethrowFromMicrotask`.
   *
   * Injectable because the default's entire purpose is to become an uncaught exception, and an
   * uncaught exception is what a test runner reports as a failure of whatever provoked it. A test
   * that wants to assert "the next listener still ran" needs the exception captured rather than
   * escaping; a test that wants to assert the default's behaviour stubs `queueMicrotask` instead.
   */
  rethrow?: (thrown: unknown) => void
}

export interface EventBus<M extends EventPayloads = Events> {
  on<E extends EventName>(event: E, fn: Listener<M[E]>): () => void
  once<E extends EventName>(event: E, fn: Listener<M[E]>): () => void
  emit<E extends EventName>(event: E, payload: M[E]): void
  listenerCount(event: EventName): number
  /** Drops every listener. */
  clear(): void
}

type AnyListener = (e: never) => void

interface Entry {
  readonly fn: AnyListener
  removed: boolean
}

/**
 * The default `rethrow`. §7.1: "the exception is caught, the next listener runs, and the
 * exception is re-thrown from a microtask" — so it reaches `window.onerror` or Node's
 * `uncaughtException` with its own stack, where a `Promise.reject` would have reached the
 * unrelated `unhandledrejection` channel instead.
 *
 * It throws through P2's `unwrap`, which is the package's only file on the ESLint boundary
 * allowlist. That is deliberate rather than a workaround: adding a second file to
 * `eslint.boundaries.js` means two plans editing one array that sync 2 does not treat as an
 * append-only surface.
 */
export function rethrowFromMicrotask(thrown: unknown): void {
  const error =
    thrown instanceof Error
      ? thrown
      : new Error('a paper-crumple event listener threw a non-Error value', { cause: thrown })
  queueMicrotask(() => {
    unwrap(error)
  })
}

/**
 * The stage's `onUnobserved` (§10.6). Named rather than inlined at P9's call site so the message
 * — including the instruction that turns it off — lives beside the rule it implements.
 */
export function logUnobserved(error: Error): void {
  console.error(
    "paper-crumple: an unobserved error was emitted with no listener attached. Subscribe with stage.on('error', …) to receive these; only unobserved errors are logged, and only the first one.",
    error,
  )
}

export function createEventBus<M extends EventPayloads = Events>(
  options: EventBusOptions<M> = {},
): EventBus<M> {
  const rethrow = options.rethrow ?? rethrowFromMicrotask
  const listeners = new Map<EventName, Entry[]>()
  let unobservedFired = false

  function on<E extends EventName>(event: E, fn: Listener<M[E]>): () => void {
    const entry: Entry = { fn: fn as AnyListener, removed: false }
    const bucket = listeners.get(event)
    if (bucket === undefined) listeners.set(event, [entry])
    else bucket.push(entry)
    return () => {
      if (entry.removed) return
      entry.removed = true
      const current = listeners.get(event)
      if (current === undefined) return
      const at = current.indexOf(entry)
      if (at !== -1) current.splice(at, 1)
    }
  }

  function once<E extends EventName>(event: E, fn: Listener<M[E]>): () => void {
    const off = on(event, ((e: M[E]) => {
      off()
      fn(e)
    }) as Listener<M[E]>)
    return off
  }

  function emit<E extends EventName>(event: E, payload: M[E]): void {
    const bucket = listeners.get(event)
    // A snapshot, so a listener added during this emit does not receive it. `removed` is
    // consulted per entry so a listener unsubscribed during this emit does not receive it
    // either — the two halves together are what make `off()` inside a handler mean what it
    // reads as.
    const snapshot = bucket === undefined ? [] : bucket.slice()
    for (const entry of snapshot) {
      if (entry.removed) continue
      const listener = entry.fn as Listener<M[E]>
      try {
        listener(payload)
      } catch (thrown) {
        rethrow(thrown)
      }
    }
    if (options.relay !== undefined) {
      try {
        options.relay(event, payload)
      } catch (thrown) {
        rethrow(thrown)
      }
    }
    if (event === 'error' && snapshot.length === 0 && !unobservedFired) {
      const e = payload as Events['error']
      if (!e.observed && options.onUnobserved !== undefined) {
        unobservedFired = true
        options.onUnobserved(e.error)
      }
    }
  }

  return {
    on,
    once,
    emit,
    listenerCount: (event) => listeners.get(event)?.length ?? 0,
    clear() {
      listeners.clear()
    },
  }
}
