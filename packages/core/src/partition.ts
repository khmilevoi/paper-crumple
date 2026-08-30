import type { Aborted } from './abort.js'

/**
 * Makes an element union carrying `Aborted` unsatisfiable, which is amendment 2 expressed in the
 * type system: **abort is all-or-nothing at the call level**, so a cancelled batch returns the
 * sentinel in place of the whole array and no element union can contain it. `partition`'s input
 * type is sound **only** because of that rule, and this is the one place the dependency is
 * written down.
 *
 * The test is `Extract<T, Aborted>` — "is `Aborted` a *member* of this union" — rather than
 * `[Aborted] extends [T]`. The latter is also true for `T = unknown`, which is not a union
 * carrying the sentinel and which the hostile-input suite passes deliberately.
 *
 * The tuple brackets around `Extract<T, Aborted>` are this repository's idiom for a `never` test.
 * They are inert here — the checked type is an alias instantiation rather than a naked type
 * parameter, so the distribution over `T` has already happened inside `Extract` — but they keep
 * the test non-distributive if the checked expression is ever simplified. The property name is a sentence
 * because it is what a consumer reads in the compiler's error.
 */
export type NoAbortedElement<T> = [Extract<T, Aborted>] extends [never]
  ? unknown
  : {
      readonly 'paper-crumple: a batch aborts whole (§10.5, amendment 2), so an element union may not carry Aborted': never
    }

/**
 * Splits a batch into its successes and its errors, in input order. The caller in this library
 * is `stage.addAll()` over a batch of sprite sources (§4.1).
 *
 * There is no runtime check for the sentinel: amendment 2 forbids it in an element position and
 * the type above refuses it, and a runtime branch would need a third return slot that no caller
 * has a use for.
 */
export function partition<T>(
  values: readonly T[] & NoAbortedElement<T>,
): [Array<Exclude<T, Error>>, Array<Extract<T, Error>>] {
  const ok: Array<Exclude<T, Error>> = []
  const bad: Array<Extract<T, Error>> = []
  for (const value of values as readonly T[]) {
    if (value instanceof Error) bad.push(value as Extract<T, Error>)
    else ok.push(value as Exclude<T, Error>)
  }
  return [ok, bad]
}
