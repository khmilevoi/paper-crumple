/**
 * §8.4 — batching by the opaque `sortKey`.
 *
 * `sortKey` is how the core batches **without knowing what a bucket is**: it sorts draws by an
 * equality key it cannot interpret, and the slot decides what makes two draws cheap to schedule
 * adjacently. That is what lets a third-party source with four variants, or a different attribute
 * layout, be batched at all — so this function groups by equality and never orders by value.
 *
 * **The original's number was wrong and is corrected here.** It claimed sorting turns "up to 100
 * program/VAO switches into 3". Sprites in one bucket at different poses need different VAOs, and
 * steps are event-driven and naturally scattered, so sorting yields **up to 36 VAO binds and
 * exactly one program bind** — there is one sheet program, not one per bucket. Per-view uniforms
 * and the front-texture bind change on every draw regardless.
 */
export function batchBySortKey<T>(items: readonly T[], sortKey: (item: T) => string): readonly T[] {
  if (items.length < 2) return items
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const k = sortKey(item)
    const bucket = groups.get(k)
    if (bucket === undefined) groups.set(k, [item])
    else bucket.push(item)
  }
  // Map iteration is first-insertion order, so groups appear in the order the caller first met
  // them and every group is internally stable. Registration order survives batching.
  const out: T[] = []
  for (const bucket of groups.values()) out.push(...bucket)
  return out
}
