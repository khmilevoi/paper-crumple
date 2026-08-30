/**
 * The front LRU (spec 8.5.1, 8.8).
 *
 * **The byte budget governs exactly one per-sprite tier: fronts.** Handle metadata and the hull
 * cache are unbudgeted and never evicted; the pools are whole-stage and do not scale with sprite
 * count. One tier and not two, because a byte spent on a front strictly dominates a byte spent on
 * a retained artwork: a resident front is drawable at zero cost, a resident artwork still costs a
 * `build()` and is only 1.39x smaller.
 *
 * This module is deliberately not exported from either barrel. P9 owns the public shape -
 * `budget()`, `usage()` and `pin()` - and wraps this.
 */

export interface FrontLruEntry {
  readonly key: string
  /** `frontBytes(size)` for this sprite's front. */
  readonly bytes: number
  /**
   * True when a supplier exists, so eviction is recoverable by `stage.prepare(key)`. False for a
   * bare bitmap added with `pin: true`, which the library was forbidden to free.
   */
  readonly reclaimable: boolean
}

/** The front-tier half of spec 8.8's `usage()`. P9 adds the handle tier and the pools. */
export interface FrontLruUsage {
  /** Front bytes only. */
  readonly bytes: number
  /** Front bytes backed by a supplier. */
  readonly reclaimable: number
  /** Front bytes with no supplier, which the budget cannot bound. */
  readonly unreclaimable: number
  readonly fronts: number
  readonly pinned: number
  readonly attached: number
}

export interface FrontLruOptions {
  /** The byte budget. */
  readonly bytes: number
  /** Called exactly once per front the LRU drops, by eviction, `remove` or `clear`. */
  readonly release: (key: string) => void
}

export interface FrontLru {
  /** Insert or replace, then evict down to the budget. The inserted entry becomes MRU. */
  insert(entry: FrontLruEntry): void
  has(key: string): boolean
  /** Make `key` the most recently used. A no-op for a key the LRU does not hold. */
  touch(key: string): void
  /** Drop `key` and release its front. A no-op for a key the LRU does not hold. */
  remove(key: string): void
  attach(key: string): void
  detach(key: string): void
  pin(key: string): void
  unpin(key: string): void
  /** Hold `key` as the pending target of a live `crumpleTo`. */
  hold(key: string): void
  releaseHold(key: string): void
  /** Raise or lower the budget, then evict down to it. */
  setBudget(bytes: number): void
  usage(): FrontLruUsage
  /** Most recently used first. */
  keys(): readonly string[]
  /** Release every front and empty the LRU. */
  clear(): void
}

interface Slot {
  bytes: number
  reclaimable: boolean
  attachCount: number
  pinned: boolean
  held: boolean
}

export function createFrontLru(o: FrontLruOptions): FrontLru {
  // A Map preserves insertion order, so re-inserting a key is the whole of `touch`. The last key
  // in iteration order is the most recently used; the first is the eviction candidate.
  const slots = new Map<string, Slot>()
  let budget = o.bytes
  let total = 0

  const evictable = (slot: Slot): boolean =>
    slot.reclaimable && slot.attachCount === 0 && !slot.pinned && !slot.held

  function evict(): void {
    // Never evict the most recently used entry: it is the one the caller just asked for, and a
    // budget smaller than a single front must overshoot rather than throw the work away. The
    // Map's iteration order is recency order, so the MRU is the last key - it is excluded from
    // victim selection outright, which also covers the case where it is the only entry left.
    while (total > budget && slots.size > 0) {
      let mru: string | undefined
      for (const key of slots.keys()) mru = key
      let victim: string | undefined
      for (const [key, slot] of slots) {
        if (key === mru) continue
        if (evictable(slot)) {
          victim = key
          break
        }
      }
      if (victim === undefined) return
      const slot = slots.get(victim)
      if (slot === undefined) return
      total -= slot.bytes
      slots.delete(victim)
      o.release(victim)
    }
  }

  function withSlot(key: string, fn: (slot: Slot) => void): void {
    const slot = slots.get(key)
    if (slot === undefined) return
    fn(slot)
  }

  function moveToEnd(key: string, slot: Slot): void {
    slots.delete(key)
    slots.set(key, slot)
  }

  return {
    insert(entry) {
      const existing = slots.get(entry.key)
      if (existing !== undefined) {
        total -= existing.bytes
        existing.bytes = entry.bytes
        existing.reclaimable = entry.reclaimable
        total += entry.bytes
        moveToEnd(entry.key, existing)
      } else {
        slots.set(entry.key, {
          bytes: entry.bytes,
          reclaimable: entry.reclaimable,
          attachCount: 0,
          pinned: false,
          held: false,
        })
        total += entry.bytes
      }
      evict()
    },

    has(key) {
      return slots.has(key)
    },

    touch(key) {
      withSlot(key, (slot) => moveToEnd(key, slot))
    },

    remove(key) {
      const slot = slots.get(key)
      if (slot === undefined) return
      total -= slot.bytes
      slots.delete(key)
      o.release(key)
    },

    attach(key) {
      withSlot(key, (slot) => {
        slot.attachCount += 1
        moveToEnd(key, slot)
      })
    },

    detach(key) {
      withSlot(key, (slot) => {
        slot.attachCount = Math.max(0, slot.attachCount - 1)
      })
    },

    pin(key) {
      withSlot(key, (slot) => {
        slot.pinned = true
      })
    },

    unpin(key) {
      withSlot(key, (slot) => {
        slot.pinned = false
      })
    },

    hold(key) {
      withSlot(key, (slot) => {
        slot.held = true
      })
    },

    releaseHold(key) {
      withSlot(key, (slot) => {
        slot.held = false
      })
    },

    setBudget(bytes) {
      budget = bytes
      evict()
    },

    usage() {
      let reclaimable = 0
      let unreclaimable = 0
      let pinned = 0
      let attached = 0
      for (const slot of slots.values()) {
        if (slot.reclaimable) reclaimable += slot.bytes
        else unreclaimable += slot.bytes
        if (slot.pinned) pinned += 1
        if (slot.attachCount > 0) attached += 1
      }
      return { bytes: total, reclaimable, unreclaimable, fronts: slots.size, pinned, attached }
    },

    keys() {
      return [...slots.keys()].reverse()
    },

    clear() {
      const all = [...slots.keys()]
      slots.clear()
      total = 0
      for (const key of all) o.release(key)
    },
  }
}
