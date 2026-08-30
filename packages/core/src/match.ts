/**
 * The handler table. The `else` member is required by the type (amendment 4), which is how tag
 * dispatch survives §10.2's growth rule by construction rather than by review: the named unions
 * gain members in a minor release, an exhaustive `switch` over `_tag` breaks on that — which
 * §10.2 wants, because a consumer who claimed to handle every case no longer does — but a
 * consumer who only meant to route three tags and log the rest should not have to choose
 * between breaking and a `default` that swallows.
 */
export type MatchHandlers<R> = { [tag: string]: (e: never) => R } & { else: (e: Error) => R }

/**
 * Routes an error by its `_tag`, falling to `else` for anything unrouted — a foreign error, an
 * error with no tag, or a tag the table does not name.
 *
 * Lookup is `Object.hasOwn`, never a bare index, so a `_tag` of `'toString'` or `'constructor'`
 * cannot reach a function through the prototype chain. `'else'` is never treated as a tag.
 */
export function matchError<R>(err: Error, handlers: MatchHandlers<R>): R {
  const tag: unknown =
    typeof err === 'object' && err !== null ? (err as { _tag?: unknown })._tag : undefined
  if (typeof tag === 'string' && tag !== 'else' && Object.hasOwn(handlers, tag)) {
    const handler = handlers[tag]
    if (typeof handler === 'function') {
      return (handler as (e: Error) => R)(err)
    }
  }
  return handlers.else(err)
}
