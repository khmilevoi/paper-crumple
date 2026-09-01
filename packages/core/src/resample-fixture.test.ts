import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  FIXTURE_BYTES,
  FIXTURE_HEIGHT,
  FIXTURE_WIDTH,
  fixtureSource,
  makeRandom,
} from './testing/resample-corpus.js'

const committed = new Uint8Array(
  readFileSync(new URL('./testing/fixtures/resample-24x18.bin', import.meta.url)),
)

describe('the committed raw-byte fixture (§11)', () => {
  it('is raw bytes and not a PNG, which would test Chrome rather than the filter', () => {
    expect(committed.byteLength).toBe(FIXTURE_BYTES)
    expect(committed.byteLength).toBe(1728)
    // No PNG signature, no JPEG SOI, no RIFF/WEBP container.
    expect(Array.from(committed.subarray(0, 4))).not.toEqual([0x89, 0x50, 0x4e, 0x47])
  })

  it('is exactly what the documented PRNG produces, so it is regenerable and reviewable', () => {
    const generated = fixtureSource()
    expect(generated.width).toBe(FIXTURE_WIDTH)
    expect(generated.height).toBe(FIXTURE_HEIGHT)
    expect(Array.from(committed)).toEqual(Array.from(generated.data))
  })

  it('survives a Windows checkout byte for byte, which is what *.bin binary guards', () => {
    // Without the .gitattributes rule git turns every 0x0a into 0x0d0a on checkout, so the
    // length grows by one per LF byte and the exact-length assertion above is what catches it.
    // This one names the failure so the message points at .gitattributes rather than at the
    // filter: on this fixture 0x0a occurs, so a mangled checkout cannot have the right length.
    const lineFeeds = committed.filter((byte) => byte === 0x0a).length
    expect(
      lineFeeds,
      'the fixture must contain LF bytes for this guard to mean anything',
    ).toBeGreaterThan(0)
    expect(committed.byteLength, 'CRLF-mangled: check .gitattributes *.bin binary').toBe(1728)
  })
})

describe('the corpus PRNG spans the whole byte range (§11)', () => {
  it('keeps its low bits, which is the whole input space byte identity is claimed over', () => {
    // `state * 1103515245` overflows the float mantissa once `state` approaches 2^31, and the
    // bits it discards are exactly the ones `state % 256` reads. Written that way the generator
    // emits 18 of 256 possible values, 74.8% of them zero, and the byte-identity suites below
    // prove identity over that sliver rather than over a byte. `Math.imul` is the fix, and this
    // is the assertion that stops it regressing.
    const random = makeRandom(11)
    const seen = new Set<number>()
    for (let i = 0; i < 4096; i++) seen.add(random())
    expect(seen.size).toBe(256)
  })
})
