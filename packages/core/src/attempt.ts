/**
 * errore's `try`, taken under this name because `try` is a reserved word. §10.8's synchronous
 * boundaries go through it: `compile()`, `createTarget()`, `new Float32Array(buffer, offset,
 * len)` on a bad or detached buffer, `JSON.parse` of a manifest, `texStorage2D` and any
 * allocation that can fail on GPU OOM. Above the boundary nothing throws.
 *
 * This file contains no `throw` of its own — it only catches — so it is not on the boundary
 * allowlist.
 */
export function attempt<T>(fn: () => T): T | Error
export function attempt<T, E extends Error>(fn: () => T, wrap: (cause: unknown) => E): T | E
export function attempt<T, E extends Error>(
  fn: () => T,
  wrap?: (cause: unknown) => E,
): T | E | Error {
  try {
    return fn()
  } catch (cause) {
    if (wrap !== undefined) return wrap(cause)
    if (cause instanceof Error) return cause
    return new Error(String(cause), { cause })
  }
}
