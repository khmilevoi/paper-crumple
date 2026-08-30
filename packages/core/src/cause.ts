import type { ErrorGuard } from './errors.js'

/**
 * A cause chain is consumer data. It can be cyclic, and it can be arbitrarily long, so the
 * walk is iterative, remembers what it has seen and stops at a fixed depth. Both guards are
 * cheap and both have to be here: a `Set` alone does not bound a chain that is long without
 * repeating, and a depth cap alone does not bound a two-node cycle.
 */
const MAX_CAUSE_DEPTH = 64

/** Every link of `x`'s cause chain, `x` first, at most `MAX_CAUSE_DEPTH` of them. */
export function* causeChain(x: unknown): Generator<unknown, void, void> {
  const seen = new Set<unknown>()
  let current = x
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== 'object' || current === null) {
      if (current !== undefined) yield current
      return
    }
    if (seen.has(current)) return
    seen.add(current)
    yield current
    if (!('cause' in current)) return
    current = (current as { cause?: unknown }).cause
    if (current === undefined) return
  }
}

/**
 * Reaches an error of a given class anywhere in a cause chain — the documented motive is a
 * consumer needing the `GlError` underneath a `PackError` (§10). The guard is any class this
 * package exports: `findCause(err, GlError)`.
 */
export function findCause<E>(x: unknown, guard: ErrorGuard<E>): E | undefined {
  for (const link of causeChain(x)) {
    if (guard.is(link)) return link
  }
  return undefined
}
