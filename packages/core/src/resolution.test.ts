import { describe, expect, it } from 'vitest'
import { SDF_RES_MAX, SDF_RES_MIN, SIZE_QUANTUM, sdfResFor, sizeForDisplay } from './resolution.js'

describe('sizeForDisplay', () => {
  it('rounds cssPx x dpr up to the next multiple of 64', () => {
    expect(sizeForDisplay({ cssPx: 320, dpr: 2, cap: 1024 })).toBe(640)
    expect(sizeForDisplay({ cssPx: 100, dpr: 1, cap: 1024 })).toBe(128)
    expect(sizeForDisplay({ cssPx: 129, dpr: 1, cap: 1024 })).toBe(192)
  })

  it('leaves an exact multiple of 64 alone', () => {
    expect(sizeForDisplay({ cssPx: 384, dpr: 1, cap: 1024 })).toBe(384)
    expect(sizeForDisplay({ cssPx: 192, dpr: 2, cap: 1024 })).toBe(384)
  })

  it('clamps to the cap, which is what makes memory a function of the product not the asset', () => {
    expect(sizeForDisplay({ cssPx: 200, dpr: 3, cap: 384 })).toBe(384)
    expect(sizeForDisplay({ cssPx: 2000, dpr: 2, cap: 384 })).toBe(384)
  })

  it('takes dpr explicitly, so a consumer can render for a screen it is not running on', () => {
    expect(sizeForDisplay({ cssPx: 160, dpr: 1, cap: 1024 })).toBe(192)
    expect(sizeForDisplay({ cssPx: 160, dpr: 3, cap: 1024 })).toBe(512)
  })

  it('always returns a multiple of 64, even for a cap that is not one', () => {
    // Both the bucket sizes of 8.6 and sdfRes of 7.4.3 assume a multiple of 64. A cap is a
    // ceiling, so it rounds down, never up.
    expect(sizeForDisplay({ cssPx: 1000, dpr: 1, cap: 100 })).toBe(64)
    expect(sizeForDisplay({ cssPx: 1000, dpr: 1, cap: 400 })).toBe(384)
    for (const cssPx of [1, 7, 63, 64, 65, 333, 999]) {
      expect(sizeForDisplay({ cssPx, dpr: 1.75, cap: 1000 }) % SIZE_QUANTUM).toBe(0)
    }
  })

  it('never returns a zero-texel front', () => {
    expect(sizeForDisplay({ cssPx: 0, dpr: 2, cap: 384 })).toBe(64)
    expect(sizeForDisplay({ cssPx: 1, dpr: 1, cap: 384 })).toBe(64)
    expect(sizeForDisplay({ cssPx: 100, dpr: 1, cap: 0 })).toBe(64)
  })
})

describe('sdfResFor', () => {
  it('is measured on the front long side, always a multiple of 64', () => {
    expect(sdfResFor(384)).toBe(192)
    expect(sdfResFor(512)).toBe(256)
    expect(sdfResFor(640)).toBe(320)
    expect(sdfResFor(256)).toBe(128)
  })

  it("gives the spike's validated 998 -> 512 pair, which the deleted formula computed as 499", () => {
    expect(sdfResFor(998)).toBe(512)
  })

  it('clamps into [128, 512]', () => {
    expect(sdfResFor(1)).toBe(SDF_RES_MIN)
    expect(sdfResFor(64)).toBe(SDF_RES_MIN)
    expect(sdfResFor(128)).toBe(SDF_RES_MIN)
    expect(sdfResFor(1024)).toBe(SDF_RES_MAX)
    expect(sdfResFor(4096)).toBe(SDF_RES_MAX)
  })

  it('reproduces the deleted clamp(maxSize / 2, 128, 512) at every grid size', () => {
    for (const maxSize of [256, 384, 512, 640, 768, 896, 1024]) {
      const old = Math.min(Math.max(maxSize / 2, SDF_RES_MIN), SDF_RES_MAX)
      expect(sdfResFor(maxSize)).toBe(old)
    }
  })

  it('is always a multiple of 64, so the field sizing laws stay integral', () => {
    for (let l = 1; l <= 2048; l += 7) expect(sdfResFor(l) % SIZE_QUANTUM).toBe(0)
  })
})
