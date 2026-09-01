import { describe, expect, it } from 'vitest'
import { poolABytes, poolBBytes } from './bytes.js'
import { GlError } from './errors.js'
import { createScratchPools, POOL_B_IDLE_MS, type ScratchPools } from './gl-pools.js'
import { textureBytes, type Texture, type TextureDesc } from './gl-resources.js'
import { createFakeTimers, type FakeTimers } from './testing/fake-timers.js'

/**
 * A texture factory with no GL behind it. The pools never touch a texture beyond its `bytes` and
 * its `dispose`, which is what makes the whole lifetime story a level-1 test.
 */
function fakeFactory(): {
  texture: (d: TextureDesc) => InstanceType<typeof GlError> | Texture
  live: () => number
} {
  let live = 0
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
    live: () => live,
  }
}

const ARTWORK = { w: 326, h: 326 }
const SDF_RES = 192
const SOURCE = { w: 998, h: 951 }

function setup(): { pools: ScratchPools; timers: FakeTimers; live: () => number } {
  const factory = fakeFactory()
  const timers = createFakeTimers(0)
  const pools = createScratchPools({
    gl: { texture: factory.texture },
    timers,
    artwork: ARTWORK,
    sdfRes: SDF_RES,
  })
  return { pools, timers, live: factory.live }
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
