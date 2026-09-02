import { describe, expect, it } from 'vitest'

import { PACK_BIN_BYTES, readPackBin } from '../test/packs.js'
import { BUCKETS } from './buckets.js'
import type { Pack } from './pack.js'
import { parsePack } from './pack.js'
import pack1x1, { manifest as manifest1x1, sim as sim1x1 } from './packs/1x1.js'
import pack2x3, { manifest as manifest2x3, sim as sim2x3 } from './packs/2x3.js'
import pack3x2, { manifest as manifest3x2, sim as sim3x2 } from './packs/3x2.js'
import type { PackModule } from './pack-module.js'

const MODULES: readonly [PackModule, Record<string, unknown>][] = [
  [pack2x3, sim2x3],
  [pack1x1, sim1x1],
  [pack3x2, sim3x2],
]

function parse(m: PackModule): Pack {
  const p = parsePack(readPackBin(m.bucket), m.manifest)
  expect(p).not.toBeInstanceOf(Error)
  return p as Pack
}

describe('the three shipped pack modules (§3.2, §14)', () => {
  it('is one module per bucket, in the order BUCKETS fixes', () => {
    expect(MODULES.map(([m]) => m.bucket)).toEqual(BUCKETS.map((b) => b.id))
  })

  it('names its binary beside itself, never through a template literal', () => {
    for (const [m] of MODULES) {
      expect(m.binUrl).toBeInstanceOf(URL)
      expect(m.binUrl.pathname.endsWith(`/packs/${m.bucket}.bin`)).toBe(true)
    }
  })

  it('inlines a manifest whose bucket agrees with the module', () => {
    expect(manifest2x3.bucket).toBe('2x3')
    expect(manifest1x1.bucket).toBe('1x1')
    expect(manifest3x2.bucket).toBe('3x2')
    for (const [m] of MODULES) expect(m.manifest.bucket).toBe(m.bucket)
  })

  it('keeps sim out of the manifest so it tree-shakes to zero (§9.1)', () => {
    for (const [m, sim] of MODULES) {
      expect('sim' in m.manifest).toBe(false)
      expect(sim).toHaveProperty('stage1End')
      expect(sim).toHaveProperty('blender')
    }
  })

  it('is compact: the manifest without sim is under 1600 B, sim under 700 B (§9.1)', () => {
    for (const [m, sim] of MODULES) {
      expect(JSON.stringify(m.manifest).length).toBeLessThan(1600)
      expect(JSON.stringify(sim).length).toBeLessThan(700)
    }
  })
})

describe('the shipped binaries', () => {
  it('is 539 320 B per bucket, which is what the manifest claims', () => {
    for (const [m] of MODULES) {
      expect(readPackBin(m.bucket).byteLength).toBe(PACK_BIN_BYTES)
      expect(m.manifest.binBytes).toBe(PACK_BIN_BYTES)
    }
  })

  it('parses, with the header the manifest cross-checks against (§9, §9.2)', () => {
    for (const [m] of MODULES) {
      const pack = parse(m)
      expect(pack.vertsPerSide).toBe(65)
      expect(pack.vertexCount).toBe(4225)
      expect(pack.indexCount).toBe(24576)
      expect(pack.frameCount).toBe(12)
      expect(pack.layout.bytes).toBe(38028)
      expect(pack.uvs).toHaveLength(2 * 4225)
      expect(pack.indices).toHaveLength(24576)
    }
  })

  it('resolves keyFrames as SIMULATION indices onto stored slots (§9.1)', () => {
    for (const [m] of MODULES) {
      // The manifest says [0, 8, 16, 24, 32, 44] against twelve frames whose index values are
      // 0, 4, 8 … 44. An implementer reading them as slots indexes frames[44] and gets undefined.
      expect(m.manifest.keyFrames).toEqual([0, 8, 16, 24, 32, 44])
      expect(parse(m).keyFrames).toEqual([0, 2, 4, 6, 8, 11])
    }
  })

  it('carries the compaction ramp §9.1 measured, ending at exactly 1', () => {
    for (const [m] of MODULES) {
      const floors = parse(m).frames.map((f) => f.alphaFloor)
      expect(floors).toEqual([0, 0, 0, 0, 0, 0, 0.0741, 0.2593, 0.5, 0.7407, 0.9259, 1])
      // Pose 5 at floor exactly 1 is what makes the ball carry no sprite identity at all (§4.2).
      expect(floors[parse(m).keyFrames[5]]).toBe(1)
      expect(parse(m).keyFrames.map((s) => floors[s])).toEqual([0, 0, 0, 0.0741, 0.5, 1])
    }
  })

  it('is pose 0 at stored frame 0 — the untouched sprite (§9.1)', () => {
    for (const [m] of MODULES) {
      const pack = parse(m)
      expect(pack.keyFrames[0]).toBe(0)
      expect(pack.frames[0].index).toBe(0)
      expect(pack.frames[0].alphaFloor).toBe(0)
    }
  })

  it('carries one unit light vector, the same in all three (§6.2, §9.3)', () => {
    for (const [m] of MODULES) {
      // The manifest field itself is copied verbatim into every generated pack module
      // (packs/*.ts) with no transform, so exact equality here is achievable and catches a
      // 5th-decimal manifest drift a `toBeCloseTo(..., 4)` tolerance would hide.
      expect(m.manifest.light).toEqual([-0.39993, 0.5499, 0.73325])
      // `parsePack` then normalizes this vector (`pack.ts`: `light: [lx / ll, ly / ll, lz /
      // ll]`), so the *parsed* light is legitimately approximate and checked separately.
      const light = parse(m).light
      expect(light[0]).toBeCloseTo(-0.39993, 4)
      expect(light[1]).toBeCloseTo(0.5499, 4)
      expect(light[2]).toBeCloseTo(0.73325, 4)
      expect(Math.hypot(...light)).toBeCloseTo(1, 4)
    }
  })
})
