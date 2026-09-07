import { describe, expect, it } from 'vitest'
import { GUARD_EPSILON_REFERENCE_PX, KNOB_REFERENCE_PX, marginFractionFor } from './overscan.js'
import {
  FRONT_LONG_SIDE_CAP,
  SDF_RES_MAX,
  SDF_RES_MIN,
  SIZE_QUANTUM,
  frontCapFor,
  sdfResFor,
  sizeForDisplay,
} from './resolution.js'

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

  it('never returns NaN, because a NaN front byte count would silently disable the front LRU eviction loop', () => {
    expect(sizeForDisplay({ cssPx: NaN, dpr: 2, cap: 384 })).toBe(64)
    expect(sizeForDisplay({ cssPx: 100, dpr: NaN, cap: 384 })).toBe(64)
    expect(sizeForDisplay({ cssPx: Infinity, dpr: 2, cap: 384 })).toBe(384)
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

  it('never returns NaN, because a NaN front byte count would silently disable the front LRU eviction loop', () => {
    expect(sdfResFor(NaN)).toBe(SDF_RES_MIN)
    expect(sdfResFor(Infinity)).toBe(SDF_RES_MAX)
  })
})

describe('FRONT_LONG_SIDE_CAP and frontCapFor', () => {
  it('is 2048 texels — WebGL2s guaranteed MAX_TEXTURE_SIZE floor', () => {
    expect(FRONT_LONG_SIDE_CAP).toBe(2048)
  })

  it('sizes the front so artworkLongSide artwork texels fit for every aspect, rounded to 64', () => {
    // design 2026-09-05 §4.2: the front cap now reserves paint plus the guard band
    // (`marginFractionFor`), not paint alone, so these are larger than the pre-§4.2 figures.
    expect(frontCapFor({ artworkLongSide: 540, overscan: 0.13291, cap: 2048 })).toBe(768)
    expect(frontCapFor({ artworkLongSide: 540, overscan: 0.08, cap: 2048 })).toBe(704)
    expect(frontCapFor({ artworkLongSide: 2000, overscan: 0.1, cap: 2048 })).toBe(2048)
  })

  it('lands on cap, not the floor, for a non-finite overscan (a sheet whose reserve failed to derive)', () => {
    expect(frontCapFor({ artworkLongSide: 100, overscan: Infinity, cap: 2048 })).toBe(2048)
    expect(frontCapFor({ artworkLongSide: 100, overscan: Number.NaN, cap: 2048 })).toBe(2048)
  })

  it('requests enough front for the sheet to actually deliver artworkLongSide texels (the sheet needs A + 2*ceil(A*(marginFractionFor(p)+eps)), not ceil(A*(1+2p)))', () => {
    // p = 105/790, A = 151: ceil(A*(1+2p)) = 192, which the pre-§4.2 `frontForArtwork` could only
    // fill with 150 artwork texels on a portrait or square sprite (2*ceil(x) - ceil(2x) can be 1,
    // and rounding up to a multiple of 64 does not always absorb it). The off-by-one-texel
    // structural bug this pins predates design §4.2's guard margin and survives it unchanged —
    // 256 (the smallest 64-multiple above 193) is still what `guardMarginsFor`'s larger margin
    // (design 2026-09-05 §4.2) requests here too, so the figure is unchanged even though the
    // margin itself is now bigger than plain paint.
    const overscan = 105 / 790
    expect(frontCapFor({ artworkLongSide: 151, overscan, cap: 2048 })).toBe(256)
  })

  it('sizes the front cap over the guard margin too (design 2026-09-05 §4.2)', () => {
    const p = 0.132731
    const a = 640
    const eps = GUARD_EPSILON_REFERENCE_PX / KNOB_REFERENCE_PX
    const wanted = a + 2 * Math.ceil(a * (marginFractionFor(p) + eps))
    expect(frontCapFor({ artworkLongSide: a, overscan: p, cap: 4096 })).toBe(
      SIZE_QUANTUM * Math.ceil(wanted / SIZE_QUANTUM),
    )
  })
})
