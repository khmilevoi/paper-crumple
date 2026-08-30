import { PackError } from '@paper-crumple/core'
import { describe, expect, it } from 'vitest'

import type { Pack } from './pack.js'
import { decodeFrame, frameBytes, parsePack, setKeyFrames } from './pack.js'
import { readTinyBin, readTinyManifest } from './testing/fixture.js'

/**
 * A cast and not a `throw`: ESLint bans every `ThrowStatement` in this repository, tests
 * included, and the preceding `expect` is what actually fails if the fixture stops parsing.
 */
function parseFixture(): Pack {
  const pack = parsePack(readTinyBin(), readTinyManifest())
  expect(pack).not.toBeInstanceOf(Error)
  return pack as Pack
}

describe('parsePack against the committed fixture', () => {
  it('reads the header the writer wrote', () => {
    const pack = parseFixture()
    expect(pack.vertsPerSide).toBe(3)
    expect(pack.vertexCount).toBe(9)
    expect(pack.indexCount).toBe(24)
    expect(pack.frameCount).toBe(2)
    expect(pack.layout).toEqual({ positions: 0, normals: 54, ao: 72, bytes: 84 })
    expect(pack.bucket).toBe('tiny')
    expect(pack.aspect).toBe(1)
  })

  it('exposes the UV and index blocks as typed views over the same buffer', () => {
    const pack = parseFixture()
    expect(pack.uvs.length).toBe(18)
    expect(Array.from(pack.uvs.slice(0, 4))).toEqual([0, 0, 0.5, 0])
    expect(pack.indices.length).toBe(24)
    // Two CCW triangles per quad, a = row * 3 + col.
    expect(Array.from(pack.indices.slice(0, 6))).toEqual([0, 1, 4, 0, 4, 3])
    expect(pack.uvs.buffer).toBe(pack.buffer)
    expect(pack.indices.buffer).toBe(pack.buffer)
  })

  it('resolves keyFrames from simulation indices to stored slots', () => {
    const pack = parseFixture()
    expect(pack.frames.map((f) => f.index)).toEqual([0, 4])
    // The manifest says [0, 4]; frames[4] does not exist, frames[1] is the frame whose index is 4.
    expect(pack.keyFrames).toEqual([0, 1])
  })

  it('normalises the light vector', () => {
    const pack = parseFixture()
    expect(Math.abs(Math.hypot(...pack.light) - 1)).toBeLessThan(1e-9)
    expect(pack.light[2]).toBeGreaterThan(0)
  })

  it('carries the per-frame metadata the compaction ramp needs', () => {
    const pack = parseFixture()
    expect(pack.frames[0]).toMatchObject({
      index: 0,
      alphaFloor: 0,
      byteOffset: 152,
      byteLength: 84,
    })
    expect(pack.frames[1]).toMatchObject({
      index: 4,
      alphaFloor: 1,
      byteOffset: 236,
      byteLength: 84,
    })
    expect(pack.frames[0]!.bbox).toEqual([-1, -1, 0, 1, 1, 0])
  })

  it('keeps the whole manifest, unknown keys included, so sim stays reachable', () => {
    const pack = parseFixture()
    expect(pack.manifest.sim).toMatchObject({ stage1End: 4 })
  })

  it('tolerates a manifest key it has never heard of', () => {
    const manifest = { ...(readTinyManifest() as object), somethingAddedInV1_1: [1, 2, 3] }
    expect(PackError.is(parsePack(readTinyBin(), manifest))).toBe(false)
  })

  it('accepts a Uint8Array view into a larger buffer, not only a tight ArrayBuffer', () => {
    const tight = new Uint8Array(readTinyBin())
    const pool = new Uint8Array(4096)
    pool.set(tight, 753) // deliberately odd, as a pooled Buffer would be
    const view = new Uint8Array(pool.buffer, 753, tight.byteLength)
    const pack = parsePack(view, readTinyManifest())
    expect(PackError.is(pack)).toBe(false)
    if (PackError.is(pack)) return
    expect(Array.from(pack.indices.slice(0, 6))).toEqual([0, 1, 4, 0, 4, 3])
    expect(pack.buffer.byteLength).toBe(320)
  })
})

describe('frameBytes', () => {
  it('is the raw block, ready for bufferSubData', () => {
    const pack = parseFixture()
    const bytes = frameBytes(pack, 1)
    expect(PackError.is(bytes)).toBe(false)
    if (PackError.is(bytes)) return
    expect(bytes.byteLength).toBe(84)
    expect(bytes.byteOffset).toBe(236)
    expect(bytes.buffer).toBe(pack.buffer)
  })

  it('returns a PackError for a slot that does not exist, rather than throwing', () => {
    const pack = parseFixture()
    expect(PackError.is(frameBytes(pack, 2))).toBe(true)
    expect(PackError.is(frameBytes(pack, -1))).toBe(true)
    expect(PackError.is(frameBytes(pack, 1.5))).toBe(true)
  })
})

describe('decodeFrame', () => {
  it('decodes the flat frame exactly', () => {
    const pack = parseFixture()
    const f = decodeFrame(pack, 0)
    expect(PackError.is(f)).toBe(false)
    if (PackError.is(f)) return
    expect(Array.from(f.positions.slice(0, 6))).toEqual([-1, -1, 0, 0, -1, 0])
    expect(Array.from(f.normals.slice(0, 3))).toEqual([0, 0, 1])
    expect(Array.from(f.ao)).toEqual(new Array<number>(9).fill(1))
  })

  it('decodes the tilted frame within the codecs’ precision', () => {
    const pack = parseFixture()
    const f = decodeFrame(pack, 1)
    expect(PackError.is(f)).toBe(false)
    if (PackError.is(f)) return
    const l = Math.hypot(0.25, 1)
    for (let i = 0; i < 9; i++) {
      // The frame is the plane z = 0.25x.
      expect(Math.abs(f.positions[3 * i + 2]! - 0.25 * f.positions[3 * i]!)).toBeLessThan(2e-3)
      const dot = f.normals[3 * i]! * (-0.25 / l) + f.normals[3 * i + 2]! * (1 / l)
      expect(dot).toBeGreaterThan(0.999)
      expect(Math.abs(f.ao[i]! - i / 8)).toBeLessThanOrEqual(1 / 255)
    }
  })

  it('returns a PackError for a slot that does not exist', () => {
    expect(PackError.is(decodeFrame(parseFixture(), 9))).toBe(true)
  })
})

describe('setKeyFrames', () => {
  it('accepts a list that starts at stored frame 0 and never decreases', () => {
    expect(setKeyFrames([0, 2, 4, 6, 8, 11], 12)).toEqual([0, 2, 4, 6, 8, 11])
    expect(setKeyFrames([0, 0, 0], 12)).toEqual([0, 0, 0]) // non-decreasing, not increasing
  })

  it('rejects a list whose pose 0 is not stored frame 0 — the untouched sprite', () => {
    const e = setKeyFrames([1, 2, 3], 12)
    expect(PackError.is(e)).toBe(true)
    expect(String(e)).toMatch(/pose 0/)
  })

  it('rejects a decreasing list', () => {
    expect(PackError.is(setKeyFrames([0, 4, 2], 12))).toBe(true)
  })

  it('rejects a non-integer, an out-of-range slot and an empty list', () => {
    expect(PackError.is(setKeyFrames([0, 2.5], 12))).toBe(true)
    expect(PackError.is(setKeyFrames([0, 12], 12))).toBe(true)
    expect(PackError.is(setKeyFrames([], 12))).toBe(true)
  })
})
