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
 * `exact: true` allocates a **dedicated, non-pooled** set straight from `ctx.texture` and releases
 * it synchronously at the end of the build. It must never grow either pool, or one tap on a
 * thumbnail permanently sizes the stage's scratch to ~39 MB and §8.9's grid budget stops being
 * true. The budget check below is what makes that structural rather than a rule in prose.
 */
import { poolABytes, poolBBytes } from './bytes.js'
import { GlError } from './errors.js'
import type { Size } from './geometry.js'
import type { GlContext } from './gl.js'
import type { Texture, TextureDesc } from './gl-resources.js'
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

/** The half of `GlContext` a pool needs. Everything else about the context is irrelevant here. */
export type TextureFactory = Pick<GlContext, 'texture'>

/** Pool A — artwork, JFA ping-pong, fields, hull mask, hull field, hull canvas. */
export interface ArtworkPool {
  /** `poolABytes(artwork, sdfRes)` — §8.1's figure, read from P5 and never restated. */
  readonly budget: number
  /** Live bytes across every slot. */
  bytes(): number
  /**
   * Take, or reuse, the slot named `slot`. Reuses the existing texture when `d` describes the
   * same thing; reallocates and re-prices it otherwise. A `GlError` when the pool would pass its
   * budget, naming the pool.
   */
  acquire(slot: string, d: TextureDesc): Err | Texture
  /** Drop one slot and release its texture. A no-op for a slot the pool does not hold. */
  release(slot: string): void
  /**
   * The one artwork slot, keyed by sprite (§8.5). Displacing a key is what lets Pool B's idle
   * interval start; consecutive rebuilds of the same sprite never re-source.
   */
  holdArtwork(key: string, d: TextureDesc): Err | Texture
  /** The sprite the artwork slot holds, or `null`. */
  artworkKey(): string | null
}

/** Pool B — source staging, one slot, released after an idle interval. */
export interface StagingPool {
  bytes(): number
  /** `poolBBytes(source)` — sized by the source alone. */
  budgetFor(source: Size): number
  /** Take the one slot for `key`. A different key displaces the previous one immediately. */
  acquire(key: string, source: Size): Err | Texture
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

function sameDesc(a: TextureDesc, b: TextureDesc): boolean {
  return a.width === b.width && a.height === b.height && a.format === b.format
}

export function createScratchPools(o: ScratchPoolsOptions): ScratchPools {
  const timers = o.timers ?? systemTimers
  const budgetA = poolABytes(o.artwork, o.sdfRes)

  const slots = new Map<string, Slot>()
  let artworkKey: string | null = null

  let staging: Slot | null = null
  let stagingKey: string | null = null
  let idleHandle: TimerHandle | null = null
  /** Set by `releaseIdle` while Pool A still holds the key; consumed when Pool A displaces it. */
  let idleDeferredFor: string | null = null

  function bytesA(): number {
    let total = 0
    for (const slot of slots.values()) total += slot.texture.bytes
    return total
  }

  function dropStaging(): void {
    staging?.texture.dispose()
    staging = null
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

  const poolA: ArtworkPool = {
    budget: budgetA,
    bytes: bytesA,

    acquire(slot, d) {
      const held = slots.get(slot)
      if (held !== undefined && sameDesc(held.desc, d)) return held.texture

      // Allocate first, then check, then release: the budget is still measured on the texture
      // the factory actually produced, never on a guess about what it will cost — but the slot
      // being replaced is not destroyed until its replacement is known to fit. A rejected
      // replacement leaves the pool exactly as it found it.
      const texture = o.gl.texture(d)
      if (GlError.is(texture)) return texture

      const total = bytesA() - (held?.texture.bytes ?? 0) + texture.bytes
      if (total > budgetA) {
        texture.dispose()
        return new GlError(
          `Pool A would grow to ${total} bytes for slot "${slot}", past its §8.1 budget of ` +
            `${budgetA} (artwork ${o.artwork.w}x${o.artwork.h}, sdfRes ${o.sdfRes}). ` +
            `An exact-path build allocates a dedicated, non-pooled set instead.`,
        )
      }
      if (held !== undefined) held.texture.dispose()
      slots.set(slot, { texture, desc: d })
      return texture
    },

    release(slot) {
      const held = slots.get(slot)
      if (held === undefined) return
      held.texture.dispose()
      slots.delete(slot)
    },

    holdArtwork(key, d) {
      const previous = artworkKey
      const texture = this.acquire('artwork', d)
      if (GlError.is(texture)) return texture
      artworkKey = key
      // The artwork slot's retention just ended for `previous`. If Pool B was waiting on it,
      // that is what starts its idle interval — never earlier.
      if (previous !== null && previous !== key && idleDeferredFor === previous) {
        armIdle(previous)
      }
      return texture
    },

    artworkKey: () => artworkKey,
  }

  const poolB: StagingPool = {
    bytes: () => staging?.texture.bytes ?? 0,
    budgetFor: (source) => poolBBytes(source),

    acquire(key, source) {
      if (stagingKey === key && staging !== null) {
        cancelIdle()
        idleDeferredFor = null
        return staging.texture
      }
      // One slot, keyed by sprite. A different sprite takes it at once, not on a timer.
      cancelIdle()
      dropStaging()
      const d: TextureDesc = {
        width: source.w,
        height: source.h,
        format: 'RGBA8',
        filter: 'NEAREST',
        label: `staging:${key}`,
      }
      const texture = o.gl.texture(d)
      if (GlError.is(texture)) return texture
      staging = { texture, desc: d }
      stagingKey = key
      return texture
    },

    releaseIdle(key) {
      if (stagingKey !== key || staging === null) return
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
    peak: () => bytesA() + (staging?.texture.bytes ?? 0),
    dispose() {
      cancelIdle()
      for (const slot of slots.values()) slot.texture.dispose()
      slots.clear()
      artworkKey = null
      dropStaging()
    },
  }
}
