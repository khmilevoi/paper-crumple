import { PackError } from '@paper-crumple/core'
import { describe, expect, it } from 'vitest'

import { parsePack } from './pack.js'
import { readTinyBin, readTinyManifest } from '../test/fixture.js'

/** The fixture manifest with one top-level key replaced. */
function withManifest(patch: Record<string, unknown>): unknown {
  return { ...(readTinyManifest() as object), ...patch }
}

/** The fixture bytes with one little-endian u32 patched at `offset`. */
function withHeader(offset: number, value: number): ArrayBuffer {
  const bin = readTinyBin()
  new DataView(bin).setUint32(offset, value, true)
  return bin
}

function reject(bin: ArrayBuffer | ArrayBufferView, manifest: unknown, match: RegExp): void {
  const result = parsePack(bin, manifest)
  expect(PackError.is(result)).toBe(true)
  expect(result).toBeInstanceOf(Error)
  expect(String((result as Error).message)).toMatch(match)
}

describe('the header', () => {
  it('rejects bad magic', () => {
    const bin = readTinyBin()
    new Uint8Array(bin)[0] = 0x58 // 'X'
    reject(bin, readTinyManifest(), /magic/)
  })

  it('rejects a version this loader does not read', () => {
    reject(withHeader(4, 2), readTinyManifest(), /version/)
  })

  it('rejects a vertexCount that is not a square', () => {
    reject(withHeader(8, 10), readTinyManifest(), /vertexCount/)
  })

  it('rejects a grid past the UInt16 index ceiling', () => {
    reject(withHeader(8, 257 * 257), readTinyManifest(), /vertexCount/)
  })

  it('rejects an indexCount that is not 6(vertsPerSide - 1)²', () => {
    reject(withHeader(12, 25), readTinyManifest(), /indexCount/)
  })

  it('rejects a header offset the counts do not derive', () => {
    reject(withHeader(24, 108), readTinyManifest(), /indexOffset .* derive/)
    reject(withHeader(28, 156), readTinyManifest(), /frameBase .* derive/)
    reject(withHeader(20, 36), readTinyManifest(), /uvOffset .* derive/)
  })

  it('rejects a buffer shorter than the header, and one the header does not account for', () => {
    reject(new ArrayBuffer(8), readTinyManifest(), /shorter than/)
    reject(readTinyBin().slice(0, 310), readTinyManifest(), /size mismatch/)
  })

  it('rejects input that is not bytes at all', () => {
    reject('nope' as unknown as ArrayBuffer, readTinyManifest(), /ArrayBuffer/)
  })

  it('rejects a manifest that is not an object', () => {
    reject(readTinyBin(), null, /manifest object/)
    reject(readTinyBin(), 'nope', /manifest object/)
  })
})

describe('the manifest, cross-checked against the bytes', () => {
  it('rejects a vertsPerSide the header contradicts', () => {
    reject(readTinyBin(), withManifest({ vertsPerSide: 4 }), /vertsPerSide/)
  })

  it('rejects a vertexCount or indexCount the header contradicts', () => {
    reject(readTinyBin(), withManifest({ vertexCount: 16 }), /vertexCount/)
    reject(readTinyBin(), withManifest({ indexCount: 54 }), /indexCount/)
  })

  it('rejects a frameBytes that is not the real stride', () => {
    reject(readTinyBin(), withManifest({ frameBytes: 81 }), /frameBytes/)
  })

  it('rejects a binBytes that is not the real file size', () => {
    reject(readTinyBin(), withManifest({ binBytes: 321 }), /binBytes/)
  })

  it('rejects a manifest version that is not 1', () => {
    reject(readTinyBin(), withManifest({ version: 2 }), /version/)
  })

  it('rejects a missing or non-string bin, which is provenance and never a URL', () => {
    reject(readTinyBin(), withManifest({ bin: 42 }), /bin/)
  })

  it('rejects a bucket that is not a non-empty string and an aspect that is not positive', () => {
    reject(readTinyBin(), withManifest({ bucket: '' }), /bucket/)
    reject(readTinyBin(), withManifest({ aspect: 0 }), /aspect/)
  })
})

describe('the frame table', () => {
  const frames = () => (readTinyManifest() as { frames: Record<string, unknown>[] }).frames

  it('rejects a frame count the bin contradicts', () => {
    reject(readTinyBin(), withManifest({ frames: frames().slice(0, 1) }), /frame count/)
  })

  it('rejects an offset that does not point where the header implies', () => {
    const [a, b] = frames()
    reject(readTinyBin(), withManifest({ frames: [a, { ...b, offset: 999 }] }), /offset/)
  })

  it('rejects frame offsets that are not strictly increasing', () => {
    const [a, b] = frames()
    reject(readTinyBin(), withManifest({ frames: [b, a] }), /offset/)
  })

  it('rejects overlapping frame blocks', () => {
    const [a, b] = frames()
    // 236 - 84 = 152 would overlap frame 0 exactly.
    reject(readTinyBin(), withManifest({ frames: [a, { ...b, offset: 152 }] }), /offset/)
  })

  it('rejects simulation indices that do not strictly increase', () => {
    const [a, b] = frames()
    reject(readTinyBin(), withManifest({ frames: [a, { ...b, index: 0 }] }), /strictly increase/)
  })

  it('rejects an alphaFloor outside 0 to 1, and a malformed bbox', () => {
    const [a, b] = frames()
    reject(readTinyBin(), withManifest({ frames: [a, { ...b, alphaFloor: 1.5 }] }), /alphaFloor/)
    reject(readTinyBin(), withManifest({ frames: [a, { ...b, bbox: [0, 0, 0] }] }), /bbox/)
  })

  it('rejects a null frame entry as a PackError, never a thrown TypeError', () => {
    const [a] = frames()
    let result: unknown
    expect(() => {
      result = parsePack(readTinyBin(), withManifest({ frames: [a, null] }))
    }).not.toThrow()
    expect(PackError.is(result)).toBe(true)
  })
})

describe('keyFrames', () => {
  it('rejects an entry naming a frame that was not stored', () => {
    reject(readTinyBin(), withManifest({ keyFrames: [0, 5] }), /key frame 5/)
  })

  it('rejects a pose 0 that is not stored frame 0', () => {
    reject(readTinyBin(), withManifest({ keyFrames: [4, 4] }), /pose 0/)
  })

  it('rejects a decreasing list', () => {
    reject(readTinyBin(), withManifest({ keyFrames: [0, 4, 0] }), /non-decreasing/)
  })

  it('rejects an empty or missing list', () => {
    reject(readTinyBin(), withManifest({ keyFrames: [] }), /keyFrames/)
    reject(readTinyBin(), withManifest({ keyFrames: 'nope' }), /keyFrames/)
  })
})

describe('the light vector', () => {
  it('rejects a vector that is not three finite numbers, and the zero vector', () => {
    reject(readTinyBin(), withManifest({ light: [0, 1] }), /light/)
    reject(readTinyBin(), withManifest({ light: [0, 0, 0] }), /zero vector/)
  })
})

describe('forward compatibility', () => {
  it('never rejects a manifest merely for carrying keys it does not know', () => {
    const manifest = withManifest({
      sim: { anything: true, nested: { deeply: [1, 2] } },
      addedInV1_1: 'hello',
      alsoNew: null,
    })
    expect(PackError.is(parsePack(readTinyBin(), manifest))).toBe(false)
  })
})
