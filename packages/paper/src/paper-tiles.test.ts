import { describe, expect, it } from 'vitest'
import { NEUTRAL_TILE_BYTE, tiltFromPlane, detailFromPlane } from './paper-tiles.js'

/** The spike's 1x1 fallback texel, and what Chromium's premultiply makes of it (spec 14.1). */
const SPIKE_TEXEL = [128, 128, 255, 128] as const
const spikePremultiplied = Math.round((SPIKE_TEXEL[0] * SPIKE_TEXEL[3]) / 255)

describe('the neutral fallback, re-derived (spec 14.1)', () => {
  it('is the byte nearest 0.5, because every consumer is centred on 0.5', () => {
    expect(NEUTRAL_TILE_BYTE).toBe(128)
    expect(NEUTRAL_TILE_BYTE / 255).toBeCloseTo(0.5, 2)
  })

  it('leaves the normal essentially flat', () => {
    expect(Math.abs(tiltFromPlane(NEUTRAL_TILE_BYTE))).toBeLessThan(0.005)
  })

  it('contributes no detail and no grain', () => {
    expect(Math.abs(detailFromPlane(NEUTRAL_TILE_BYTE))).toBeLessThan(0.005)
  })

  it("is not the spike's constant, which reads as a (-0.5, -0.5) tilt once premultiplied", () => {
    expect(spikePremultiplied).toBe(64)
    expect(tiltFromPlane(spikePremultiplied)).toBeCloseTo(-0.498, 3)
    expect(NEUTRAL_TILE_BYTE).not.toBe(spikePremultiplied)
  })

  it('is 127x flatter than the value it replaces', () => {
    const spike = Math.abs(tiltFromPlane(spikePremultiplied))
    const ours = Math.abs(tiltFromPlane(NEUTRAL_TILE_BYTE))
    expect(spike / ours).toBeGreaterThan(100)
  })

  it('is the best an 8-bit plane admits: 127 is exactly as far the other way', () => {
    expect(Math.abs(tiltFromPlane(127))).toBeCloseTo(Math.abs(tiltFromPlane(128)), 6)
  })
})
