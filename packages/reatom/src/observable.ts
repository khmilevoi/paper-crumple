import type { ChangeArea, ChangeSource } from '@paper-crumple/core'
import { bind, reatomObservable, type Frame } from '@reatom/core'

/** Cache allocating core getters only across unchanged semantic revisions; never eagerly read. */
export function readAtRevision<T, E extends { readonly changes: ChangeSource }>(
  entity: () => E | null,
  area: ChangeArea,
  read: () => T,
): () => T {
  let previous: E | null | undefined
  let revision = -1
  let value: T
  return () => {
    const next = entity()
    const nextRevision = next?.changes.revision(area) ?? 0
    if (next !== previous || nextRevision !== revision) {
      value = read()
      previous = next
      revision = nextRevision
    }
    return value
  }
}

/** A connected bridge owns both its replacement watcher and its current entity listener. */
export function observeExternal<T, E extends { readonly changes: ChangeSource }>(options: {
  name: string
  owner: Frame
  assertOwner(): void
  read(): T
  entity(): E | null
  areas: readonly ChangeArea[]
  subscribeReplacement(trigger: () => void): () => void
}) {
  return reatomObservable<T>(
    (trigger) => ({
      getState: () => {
        options.assertOwner()
        return options.read()
      },
      subscribe: () => {
        options.assertOwner()
        let current: E | null = null
        let entityOff: Array<() => void> = []
        const sync = bind(() => {
          const next = options.entity()
          if (next !== current) {
            entityOff.forEach((off) => off())
            current = next
            entityOff =
              next === null ? [] : options.areas.map((area) => next.changes.subscribe(area, sync))
          }
          trigger()
        }, options.owner)
        const replacementOff = options.subscribeReplacement(sync)
        sync()
        return () => {
          replacementOff()
          entityOff.forEach((off) => off())
        }
      },
    }),
    options.name,
  )
}
