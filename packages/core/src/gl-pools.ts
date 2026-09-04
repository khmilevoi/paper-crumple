/**
 * §8.1's two scratch pools.
 *
 * **There are two and not one because they have different sizing laws.** Pool A is sized by
 * `maxSize` and is resident for everything after the resample; Pool B is sized by the *source*
 * and is live only across the resample, the first pass of a build. Folding them together would
 * re-import the exact failure `maxSize` exists to delete: one 4000 px asset in a wardrobe would
 * permanently size the stage's scratch to tens of megabytes. Their lifetimes are disjoint too, so
 * a shared pool would pay the union where the maximum would do.
 *
 * **Which textures spend Pool A's budget is not this module's** — the JFA ping-pong, the fields,
 * the hull mask, the hull field and the hull canvas belong to P8 and P10. Slots are opaque
 * strings here; what this module owns is that their total never passes `poolABytes`.
 *
 * **Two kinds of slot.** An *exclusive* slot (`acquire`, `holdArtwork`) holds one texture and
 * reallocates whenever its description changes — right for the artwork, which has one size per
 * sprite, and for scratch that is sized once. A *size-keyed* slot (`acquireSized`) keeps every
 * description it has been asked for resident, so a caller that alternates between two framings
 * finds both waiting instead of reallocating each on every call; residency is bounded by the
 * same §8.1 budget through least-recently-used eviction. The thrash this exists to end: every
 * `stage.add` builds its field twice at two framings (`source()`'s reserve-sized front, then
 * `build()`'s bucket-sized one), and an exclusive slot reallocated seven textures and seven
 * framebuffers on every flip, forever.
 *
 * `exact: true` allocates a **dedicated, non-pooled** set straight from `ctx.texture` and releases
 * it synchronously at the end of the build. It must never grow either pool, or one tap on a
 * thumbnail permanently sizes the stage's scratch to ~39 MB and §8.9's grid budget stops being
 * true. The budget check below is what makes that structural rather than a rule in prose.
 */
import { poolABytes, poolBBytes } from './bytes.js'
import { GlError } from './errors.js'
import type { Size } from './geometry.js'
import type { GlContext } from './gl.js'
import { INTEGER_FORMATS, type Target, type Texture, type TextureDesc } from './gl-resources.js'
import { systemTimers, type TimerHandle, type Timers } from './stepper.js'

/**
 * How long a staging texture survives after the artwork slot stopped holding its sprite.
 *
 * §8.1 requires only that this be "at least as long as the artwork slot's retention, or every
 * re-source falls through to a re-load", and the artwork slot's retention is not a duration —
 * it is occupancy, and it ends when another sprite takes the slot. So the invariant is enforced
 * by construction rather than by comparing two numbers: `releaseIdle` does not arm the timer
 * while Pool A still holds the same key, and Pool A arms it on the way out when it displaces one.
 *
 * The number therefore governs only what happens *after* the sprite lost the artwork slot. Ten
 * seconds is far longer than any authored sequence — a six-pose run is 585 ms (§7.2) — and short
 * enough that 3.8 MB of staging does not sit resident for a session.
 */
export const POOL_B_IDLE_MS = 10_000

type Err = InstanceType<typeof GlError>

/**
 * The two halves of `GlContext` a pool needs: `texture` for every slot, and `target` for the
 * slots whose framebuffer the pool owns with the texture (`acquireSized`, `acquireSourceBytes`).
 * Everything else about the context is irrelevant here.
 */
export type TextureFactory = Pick<GlContext, 'texture' | 'target'>

/** Pool A — artwork, JFA ping-pong, fields, hull mask, hull field, hull canvas. */
export interface ArtworkPool {
  /** `poolABytes(artwork, sdfRes)` — §8.1's figure, read from P5 and never restated. */
  readonly budget: number
  /** Live bytes across every slot, exclusive and size-keyed. */
  bytes(): number
  /**
   * Take, or reuse, the exclusive slot named `slot`. Reuses the existing texture when `d`
   * describes the same thing; reallocates and re-prices it otherwise. A `GlError` when the pool
   * would pass its budget even with every size-keyed resident evicted, naming the pool.
   */
  acquire(slot: string, d: TextureDesc): Err | Texture
  /**
   * Take, or reuse, the render target of the **size-keyed** slot `slot` at exactly `d`. Where
   * `acquire` keeps one texture per slot and reallocates on any change, a size-keyed slot keeps
   * one resident per distinct description (size, format, sampling), so a caller that alternates
   * between two framings reallocates neither. A size the slot already holds costs a map lookup
   * and allocates nothing — the property every warm `stage.add` depends on.
   *
   * Residency is bounded by the same §8.1 budget: when a new size would pass it, the
   * least-recently-used size-keyed residents — of any size-keyed slot — are dropped first, oldest
   * first, and only a size that would not fit with every one of them gone is refused. Exclusive
   * slots are never evicted. The memory cost is therefore never more than §8.1 already prices; what
   * changes is that the budget's headroom is *used*, by the framings most recently built, instead
   * of being paid back to the driver and borrowed again on every call.
   *
   * The pool owns the target as well as the texture and drops the two together, which is what
   * lets a caller hold no framebuffer cache of its own that eviction could leave stale.
   */
  acquireSized(slot: string, d: TextureDesc): Err | Target
  /**
   * Drop one slot — its exclusive texture and every size-keyed resident under that name — and
   * release them. A no-op for a slot the pool does not hold.
   */
  release(slot: string): void
  /**
   * The one artwork slot, keyed by sprite (§8.5). Displacing a key is what lets Pool B's idle
   * interval start; consecutive rebuilds of the same sprite never re-source.
   */
  holdArtwork(key: string, d: TextureDesc): Err | Texture
  /** The sprite the artwork slot holds, or `null`. */
  artworkKey(): string | null
}

/**
 * Pool B — source staging, one key, released after an idle interval. Two textures sized by the
 * same source live under that key: the `RGBA8` staging the bitmap uploads into, and the
 * `RGBA8UI` copy of its exact bytes that the resample reads (see `acquireSourceBytes`).
 */
export interface StagingPool {
  bytes(): number
  /** `poolBBytes(source)` — §8.1's staging figure, sized by the source alone. */
  budgetFor(source: Size): number
  /**
   * Take the staging texture for `key`. A different key takes it at once — reusing the texture
   * when the source size is unchanged, reallocating it when it is not — so a grid of same-sized
   * sources uploads into one texture instead of allocating one per sprite.
   */
  acquire(key: string, source: Size): Err | Texture
  /**
   * The `RGBA8UI` copy of the source's exact bytes, as a render target, under the same key, the
   * same size and the same idle law as the staging. It used to be a dedicated allocation released
   * synchronously at the end of every resample (`artwork.ts`'s header records why: the resample
   * shader reads an integer sampler, and `acquire` hard-codes `RGBA8`), which cost one
   * source-sized `texStorage2D`, one framebuffer and their status queries per `stage.add`. Held
   * here it is allocated once per source size instead. The cost is a second source-sized texture
   * resident for Pool B's idle window — `bytes()` counts it; `budgetFor` stays §8.1's staging
   * figure, which never included the copy the resample was already allocating on every add.
   */
  acquireSourceBytes(key: string, source: Size): Err | Target
  /** Arm the idle release for `key`. A no-op while Pool A's artwork slot still holds `key`. */
  releaseIdle(key: string): void
  /** The sprite the staging slot holds, or `null`. */
  key(): string | null
}

export interface ScratchPools {
  readonly poolA: ArtworkPool
  readonly poolB: StagingPool
  /** Pool A plus Pool B — the transient high-water mark of one build (§8.1). */
  peak(): number
  dispose(): void
}

export interface ScratchPoolsOptions {
  readonly gl: TextureFactory
  /** `A`, the artwork rect the resample writes into — front-derived, never source-derived. */
  readonly artwork: Size
  readonly sdfRes: number
  /** Defaults to the real clock. The tests inject `createFakeTimers`. */
  readonly timers?: Timers
}

interface Slot {
  readonly texture: Texture
  readonly desc: TextureDesc
}

interface SizedSlot {
  readonly slot: string
  readonly target: Target
  /** `clock` at the last acquisition — the least-recently-used resident has the smallest. */
  stamp: number
}

/** A render target the pool owns, texture included. */
interface OwnedTarget {
  readonly target: Target
  readonly desc: TextureDesc
}

/** The slot `holdArtwork` keeps the sprite in. Named once, because `release` must know it too. */
const ARTWORK_SLOT = 'artwork'

/**
 * `TextureDesc.filter` and `.wrap` are optional and `gl-context` resolves them against documented
 * defaults, so a comparison must resolve them too: `undefined` and an explicitly written
 * `'LINEAR'` on a float format are the same texture, and reallocating between them would throw
 * away a live texture to build its twin.
 */
function effectiveFilter(d: TextureDesc): 'NEAREST' | 'LINEAR' {
  return d.filter ?? (INTEGER_FORMATS.has(d.format) ? 'NEAREST' : 'LINEAR')
}

function effectiveWrap(d: TextureDesc): 'CLAMP_TO_EDGE' | 'REPEAT' {
  return d.wrap ?? 'CLAMP_TO_EDGE'
}

/**
 * Whether re-acquiring `b` is asking for the thing `a` already allocated. Sampling counts: a
 * handle carries no filter and no wrap, so a caller handed back the old sampling has no field
 * by which to notice. `label` does not — it is diagnostic only.
 */
function sameDesc(a: TextureDesc, b: TextureDesc): boolean {
  return (
    a.width === b.width &&
    a.height === b.height &&
    a.format === b.format &&
    effectiveFilter(a) === effectiveFilter(b) &&
    effectiveWrap(a) === effectiveWrap(b)
  )
}

/** The size-keyed residents' key: everything `sameDesc` compares, under the slot's name. */
function sizedKey(slot: string, d: TextureDesc): string {
  return `${slot}|${d.width}x${d.height}|${d.format}|${effectiveFilter(d)}|${effectiveWrap(d)}`
}

function disposeOwned(t: Target): void {
  t.dispose()
  t.texture.dispose()
}

export function createScratchPools(o: ScratchPoolsOptions): ScratchPools {
  const timers = o.timers ?? systemTimers
  const budgetA = poolABytes(o.artwork, o.sdfRes)

  const slots = new Map<string, Slot>()
  const sized = new Map<string, SizedSlot>()
  let clock = 0
  let artworkKey: string | null = null

  let staging: Slot | null = null
  let sourceBytes: OwnedTarget | null = null
  let stagingKey: string | null = null
  let idleHandle: TimerHandle | null = null
  /** Set by `releaseIdle` while Pool A still holds the key; consumed when Pool A displaces it. */
  let idleDeferredFor: string | null = null

  function bytesExclusive(): number {
    let total = 0
    for (const slot of slots.values()) total += slot.texture.bytes
    return total
  }

  function bytesSized(): number {
    let total = 0
    for (const s of sized.values()) total += s.target.texture.bytes
    return total
  }

  function bytesA(): number {
    return bytesExclusive() + bytesSized()
  }

  function overBudget(total: number, slot: string): Err {
    return new GlError(
      `Pool A would grow to ${total} bytes for slot "${slot}", past its §8.1 budget of ` +
        `${budgetA} (artwork ${o.artwork.w}x${o.artwork.h}, sdfRes ${o.sdfRes}), even with ` +
        `every size-keyed resident evicted. An exact-path build allocates a dedicated, ` +
        `non-pooled set instead.`,
    )
  }

  /**
   * Drop least-recently-used size-keyed residents until `total` — the bytes the pool would hold
   * after the pending allocation — fits the budget. The caller has already established that it
   * can: `total` minus every size-keyed resident is within the budget.
   */
  function evictUntilFits(total: number): void {
    while (total > budgetA && sized.size > 0) {
      let oldestKey: string | undefined
      let oldest: SizedSlot | undefined
      for (const [key, s] of sized) {
        if (oldest === undefined || s.stamp < oldest.stamp) {
          oldestKey = key
          oldest = s
        }
      }
      if (oldestKey === undefined || oldest === undefined) return
      total -= oldest.target.texture.bytes
      disposeOwned(oldest.target)
      sized.delete(oldestKey)
    }
  }

  function dropStaging(): void {
    staging?.texture.dispose()
    staging = null
    if (sourceBytes !== null) disposeOwned(sourceBytes.target)
    sourceBytes = null
    stagingKey = null
    idleDeferredFor = null
  }

  function cancelIdle(): void {
    if (idleHandle !== null) timers.clearTimeoutFn(idleHandle)
    idleHandle = null
  }

  function armIdle(key: string): void {
    cancelIdle()
    idleDeferredFor = null
    idleHandle = timers.setTimeoutFn(() => {
      idleHandle = null
      if (stagingKey === key) dropStaging()
    }, POOL_B_IDLE_MS)
  }

  /**
   * The artwork slot has stopped holding `previous`, and now holds `next` — a key when another
   * sprite displaced it, `null` when the slot was released outright. Either way the retention
   * ended, and if Pool B was waiting on exactly that, this is what starts its idle interval —
   * never earlier. Both callers come through here so a release cannot forget half of it.
   */
  function endArtworkRetention(previous: string | null, next: string | null): void {
    if (previous !== null && previous !== next && idleDeferredFor === previous) armIdle(previous)
  }

  const poolA: ArtworkPool = {
    budget: budgetA,
    bytes: bytesA,

    acquire(slot, d) {
      const held = slots.get(slot)
      if (held !== undefined && sameDesc(held.desc, d)) return held.texture

      // Allocate first, then check, then release: the budget is still measured on the texture
      // the factory actually produced, never on a guess about what it will cost — but the slot
      // being replaced is not destroyed until its replacement is known to fit. A rejected
      // replacement leaves the pool exactly as it found it, size-keyed residents included:
      // nothing is evicted for an allocation that could not fit anyway.
      const texture = o.gl.texture(d)
      if (GlError.is(texture)) return texture

      const total = bytesA() - (held?.texture.bytes ?? 0) + texture.bytes
      if (total - bytesSized() > budgetA) {
        texture.dispose()
        return overBudget(total, slot)
      }
      evictUntilFits(total)
      if (held !== undefined) held.texture.dispose()
      slots.set(slot, { texture, desc: d })
      return texture
    },

    acquireSized(slot, d) {
      const key = sizedKey(slot, d)
      const hit = sized.get(key)
      if (hit !== undefined) {
        hit.stamp = ++clock
        return hit.target
      }

      // Same order as `acquire`: allocate, prove it can fit at all, and only then evict — the
      // residents a rejected allocation would have evicted are still serving their callers.
      const texture = o.gl.texture(d)
      if (GlError.is(texture)) return texture
      const total = bytesA() + texture.bytes
      if (total - bytesSized() > budgetA) {
        texture.dispose()
        return overBudget(total, slot)
      }
      const target = o.gl.target(texture)
      if (GlError.is(target)) {
        texture.dispose()
        return target
      }
      evictUntilFits(total)
      sized.set(key, { slot, target, stamp: ++clock })
      return target
    },

    release(slot) {
      for (const [key, s] of sized) {
        if (s.slot !== slot) continue
        disposeOwned(s.target)
        sized.delete(key)
      }
      const held = slots.get(slot)
      if (held === undefined) return
      held.texture.dispose()
      slots.delete(slot)
      if (slot !== ARTWORK_SLOT) return
      // Releasing the slot ends its retention as surely as displacing its key does. Leaving the
      // key set here is what kept `releaseIdle` deferring forever and pinned Pool B's staging
      // texture until `dispose()`.
      const previous = artworkKey
      artworkKey = null
      endArtworkRetention(previous, null)
    },

    holdArtwork(key, d) {
      const previous = artworkKey
      const texture = this.acquire(ARTWORK_SLOT, d)
      if (GlError.is(texture)) return texture
      artworkKey = key
      endArtworkRetention(previous, key)
      return texture
    },

    artworkKey: () => artworkKey,
  }

  /**
   * The slot is `key`'s now: whatever idle interval or deferral the previous key had is void. A
   * different sprite takes the slot at once, never on a timer — and takes the *textures* with it
   * when the source size is unchanged, because a staging texture holds nothing worth keeping once
   * the resample that read it has run (`artwork.ts`), so re-keying loses nothing.
   */
  function takeB(key: string, source: Size): void {
    cancelIdle()
    idleDeferredFor = null
    stagingKey = key
    // Both textures are sized by the one source; a different size drops both at once rather than
    // leaving one of the previous size resident beside the other's replacement.
    const resident = staging?.desc ?? sourceBytes?.desc
    if (resident !== undefined && (resident.width !== source.w || resident.height !== source.h)) {
      staging?.texture.dispose()
      staging = null
      if (sourceBytes !== null) disposeOwned(sourceBytes.target)
      sourceBytes = null
    }
  }

  const poolB: StagingPool = {
    bytes: () => (staging?.texture.bytes ?? 0) + (sourceBytes?.target.texture.bytes ?? 0),
    budgetFor: (source) => poolBBytes(source),

    acquire(key, source) {
      takeB(key, source)
      if (staging !== null) return staging.texture
      const d: TextureDesc = {
        width: source.w,
        height: source.h,
        format: 'RGBA8',
        filter: 'NEAREST',
        label: `staging:${source.w}x${source.h}`,
      }
      const texture = o.gl.texture(d)
      if (GlError.is(texture)) return texture
      staging = { texture, desc: d }
      return texture
    },

    acquireSourceBytes(key, source) {
      takeB(key, source)
      if (sourceBytes !== null) return sourceBytes.target
      const d: TextureDesc = {
        width: source.w,
        height: source.h,
        format: 'RGBA8UI',
        filter: 'NEAREST',
        label: `staging.bytes:${source.w}x${source.h}`,
      }
      const texture = o.gl.texture(d)
      if (GlError.is(texture)) return texture
      const target = o.gl.target(texture)
      if (GlError.is(target)) {
        texture.dispose()
        return target
      }
      sourceBytes = { target, desc: d }
      return target
    },

    releaseIdle(key) {
      if (stagingKey !== key || (staging === null && sourceBytes === null)) return
      if (artworkKey === key) {
        // §8.1: the interval must be at least as long as the artwork slot's retention. It has
        // not ended yet, so the interval has not started.
        idleDeferredFor = key
        return
      }
      armIdle(key)
    },

    key: () => stagingKey,
  }

  return {
    poolA,
    poolB,
    peak: () => bytesA() + poolB.bytes(),
    dispose() {
      cancelIdle()
      for (const slot of slots.values()) slot.texture.dispose()
      slots.clear()
      for (const s of sized.values()) disposeOwned(s.target)
      sized.clear()
      artworkKey = null
      dropStaging()
    },
  }
}
