/**
 * The shared per-bucket pack: its fetch, its dedupe and its refcount (§5.3, §14).
 *
 * Three rules live here and nowhere else.
 *
 * **The dedupe.** Two overlapping `acquire`s for one bucket share one fetch. Without the
 * `pending` map the second downloads the 539 KB binary again, and whichever loses the race has
 * its resources overwritten with no way left to delete them.
 *
 * **The shared fetch is never cancelled by a per-sprite `signal`.** It is shared by every sprite
 * in that bucket, and cancelling it to save bandwidth on a scroll costs a re-download two tiles
 * later. A signal decides what *this caller* receives, never what the fetch does — which is why
 * no `AbortSignal` is ever passed down to `loadPack`.
 *
 * **Abort returns the sentinel, not an `Error` (§18 amendment 1).** `AbortedError` has left
 * `LoadError`; `ABORTED` is in the return union instead. An aborted caller takes **no** reference,
 * because it receives no clip and will therefore never call `release`.
 *
 * Only success is cached. A failed fetch clears its `pending` entry and is retryable.
 */
import { ABORTED, AssetError } from '@paper-crumple/core'
import type { Aborted, LoadError } from '@paper-crumple/core'

import { loadPack } from './load.js'
import type { Pack } from './pack.js'
import type { PackModule } from './pack-module.js'

export interface PackStoreOptions {
  readonly packs: readonly PackModule[]
  /**
   * Test injection only. Level-1 tests cannot `fetch` a `file://` URL on any current Node (§11),
   * so the bytes are handed in instead. Defaults to the platform `fetch`.
   */
  readonly fetch?: typeof globalThis.fetch
}

export interface PackStore {
  /** Whether a module for this bucket was supplied to the factory. */
  has(bucket: string): boolean
  /** Take one reference. Resolves to an `Error`, to `ABORTED`, or to the shared `Pack`. */
  acquire(bucket: string, o?: { signal?: AbortSignal }): Promise<LoadError | Aborted | Pack>
  /** Drop one reference. At zero the pack is evicted and `onEvict` runs. */
  release(bucket: string): void
  get(bucket: string): Pack | undefined
  refs(bucket: string): number
  /** Runs when a bucket's last reference goes, and once per resident bucket on `dispose`. */
  onEvict(fn: (bucket: string, pack: Pack) => void): void
  dispose(): void
}

export function createPackStore(o: PackStoreOptions): PackStore {
  const modules = new Map<string, PackModule>(o.packs.map((m) => [m.bucket, m]))
  const packs = new Map<string, Pack>()
  const pending = new Map<string, Promise<LoadError | Pack>>()
  const refs = new Map<string, number>()
  const evictors: ((bucket: string, pack: Pack) => void)[] = []
  let disposed = false

  function evict(bucket: string): void {
    const pack = packs.get(bucket)
    packs.delete(bucket)
    refs.delete(bucket)
    if (pack) for (const fn of evictors) fn(bucket, pack)
  }

  function fetchOnce(bucket: string, module: PackModule): Promise<LoadError | Pack> {
    const inFlight = pending.get(bucket)
    if (inFlight) return inFlight
    const promise = loadPack({
      manifest: module.manifest,
      binUrl: module.binUrl,
      ...(o.fetch ? { fetch: o.fetch } : {}),
    })
      .then((result) => {
        // Only success is cached; a failure must stay retryable.
        // Do not resurrect the pack if the store was disposed while the fetch was in flight.
        if (!(result instanceof Error) && !disposed) packs.set(bucket, result)
        return result
      })
      .finally(() => pending.delete(bucket))
    pending.set(bucket, promise)
    return promise
  }

  return {
    has: (bucket) => modules.has(bucket),

    async acquire(bucket, opts) {
      if (disposed) return new AssetError('bakedMotion: acquired after dispose')
      const module = modules.get(bucket)
      if (!module) {
        return new AssetError(
          `bakedMotion: no pack for bucket '${bucket}'. Import it from ` +
            `'@paper-crumple/motion/packs/${bucket}' and pass it to bakedMotion({ packs }).`,
        )
      }
      // A function-call boundary, so TypeScript cannot carry a `false` narrowing from one call
      // to the next across the `await` below — `AbortSignal.aborted` is a mutable property that
      // can flip while the fetch is in flight, which check point two exists to catch.
      const aborted = (): boolean => opts?.signal?.aborted === true

      // Check point one. Nothing is spent on a caller that has already gone away.
      if (aborted()) return ABORTED

      const resident = packs.get(bucket)
      const result = resident ?? (await fetchOnce(bucket, module))
      if (result instanceof Error) return result

      // Check point two. The fetch was never cancelled and the pack stays resident — "stop
      // spending, keep what is already paid for" — but this caller takes no reference, because
      // it receives nothing it could later release.
      if (aborted()) return ABORTED

      // Only take a reference if the pack is actually in the store. If the store was disposed
      // while the fetch was in flight, the pack was not stored, so no reference is needed.
      if (packs.has(bucket)) {
        refs.set(bucket, (refs.get(bucket) ?? 0) + 1)
      }
      return result
    },

    release(bucket) {
      const n = refs.get(bucket)
      if (n === undefined || n === 0) return
      if (n > 1) {
        refs.set(bucket, n - 1)
        return
      }
      evict(bucket)
    },

    get: (bucket) => packs.get(bucket),
    refs: (bucket) => refs.get(bucket) ?? 0,

    onEvict(fn) {
      evictors.push(fn)
    },

    dispose() {
      disposed = true
      for (const bucket of [...packs.keys()]) evict(bucket)
      packs.clear()
      pending.clear()
      refs.clear()
      evictors.length = 0
    },
  }
}
