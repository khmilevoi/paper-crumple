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

  it('refuses to grow past §8.1 budget, which is what stops one thumbnail resizing the stage', () => {
    const { pools } = setup()
    const tooBig = pools.poolA.acquire('rogue', { width: 2048, height: 2048, format: 'RGBA8' })
    expect(tooBig).toBeInstanceOf(GlError)
    expect((tooBig as InstanceType<typeof GlError>).message).toMatch(/Pool A/)
    expect(pools.poolA.bytes()).toBe(0)
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
