import { describe, expect, it } from 'vitest'
import type { HandleFacts } from './bytes.js'
import {
  cpuSdfBytes,
  fieldBytes,
  frontBytes,
  FRONT_BYTES_PER_TEXEL,
  handleBytes,
  poolABytes,
  poolBBytes,
  scratchBytes,
} from './bytes.js'

/** The three buckets at `maxSize` 384 (spec 8.6). */
const BUCKETS = [
  { w: 256, h: 384 },
  { w: 384, h: 384 },
  { w: 384, h: 256 },
] as const

/**
 * A handle whose hull is one component of `vertices` points packed as x, y pairs, plus a
 * two-entry component-offset array. The layout is P8's; this file only needs a byte length.
 */
function handle(o: Partial<HandleFacts> & { vertices?: number }): HandleFacts {
  const { vertices = 40, ...rest } = o
  return {
    rect: { x: 0, y: 0, w: 326, h: 326 },
    overscan: 0.09,
    sdfRes: 192,
    srcW: 998,
    srcH: 951,
    aspect: 998 / 951,
    exact: false,
    hull: [new Float32Array(vertices * 2), new Uint32Array(2)],
    ...rest,
  }
}

describe('frontBytes', () => {
  it('is RGBA8 with no mipmaps: 4 bytes per texel', () => {
    expect(FRONT_BYTES_PER_TEXEL).toBe(4)
    expect(frontBytes({ w: 1, h: 1 })).toBe(4)
  })

  it("reproduces spec 8.6's three bucket figures", () => {
    expect(frontBytes(BUCKETS[0])).toBe(393_216)
    expect(frontBytes(BUCKETS[1])).toBe(589_824)
    expect(frontBytes(BUCKETS[2])).toBe(393_216)
  })

  it('gives 8.6 mean 458 752 B and 45.88 MB per 100 sprites', () => {
    const mean = BUCKETS.reduce((n, b) => n + frontBytes(b), 0) / BUCKETS.length
    expect(mean).toBe(458_752)
    expect(mean * 100).toBe(45_875_200)
  })

  it('gives 8.9 146 resident fronts at the 64 MiB cap', () => {
    const mean = BUCKETS.reduce((n, b) => n + frontBytes(b), 0) / BUCKETS.length
    expect(Math.floor(67_108_864 / mean)).toBe(146)
  })

  it("gives 8.9's 22.3 MB exact front at a 2000 px source and p = 0.09", () => {
    expect(frontBytes({ w: 2360, h: 2360 })).toBe(22_278_400)
  })
})

describe('handleBytes', () => {
  it('is independent of source size - the property that would have caught the 45 MB tier', () => {
    const small = handleBytes(handle({ vertices: 40, srcW: 320, srcH: 320 }))
    const large = handleBytes(handle({ vertices: 40, srcW: 4000, srcH: 4000 }))
    expect(small).toBe(large)
    // A handle that had retained the padded RGBA8 source would be six orders larger.
    expect(large).toBeLessThan(frontBytes({ w: 4000, h: 4000 }) / 1000)
  })

  it('is under 4096 bytes for every handle in a 1000-sprite fixture', () => {
    for (let i = 0; i < 1000; i++) {
      const vertices = 12 + ((i * 37) % 289)
      const h = handle({
        vertices,
        srcW: 200 + ((i * 13) % 3800),
        srcH: 200 + ((i * 29) % 3800),
        exact: i % 11 === 0,
        sdfRes: [128, 192, 256, 320, 512][i % 5],
      })
      expect(handleBytes(h)).toBeLessThan(4096)
    }
  })

  it('stays inside 8.9 handle tier of 1.71 MB across 1000 handles', () => {
    // Spec 8.5's reference handle: the ~40 vertices a 2600 px perimeter yields at the default
    // angularity, in one component.
    expect(handleBytes(handle({ vertices: 40 })) * 1000).toBeLessThanOrEqual(1_712_000)
  })

  it('grows only with the hull, and linearly in its vertices', () => {
    const a = handleBytes(handle({ vertices: 40 }))
    const b = handleBytes(handle({ vertices: 80 }))
    const c = handleBytes(handle({ vertices: 120 }))
    expect(b - a).toBe(c - b)
    expect(a).toBeLessThan(b)
    // Neither the rect, the overscan, the sdfRes nor the exact flag moves the figure.
    expect(handleBytes(handle({ vertices: 40, sdfRes: 512, exact: true }))).toBe(a)
  })

  it('counts a second hull component, because a pair of sneakers is two pieces of paper', () => {
    const one = handleBytes(handle({ vertices: 40 }))
    const two = handleBytes({
      ...handle({ vertices: 40 }),
      hull: [new Float32Array(80), new Float32Array(60), new Uint32Array(3)],
    })
    expect(two).toBeGreaterThan(one)
  })

  it('has a stated hull ceiling, so the < 4096 assertion has teeth', () => {
    // 408 + 8 * vertices, so the model crosses 4096 at 461 vertices - roughly eleven times the
    // ~40 a 2600 px perimeter yields at the default angularity.
    expect(handleBytes(handle({ vertices: 40 }))).toBe(728)
    expect(handleBytes(handle({ vertices: 460 }))).toBeLessThan(4096)
    expect(handleBytes(handle({ vertices: 461 }))).toBeGreaterThanOrEqual(4096)
  })
})

describe('the two pools, which have different sizing laws', () => {
  it("gives 8.1's per-sprite field figures at sdfRes 192", () => {
    expect(fieldBytes(192)).toBe(78_336)
    expect(192 * 192 * 2).toBe(73_728)
    expect(48 * 48 * 2).toBe(4_608)
  })

  it('makes the fields roughly six times smaller than a front, not larger', () => {
    expect(458_752 / fieldBytes(192)).toBeGreaterThan(5.5)
    expect(458_752 / fieldBytes(192)).toBeLessThan(6.5)
  })

  it("gives 8.1's Pool A total of 1 466 512 B at maxSize 384", () => {
    expect(poolABytes({ w: 326, h: 326 }, 192)).toBe(1_466_512)
    expect(frontBytes({ w: 326, h: 326 })).toBe(425_104)
  })

  it("gives 8.1's Pool B of 3 796 392 B for a 998x951 source", () => {
    expect(poolBBytes({ w: 998, h: 951 })).toBe(3_796_392)
  })

  it("gives 8.1's 5 262 904 B peak during a build", () => {
    const s = scratchBytes({ artwork: { w: 326, h: 326 }, sdfRes: 192, source: { w: 998, h: 951 } })
    expect(s.poolA).toBe(1_466_512)
    expect(s.poolB).toBe(3_796_392)
    expect(s.peak).toBe(5_262_904)
  })

  it("gives 8.1's exact-path 39 405 568 B transient peak at a 2000 px source", () => {
    const s = scratchBytes({
      artwork: { w: 2000, h: 2000 },
      sdfRes: 512,
      source: { w: 2000, h: 2000 },
    })
    expect(s.poolA - frontBytes({ w: 2000, h: 2000 })).toBe(7_405_568)
    expect(s.peak).toBe(39_405_568)
  })

  it('sizes Pool A by maxSize and Pool B by the source, and never the other way round', () => {
    const a = poolABytes({ w: 326, h: 326 }, 192)
    expect(poolABytes({ w: 326, h: 326 }, 192)).toBe(a)
    // Folding them into one pool would re-import the failure maxSize exists to delete: one 4000 px
    // asset would permanently size the stage's scratch.
    expect(poolBBytes({ w: 4000, h: 4000 })).toBeGreaterThan(a * 10)
    expect(poolABytes({ w: 326, h: 326 }, 512)).toBeGreaterThan(a)
  })

  it('stays integral at every legal sdfRes', () => {
    for (const sdfRes of [128, 192, 256, 320, 384, 448, 512]) {
      expect(Number.isInteger(fieldBytes(sdfRes))).toBe(true)
      expect(Number.isInteger(poolABytes({ w: 64, h: 64 }, sdfRes))).toBe(true)
    }
  })

  it("gives 8.1's 147 456 B cpuSdf Float32Array at 192, freed inside the call", () => {
    expect(cpuSdfBytes(192)).toBe(147_456)
  })
})
