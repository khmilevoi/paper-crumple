import type { Invalidates, KnobDescriptor, Knobs } from './knobs.js'

/**
 * # §6.3 — the invalidation ladder, and why it is closed
 *
 * ```
 * draw   -> next draw only
 * front  -> rebuild the front texture
 * hull   -> invalidate the hull cache, then front
 * field  -> re-run the SDF / looseness field, then hull, then front
 * ```
 *
 * Four levels and not two, because the caches the design describes need four. §8.5 keys the hull
 * cache on "(sprite key, `sdfRes`, hull knobs)" and nothing in a two-tier descriptor marks a knob
 * as a hull knob, so the key is uncomputable; `engine.js:215` shows the real one; and `edge.js`'s
 * `looseness` re-runs pass B alone, a fourth tier upstream of the hull. With two tiers either
 * those knobs silently fail to invalidate their upstream cache, or every front knob
 * conservatively re-runs pass B and the boundary trace, which turns an advertised ~1 ms rebuild
 * into the full hull path for a knob like `grain`.
 *
 * ## The ladder is closed, and §6.5 is what closes it
 *
 * > A setting is a **knob** if and only if it can change on a live sprite or view without
 * > recreating GPU objects, *and* its full effect is captured by a level of `invalidates`. A
 * > setting that changes the shape of the program, the set of resources, or **the set of other
 * > knobs** is a **factory option**.
 *
 * Anything that would need a fifth level is, by that predicate, a factory option and never enters
 * the registry. `edgeMode` qualifies on the third clause and the clause pays for itself: a `hull`
 * stage exposes 31 knobs instead of 46, with the 13 torn-only knobs absent from autocomplete
 * rather than present and inert. `overscan` (§8.6) is factory-derived under the same rule — it
 * changes the dimensions of the front texture and of both fields, which is the shape of a
 * resource rather than its contents. **Adding a fifth member to `Invalidates` is therefore a
 * design change and not an implementation detail**; the closure is asserted in
 * `invalidation.test-d.ts`.
 */
export const INVALIDATION_ORDER = ['draw', 'front', 'hull', 'field'] as const

export function invalidationRank(level: Invalidates): number {
  return INVALIDATION_ORDER.indexOf(level)
}

/** Whether `level` sits at or above `floor` — the ladder's "implies everything to its left". */
export function atOrAbove(level: Invalidates, floor: Invalidates): boolean {
  return invalidationRank(level) >= invalidationRank(floor)
}

/** The strongest level in a set, or `undefined` for an empty one. */
export function maxInvalidation(levels: Iterable<Invalidates>): Invalidates | undefined {
  let best: Invalidates | undefined
  for (const level of levels) {
    if (best === undefined || invalidationRank(level) > invalidationRank(best)) best = level
  }
  return best
}

/**
 * What a view may set: the draw class alone (§6.6). Front-class knobs live on the sprite, because
 * changing one rebuilds a texture that sprite owns.
 */
export const VIEW_SCOPE: readonly Invalidates[] = ['draw']

/**
 * What a sprite may set: the whole ladder, **including `'draw'`**. §6.6's resolution order —
 * core defaults, slot defaults, sprite, view — says a sprite may carry draw-class values, and
 * amendment 20 settles the section's contradiction in the order's favour: the order is
 * load-bearing machinery the draw path executes and the prose was a summary of it. A draw-class
 * value on a sprite is what makes "this garment is shown slightly darker everywhere" expressible
 * once instead of on every view that shows it.
 */
export const SPRITE_SCOPE: readonly Invalidates[] = INVALIDATION_ORDER

/**
 * §8.5's hull cache key over the knob half of "(sprite key, `sdfRes`, hull knobs)": every knob at
 * or above `'hull'`, sorted by key so descriptor order cannot change it. `sdfRes` is a `'field'`
 * knob and so is included by the ladder rather than by being named.
 *
 * The sheet slot composes this with its own sprite key; §5.2 moved the hull, its cache and its
 * worker inside `source()`, so the slot is the caller and this is exported from `/unstable`.
 */
export function hullCacheKey(descriptors: readonly KnobDescriptor[], values: Knobs): string {
  return descriptors
    .filter((d) => atOrAbove(d.invalidates, 'hull'))
    .map((d) => d.key)
    .sort()
    .map((key) => `${key}=${String(values[key])}`)
    .join('|')
}
