import { causeChain } from './cause.js'
import { AbortedError } from './errors.js'

/**
 * The cancellation sentinel (§10.5, amendment 1). **The sentinel is a return, the class is a
 * cause.** An operation whose signature accepts a `signal` carries `| Aborted` in its return
 * union unconditionally; an operation that accepts none never mentions it, so the type states
 * whether an operation is cancellable.
 *
 * `Symbol.for`, never a bare `Symbol()`, and the reason is written here so it cannot be tidied
 * into a module-private symbol by someone who reads `unique symbol` as an instruction: a
 * per-copy symbol would recreate §10.4's duplicate-core hazard in its worst form. Copy B's
 * sentinel would fail copy A's `isAborted` **and** fail `instanceof Error`, and would then flow
 * on into code typed as success — on the most routine event in a scrolling grid, which is that
 * the user scrolled. The version marker of §10.4 already lives in
 * `globalThis[Symbol.for('paper-crumple.core')]`; the sentinel uses the same registry for the
 * same reason.
 *
 * **Abort is all-or-nothing at the call level (amendment 2).** An element union inside a batch
 * result never contains `Aborted`; a cancelled batch returns the sentinel in place of the whole
 * array rather than inside it. `partition`'s input type depends on this and on nothing else.
 *
 * A returned `ABORTED` is never emitted on the `error` event (§10.6): cancellation is not a
 * failure, and telemetry that counted scroll-cancelled prepares would report a working grid as
 * a broken one.
 */
export const ABORTED: unique symbol = Symbol.for('paper-crumple.aborted')

/** The type of the cancellation sentinel. */
export type Aborted = typeof ABORTED

/**
 * `DOMException` is not an `Error` subclass in a browser, so this is name-based rather than
 * `instanceof`-based. `AbortController` produces exactly this shape.
 */
function isDomAbortError(x: unknown): boolean {
  return typeof x === 'object' && x !== null && (x as { name?: unknown }).name === 'AbortError'
}

/**
 * Specified over exactly four shapes, and this list is normative (§10.5):
 *
 * - `x === ABORTED`
 * - `x instanceof AbortedError` — tested through `AbortedError.is`, which also answers `true`
 *   for an `AbortedError` from a second copy of core, where `instanceof` would not
 * - an `AbortedError` or a `DOMException` named `AbortError` anywhere in the `cause` chain
 * - `cause: ABORTED` — legal since ES2022, and cheap to miss
 *
 * The predicate narrows to `Aborted` even for the two chain shapes, which are `Error`s. That is
 * deliberate: it is what makes the documented consumer pattern narrow, and a wrapping error that
 * *is* abort-caused is one the caller wanted to drop.
 *
 * ```ts
 * const a = await stage.add(url, { key, signal })
 * if (isAborted(a)) return
 * if (a instanceof Error) return a
 * ```
 */
export function isAborted(x: unknown): x is Aborted {
  if (x === ABORTED) return true
  for (const link of causeChain(x)) {
    if (link === ABORTED) return true
    if (AbortedError.is(link)) return true
    if (isDomAbortError(link)) return true
  }
  return false
}

/**
 * `promise`'s value, or `ABORTED` the moment `signal` fires — whichever comes first (§5.2
 * amendment, P7; §10.5's check point "after a program-readiness wait").
 *
 * A slot's asynchronous path waits on a shared promise it does not own — a program link that
 * every caller of the context shares, a fetch another caller started — and a cancelled caller
 * must leave that promise alone and leave *now*: a superseded swap that sat out a 2–3 s cold
 * D3D11 compile would hold the ingest lane's one slot for the whole of it. So the listener is
 * `once` and is removed when the wait ends normally, the promise is never touched, and the
 * result is the promise's value or the sentinel. `promise` must never reject (§10.8: a promise
 * that fails resolves to an Error), so the fulfilment handler is the only one there is. No
 * `signal`: the promise as it is. Already aborted: the sentinel, without subscribing.
 */
export function raceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T | Aborted> {
  if (signal === undefined) return promise
  if (signal.aborted) return Promise.resolve(ABORTED)
  return new Promise<T | Aborted>((resolve) => {
    const onAbort = (): void => resolve(ABORTED)
    signal.addEventListener('abort', onAbort, { once: true })
    void promise.then((value) => {
      signal.removeEventListener('abort', onAbort)
      resolve(value)
    })
  })
}
