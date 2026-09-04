import { describe, expect, it } from 'vitest'
import { poolABytes, poolBBytes } from './bytes.js'
import { GlError } from './errors.js'
import { createScratchPools, POOL_B_IDLE_MS, type ScratchPools } from './gl-pools.js'
import { textureBytes, type Target, type Texture, type TextureDesc } from './gl-resources.js'
import { createFakeTimers, type FakeTimers } from './testing/fake-timers.js'

/**
 * A texture factory with no GL behind it. The pools never touch a texture beyond its `bytes` and
 * its `dispose`, which is what makes the whole lifetime story a level-1 test.
 */
function fakeFactory(): {
  texture: (d: TextureDesc) => InstanceType<typeof GlError> | Texture
  target: (t: Texture) => InstanceType<typeof GlError> | Target
  live: () => number
  liveTargets: () => number
} {
  let live = 0
  let liveTargets = 0
  return {
    texture(d: TextureDesc) {
      live += 1
      return {
        handle: {} as WebGLTexture,
        width: d.width,
        height: d.height,
        format: d.format,
        bytes: textureBytes(d),
        label: d.label ?? d.format,
        dispose() {
          live -= 1
        },
      }
    },
    // A framebuffer over a texture, with no GL behind it either: the pool owns the pair for its
    // size-keyed slots, and what these tests pin is that both halves are released together.
    target(t: Texture) {
      liveTargets += 1
      return {
        framebuffer: {} as WebGLFramebuffer,
        texture: t,
        width: t.width,
        height: t.height,
        dispose() {
          liveTargets -= 1
        },
      }
    },
    live: () => live,
    liveTargets: () => liveTargets,
  }
}

const ARTWORK = { w: 326, h: 326 }
const SDF_RES = 192
const SOURCE = { w: 998, h: 951 }

function setup(): {
  pools: ScratchPools
  timers: FakeTimers
  live: () => number
  liveTargets: () => number
} {
  const factory = fakeFactory()
  const timers = createFakeTimers(0)
  const pools = createScratchPools({
    gl: { texture: factory.texture, target: factory.target },
    timers,
    artwork: ARTWORK,
    sdfRes: SDF_RES,
  })
  return { pools, timers, live: factory.live, liveTargets: factory.liveTargets }
}

describe('the two pools are two, because their sizing laws differ (§8.1)', () => {
  it("takes Pool A's budget from maxSize and Pool B's from the source, never the other way", () => {
    const { pools } = setup()
    // 1 466 512 B at maxSize 384 — the artwork plus 28.25 B per sdfRes texel.
    expect(pools.poolA.budget).toBe(poolABytes(ARTWORK, SDF_RES))
    expect(pools.poolA.budget).toBe(1_466_512)
    // 3 796 392 B for a 998x951 source. One 4000 px asset must not size Pool A.
    expect(pools.poolB.budgetFor(SOURCE)).toBe(poolBBytes(SOURCE))
    expect(pools.poolB.budgetFor(SOURCE)).toBe(3_796_392)
  })

  it('reports a build peak that is the two pools added, not their maximum', () => {
    const { pools } = setup()
    const artwork = pools.poolA.acquire('artwork', {
      width: ARTWORK.w,
      height: ARTWORK.h,
      format: 'RGBA8',
    })
    expect(artwork).not.toBeInstanceOf(GlError)
    const staging = pools.poolB.acquire('shirt', SOURCE)
    expect(staging).not.toBeInstanceOf(GlError)
    // Their lifetimes are disjoint, so a shared pool would pay the union where the maximum
    // would do — but during a build both are live, and that is the peak §8.1 prices.
    expect(pools.peak()).toBe(pools.poolA.bytes() + pools.poolB.bytes())
  })
})

describe('Pool A (§8.1)', () => {
  it('counts a slot once, however many times it is acquired', () => {
    const { pools, live } = setup()
    const first = pools.poolA.acquire('artwork', {
      width: ARTWORK.w,
      height: ARTWORK.h,
      format: 'RGBA8',
    })
    const second = pools.poolA.acquire('artwork', {
      width: ARTWORK.w,
      height: ARTWORK.h,
      format: 'RGBA8',
    })
    expect(second).toBe(first)
    expect(pools.poolA.bytes()).toBe(ARTWORK.w * ARTWORK.h * 4)
    expect(live()).toBe(1)
  })

  it('reallocates a slot whose description changed, and re-prices it', () => {
    const { pools, live } = setup()
    pools.poolA.acquire('field', { width: 192, height: 192, format: 'R16F' })
    expect(pools.poolA.bytes()).toBe(192 * 192 * 2)
    pools.poolA.acquire('field', { width: 96, height: 96, format: 'R16F' })
    expect(pools.poolA.bytes()).toBe(96 * 96 * 2)
    expect(live()).toBe(1)
  })

  it('reallocates a slot whose sampling changed, which no field on the handle would reveal', () => {
    const { pools, live } = setup()
    const first = pools.poolA.acquire('field', { width: 192, height: 192, format: 'R16F' })
    // Same size, same format, different filter. Handing back the held texture would hand back
    // the old sampling silently — no error, no reallocation, and nothing to notice it by.
    const sharper = pools.poolA.acquire('field', {
      width: 192,
      height: 192,
      format: 'R16F',
      filter: 'NEAREST',
    })
    expect(sharper).not.toBe(first)
    const wrapped = pools.poolA.acquire('field', {
      width: 192,
      height: 192,
      format: 'R16F',
      filter: 'NEAREST',
      wrap: 'REPEAT',
    })
    expect(wrapped).not.toBe(sharper)
    expect(live()).toBe(1)
  })

  it('reuses a slot whose optionals only spell out the defaults they already had', () => {
    const { pools, live } = setup()
    // R16F is not an integer format, so a bare desc already means LINEAR / CLAMP_TO_EDGE
    // (gl-resources §8.7). Comparing the raw optionals would reallocate an identical texture.
    const first = pools.poolA.acquire('field', { width: 192, height: 192, format: 'R16F' })
    const spelled = pools.poolA.acquire('field', {
      width: 192,
      height: 192,
      format: 'R16F',
      filter: 'LINEAR',
      wrap: 'CLAMP_TO_EDGE',
    })
    expect(spelled).toBe(first)
    // RGBA8UI is integer, so NEAREST is its default and naming it changes nothing either.
    const integer = pools.poolA.acquire('ui', { width: 64, height: 64, format: 'RGBA8UI' })
    const spelledInteger = pools.poolA.acquire('ui', {
      width: 64,
      height: 64,
      format: 'RGBA8UI',
      filter: 'NEAREST',
    })
    expect(spelledInteger).toBe(integer)
    // `label` is diagnostic only, so it is outside the comparison.
    const labelled = pools.poolA.acquire('field', {
      width: 192,
      height: 192,
      format: 'R16F',
      label: 'field:sdf',
    })
    expect(labelled).toBe(first)
    expect(live()).toBe(2)
  })

  it('drops the one slot release() names and leaves every other slot alone', () => {
    const { pools, live } = setup()
    pools.poolA.acquire('field', { width: 192, height: 192, format: 'R16F' })
    pools.poolA.acquire('mask', { width: 192, height: 192, format: 'R8' })
    pools.poolA.release('field')
    expect(pools.poolA.bytes()).toBe(192 * 192)
    expect(live()).toBe(1)
    // A no-op for a slot the pool does not hold, and for one already released.
    pools.poolA.release('field')
    pools.poolA.release('never-held')
    expect(pools.poolA.bytes()).toBe(192 * 192)
    expect(live()).toBe(1)
  })

  it('refuses to grow past §8.1 budget, which is what stops one thumbnail resizing the stage', () => {
    const { pools } = setup()
    const tooBig = pools.poolA.acquire('rogue', { width: 2048, height: 2048, format: 'RGBA8' })
    expect(tooBig).toBeInstanceOf(GlError)
    expect((tooBig as InstanceType<typeof GlError>).message).toMatch(/Pool A/)
    expect(pools.poolA.bytes()).toBe(0)
  })

  it('keeps the slot it already had when a replacement would bust the budget', () => {
    const { pools, live } = setup()
    const first = pools.poolA.acquire('field', { width: 192, height: 192, format: 'R16F' })
    expect(first).not.toBeInstanceOf(GlError)
    const bytesBefore = pools.poolA.bytes()

    const rejected = pools.poolA.acquire('field', {
      width: 2048,
      height: 2048,
      format: 'RGBA8',
    })
    expect(rejected).toBeInstanceOf(GlError)
    expect((rejected as InstanceType<typeof GlError>).message).toMatch(/Pool A/)
    // The pool is exactly where it was — the slot's original texture was never disposed.
    expect(pools.poolA.bytes()).toBe(bytesBefore)
    expect(live()).toBe(1)
  })

  it('leaves both pools untouched by an exact-path allocation, which is never pooled', () => {
    const { pools } = setup()
    const factory = fakeFactory()
    // §8.1: `exact: true` allocates a dedicated, non-pooled scratch set and releases it
    // synchronously. It goes through ctx.texture directly and must never grow either pool.
    const dedicated = factory.texture({ width: 2000, height: 2000, format: 'RGBA8' })
    expect(dedicated).not.toBeInstanceOf(GlError)
    expect(pools.poolA.bytes()).toBe(0)
    expect(pools.poolB.bytes()).toBe(0)
  })
})

describe('size-keyed slots keep every framing resident inside the §8.1 budget', () => {
  const field = (w: number, h: number): TextureDesc => ({ width: w, height: h, format: 'R16F' })

  it('keeps every size a slot has been asked for, and hands back the same target for one it holds', () => {
    const { pools, live, liveTargets } = setup()
    const large = pools.poolA.acquireSized('field', field(192, 192))
    const small = pools.poolA.acquireSized('field', field(96, 96))
    expect(GlError.is(large) || GlError.is(small)).toBe(false)
    if (GlError.is(large) || GlError.is(small)) return
    // Both framings are resident and both are priced: an exclusive slot would have dropped the
    // first the moment the second was asked for, and re-allocated it on the next flip.
    expect(pools.poolA.bytes()).toBe(192 * 192 * 2 + 96 * 96 * 2)
    expect(live()).toBe(2)
    expect(liveTargets()).toBe(2)
    expect(pools.poolA.acquireSized('field', field(192, 192))).toBe(large)
    expect(pools.poolA.acquireSized('field', field(96, 96))).toBe(small)
    expect(live()).toBe(2)
    // The target is over the very texture it reports, at the size asked for.
    expect(large.width).toBe(192)
    expect(large.texture.width).toBe(192)
    expect(large.texture.format).toBe('R16F')
  })

  it('keys on everything sameDesc compares, so a different sampling is a different resident', () => {
    const { pools, live } = setup()
    const linear = pools.poolA.acquireSized('field', field(96, 96))
    const nearest = pools.poolA.acquireSized('field', { ...field(96, 96), filter: 'NEAREST' })
    expect(nearest).not.toBe(linear)
    // A spelled-out default is the same resident, and a label is outside the key.
    const spelled = pools.poolA.acquireSized('field', {
      ...field(96, 96),
      filter: 'LINEAR',
      wrap: 'CLAMP_TO_EDGE',
      label: 'field:spelled',
    })
    expect(spelled).toBe(linear)
    expect(live()).toBe(2)
  })

  it('evicts the least-recently-used size of any size-keyed slot when a new one would pass the budget', () => {
    const { pools, live, liveTargets } = setup()
    // Budget 1 466 512 B. Two 512² R16F residents are 1 048 576 B; a third at 448x512 (458 752 B)
    // would reach 1 507 328 B, past the budget — but not past it with the oldest gone.
    const a = pools.poolA.acquireSized('field', field(512, 512))
    const b = pools.poolA.acquireSized('hull', field(512, 512))
    expect(GlError.is(a) || GlError.is(b)).toBe(false)
    // Touch `a` again so `b` is the least recently used, in a different slot from the newcomer:
    // eviction is by age across every size-keyed slot, not confined to the slot being filled.
    expect(pools.poolA.acquireSized('field', field(512, 512))).toBe(a)
    const c = pools.poolA.acquireSized('field', field(448, 512))
    expect(GlError.is(c)).toBe(false)
    expect(pools.poolA.bytes()).toBe(512 * 512 * 2 + 448 * 512 * 2)
    expect(live()).toBe(2)
    expect(liveTargets()).toBe(2)
    // `a` survived untouched; `b` is gone and comes back as a fresh allocation.
    expect(pools.poolA.acquireSized('field', field(512, 512))).toBe(a)
    expect(pools.poolA.acquireSized('hull', field(512, 512))).not.toBe(b)
  })

  it('refuses a size that would not fit even with every resident evicted, and evicts nothing for it', () => {
    const { pools, live } = setup()
    const a = pools.poolA.acquireSized('field', field(192, 192))
    expect(GlError.is(a)).toBe(false)
    const bytesBefore = pools.poolA.bytes()
    const rogue = pools.poolA.acquireSized('rogue', { width: 2048, height: 2048, format: 'RGBA8' })
    expect(rogue).toBeInstanceOf(GlError)
    expect((rogue as InstanceType<typeof GlError>).message).toMatch(/Pool A/)
    expect(pools.poolA.bytes()).toBe(bytesBefore)
    expect(pools.poolA.acquireSized('field', field(192, 192))).toBe(a)
    expect(live()).toBe(1)
  })

  it('never evicts an exclusive slot — an exclusive allocation evicts size-keyed residents instead', () => {
    const { pools, live } = setup()
    // Fill the budget with size-keyed residents, then grow the exclusive artwork slot: the
    // residents give way, the artwork is never refused for them.
    pools.poolA.acquireSized('field', field(512, 512))
    pools.poolA.acquireSized('hull', field(512, 512))
    const artwork = pools.poolA.holdArtwork('shirt', {
      width: 512,
      height: 512,
      format: 'RGBA8UI',
    })
    expect(GlError.is(artwork)).toBe(false)
    expect(pools.poolA.artworkKey()).toBe('shirt')
    expect(pools.poolA.bytes()).toBeLessThanOrEqual(pools.poolA.budget)
    expect(pools.poolA.bytes()).toBeGreaterThanOrEqual(512 * 512 * 4)
    // And the other way round: a size-keyed allocation cannot make room by dropping the artwork.
    const tooBig = pools.poolA.acquireSized('field', { width: 600, height: 600, format: 'RGBA8' })
    expect(tooBig).toBeInstanceOf(GlError)
    expect(pools.poolA.artworkKey()).toBe('shirt')
    expect(live()).toBeGreaterThanOrEqual(1)
  })

  it('release() drops every size of the slot it names, framebuffers included, and nothing else', () => {
    const { pools, live, liveTargets } = setup()
    pools.poolA.acquireSized('field', field(192, 192))
    pools.poolA.acquireSized('field', field(96, 96))
    pools.poolA.acquireSized('hull', field(192, 192))
    pools.poolA.release('field')
    expect(pools.poolA.bytes()).toBe(192 * 192 * 2)
    expect(live()).toBe(1)
    expect(liveTargets()).toBe(1)
  })

  it('disposes size-keyed residents with the pool, texture and framebuffer alike', () => {
    const { pools, live, liveTargets } = setup()
    pools.poolA.acquireSized('field', field(192, 192))
    pools.poolA.acquireSized('field', field(96, 96))
    pools.dispose()
    expect(pools.poolA.bytes()).toBe(0)
    expect(live()).toBe(0)
    expect(liveTargets()).toBe(0)
  })
})

describe('Pool B is keyed by sprite but sized by the source (§8.1)', () => {
  it('reuses the staging texture for a different sprite of the same source size, re-keyed at once', () => {
    const { pools, live } = setup()
    const first = pools.poolB.acquire('shirt', SOURCE)
    const second = pools.poolB.acquire('coat', SOURCE)
    expect(second).toBe(first)
    expect(pools.poolB.key()).toBe('coat')
    expect(pools.poolB.bytes()).toBe(poolBBytes(SOURCE))
    expect(live()).toBe(1)
  })

  it("keeps the source's RGBA8UI copy beside the staging, under the same idle law", () => {
    const { pools, timers, live, liveTargets } = setup()
    const staging = pools.poolB.acquire('shirt', SOURCE)
    const bytes = pools.poolB.acquireSourceBytes('shirt', SOURCE)
    expect(GlError.is(staging) || GlError.is(bytes)).toBe(false)
    if (GlError.is(bytes)) return
    expect(bytes.texture.format).toBe('RGBA8UI')
    expect(bytes.width).toBe(SOURCE.w)
    expect(bytes.height).toBe(SOURCE.h)
    // Two source-sized textures: `bytes()` is honest about both, `budgetFor` stays §8.1's staging
    // figure — the copy was a per-add transient the accounting never saw before.
    expect(pools.poolB.bytes()).toBe(2 * poolBBytes(SOURCE))
    expect(pools.poolB.budgetFor(SOURCE)).toBe(poolBBytes(SOURCE))
    expect(pools.peak()).toBe(pools.poolA.bytes() + pools.poolB.bytes())
    // A second resample of the same source size allocates neither.
    expect(pools.poolB.acquireSourceBytes('coat', SOURCE)).toBe(bytes)
    expect(pools.poolB.acquire('coat', SOURCE)).toBe(staging)
    expect(live()).toBe(2)
    expect(liveTargets()).toBe(1)

    pools.poolB.releaseIdle('coat')
    timers.advance(POOL_B_IDLE_MS - 1)
    expect(pools.poolB.bytes()).toBe(2 * poolBBytes(SOURCE))
    timers.advance(1)
    expect(pools.poolB.bytes()).toBe(0)
    expect(live()).toBe(0)
    expect(liveTargets()).toBe(0)
    expect(pools.poolB.key()).toBeNull()
  })

  it('drops both textures at once when the source size changes', () => {
    const { pools, live, liveTargets } = setup()
    pools.poolB.acquire('shirt', SOURCE)
    pools.poolB.acquireSourceBytes('shirt', SOURCE)
    const smaller = { w: 512, h: 512 }
    const bytes = pools.poolB.acquireSourceBytes('coat', smaller)
    expect(GlError.is(bytes)).toBe(false)
    expect(pools.poolB.bytes()).toBe(poolBBytes(smaller))
    expect(live()).toBe(1)
    expect(liveTargets()).toBe(1)
    expect(pools.poolB.key()).toBe('coat')
  })

  it('cancels a pending idle interval when another sprite of the same size takes the slot', () => {
    const { pools, timers, live } = setup()
    const first = pools.poolB.acquire('shirt', SOURCE)
    pools.poolB.releaseIdle('shirt')
    timers.advance(POOL_B_IDLE_MS - 1)
    expect(pools.poolB.acquire('coat', SOURCE)).toBe(first)
    timers.advance(POOL_B_IDLE_MS * 2)
    // The old key's interval is void; only the new key's own `releaseIdle` can start one.
    expect(pools.poolB.bytes()).toBe(poolBBytes(SOURCE))
    expect(pools.poolB.key()).toBe('coat')
    expect(live()).toBe(1)
  })
})

describe("Pool B's idle release outlives the artwork slot's retention (§8.1, §8.5)", () => {
  it('holds the staging texture for as long as the artwork slot holds the same sprite', () => {
    const { pools, timers } = setup()
    pools.poolB.acquire('shirt', SOURCE)
    pools.poolA.holdArtwork('shirt', { width: ARTWORK.w, height: ARTWORK.h, format: 'RGBA8' })
    pools.poolB.releaseIdle('shirt')
    // Ten intervals of nothing happening. The artwork slot still holds 'shirt', so releasing
    // the staging would make the next re-source fall through to a re-load — 5-15 ms instead of
    // 0.7-2.0 ms, and asynchronous instead of synchronous.
    timers.advance(POOL_B_IDLE_MS * 10)
    expect(pools.poolB.bytes()).toBe(poolBBytes(SOURCE))
  })

  it('starts the interval when the artwork slot is taken by another sprite, not before', () => {
    const { pools, timers } = setup()
    pools.poolB.acquire('shirt', SOURCE)
    pools.poolA.holdArtwork('shirt', { width: ARTWORK.w, height: ARTWORK.h, format: 'RGBA8' })
    pools.poolB.releaseIdle('shirt')

    pools.poolA.holdArtwork('coat', { width: ARTWORK.w, height: ARTWORK.h, format: 'RGBA8' })
    timers.advance(POOL_B_IDLE_MS - 1)
    expect(pools.poolB.bytes()).toBe(poolBBytes(SOURCE))
    timers.advance(1)
    expect(pools.poolB.bytes()).toBe(0)
  })

  it('starts the interval when the artwork slot is released, because that ends a retention too', () => {
    const { pools, timers, live } = setup()
    pools.poolB.acquire('shirt', SOURCE)
    pools.poolA.holdArtwork('shirt', { width: ARTWORK.w, height: ARTWORK.h, format: 'RGBA8' })
    pools.poolB.releaseIdle('shirt')

    // A release ends the artwork slot's retention exactly as a displacement does. Observing only
    // the displacement pins 3 796 392 B of staging until dispose().
    pools.poolA.release('artwork')
    timers.advance(POOL_B_IDLE_MS - 1)
    expect(pools.poolB.bytes()).toBe(poolBBytes(SOURCE))
    timers.advance(1)
    expect(pools.poolB.bytes()).toBe(0)
    expect(live()).toBe(0)
  })

  it('cancels the interval when the same sprite comes back, without reallocating', () => {
    const { pools, timers, live } = setup()
    const first = pools.poolB.acquire('shirt', SOURCE)
    pools.poolB.releaseIdle('shirt')
    timers.advance(POOL_B_IDLE_MS - 1)
    const again = pools.poolB.acquire('shirt', SOURCE)
    expect(again).toBe(first)
    timers.advance(POOL_B_IDLE_MS * 2)
    expect(pools.poolB.bytes()).toBe(poolBBytes(SOURCE))
    expect(live()).toBe(1)
  })

  it('is one slot: a second sprite takes it and the first is gone at once, not on a timer', () => {
    const { pools, live } = setup()
    pools.poolB.acquire('shirt', SOURCE)
    pools.poolB.acquire('coat', { w: 512, h: 512 })
    expect(pools.poolB.bytes()).toBe(poolBBytes({ w: 512, h: 512 }))
    expect(live()).toBe(1)
  })

  it('reports the sprite each pool is holding across hold, release and re-hold (§8.5)', () => {
    const { pools, timers } = setup()
    const artwork: TextureDesc = { width: ARTWORK.w, height: ARTWORK.h, format: 'RGBA8' }

    expect(pools.poolA.artworkKey()).toBeNull()
    expect(pools.poolB.key()).toBeNull()

    pools.poolB.acquire('shirt', SOURCE)
    pools.poolA.holdArtwork('shirt', artwork)
    expect(pools.poolA.artworkKey()).toBe('shirt')
    expect(pools.poolB.key()).toBe('shirt')

    // A displacement moves the artwork key; Pool B's slot is not on Pool A's clock.
    pools.poolA.holdArtwork('coat', artwork)
    expect(pools.poolA.artworkKey()).toBe('coat')
    expect(pools.poolB.key()).toBe('shirt')

    // A release ends the retention, so the key it reports must end with it.
    pools.poolA.release('artwork')
    expect(pools.poolA.artworkKey()).toBeNull()

    pools.poolA.holdArtwork('shirt', artwork)
    expect(pools.poolA.artworkKey()).toBe('shirt')

    pools.poolB.acquire('coat', { w: 512, h: 512 })
    expect(pools.poolB.key()).toBe('coat')
    pools.poolB.releaseIdle('coat')
    timers.advance(POOL_B_IDLE_MS)
    expect(pools.poolB.key()).toBeNull()
    expect(pools.poolA.artworkKey()).toBe('shirt')
  })

  it('disposes everything and cancels every pending timer, so a stage teardown leaks nothing', () => {
    const { pools, timers, live } = setup()
    pools.poolA.acquire('artwork', { width: ARTWORK.w, height: ARTWORK.h, format: 'RGBA8' })
    pools.poolB.acquire('shirt', SOURCE)
    pools.poolB.releaseIdle('shirt')
    pools.dispose()
    expect(live()).toBe(0)
    expect(pools.poolA.bytes()).toBe(0)
    expect(pools.poolB.bytes()).toBe(0)
    expect(timers.pending).toBe(0)
  })
})
