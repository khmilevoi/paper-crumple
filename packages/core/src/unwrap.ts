import { ABORTED, type Aborted } from './abort.js'
import { AbortedError } from './errors.js'

/**
 * **This is the only file in `@paper-crumple/core` permitted to throw**, and it is named in
 * `eslint.boundaries.js` for that reason.
 *
 * `unwrap` is a consumer-side conversion and not an operation of the library, so §10.8's "one
 * operation either returns errors or throws — never both" is intact: no signature in this
 * package returns something a consumer has to unwrap.
 *
 * It throws an `AbortedError` on the sentinel rather than the sentinel itself: a thrown symbol
 * answers no `instanceof`, carries no stack and reads as nothing in a console — "the sentinel is
 * a return, the class is a cause" (§10.5) applied to the one place where an abort has to become
 * a throw. The test is `v === ABORTED` exactly, not `isAborted(v)`: an error that merely *has*
 * an abort in its cause chain is still that error, and throwing it is what preserves its stack.
 */
export function unwrap<T>(v: T): Exclude<T, Error | Aborted> {
  if (v === ABORTED) {
    throw new AbortedError({ message: 'the operation was aborted', cause: ABORTED })
  }
  if (v instanceof Error) {
    throw v
  }
  return v as Exclude<T, Error | Aborted>
}

/**
 * The asynchronous form. A promise that fails **resolves to an Error rather than rejecting**
 * (§10.8), so the resolved value is what is inspected; a genuine rejection is passed through
 * untouched, because it did not come from this library.
 */
export function unwrapAsync<T>(p: PromiseLike<T>): Promise<Exclude<T, Error | Aborted>> {
  return Promise.resolve(p).then((v) => unwrap(v))
}
