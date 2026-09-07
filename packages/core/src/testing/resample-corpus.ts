/**
 * The raw-byte corpus the resample comparisons run over (§7.4.1, §11).
 *
 * **Test-only source**, reachable from neither barrel, exactly like `testing/fake-timers.ts`.
 *
 * **Never a PNG.** A comparison starting from a PNG tests Chrome's decoder, its colour management
 * and its premultiply policy rather than the filter. Large sources are generated here from a
 * deterministic PRNG — raw bytes, reproducible, and no 3.8 MB blob in the repository — and one
 * small source is committed as `fixtures/resample-24x18.bin` so that §11.1's fixture mechanism
 * (`import '…?url'` then `fetch`) is exercised at least once, and so that `.gitattributes`'
 * `*.bin binary` guard has something to guard.
 *
 * The PRNG below is deliberately **not** the one `resample.test.ts` uses. That copy multiplies
 * with `*`, so once `state` approaches 2^31 the product passes 2^53 and the float mantissa
 * discards precisely the low bits `% 256` then reads: 18 of 256 possible byte values ever occur,
 * 74.8% of the corpus is 0, and the maximum is 224. Byte identity proven over that sliver is not
 * byte identity over a byte, and the accumulator's overflow headroom is never exercised at all.
 * `Math.imul` keeps the multiply in exact 32-bit arithmetic and the full range comes back. The
 * divergence is the point; the level-1 copy belongs to another plan and is reported upward.
 */
import type { ResampleSource } from '../resample.js'

/**
 * A tiny deterministic PRNG, so a corpus is reproducible without a fixture file.
 *
 * `Math.imul` and not `*`: the multiply must stay inside 32 bits, or the low bits `% 256` reads
 * are rounded away before the mask ever sees them.
 */
export function makeRandom(seed: number): () => number {
  let state = seed
  return () => {
    state = (Math.imul(state, 1103515245) + 12345) & 0x7fffffff
    return state % 256
  }
}

/**
 * Non-premultiplied, tightly packed RGBA8 (§8.7).
 *
 * Every seventh texel is fully transparent but keeps a non-zero RGB, so the `Sa = 0` branch and
 * the ratio-1 "reproduce colour under zero alpha" claim are both exercised on every pair.
 */
export function makeSource(width: number, height: number, seed: number): ResampleSource {
  const random = makeRandom(seed)
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = random()
    data[i * 4 + 1] = random()
    data[i * 4 + 2] = random()
    data[i * 4 + 3] = i % 7 === 0 ? 0 : random()
  }
  return { data, width, height }
}

/** The committed fixture's parameters. Change one and the committed bytes must be regenerated. */
export const FIXTURE_WIDTH = 24
export const FIXTURE_HEIGHT = 18
/**
 * The plan's own seed, restored. 117 was the lowest seed whose corpus contained an `0x0a` under
 * the pre-`Math.imul` generator, which emitted 18 byte values; with the full range back, the
 * plan's base seed satisfies that condition on the first try — this corpus holds six `0x0a`.
 */
export const FIXTURE_SEED = 11
export const FIXTURE_BYTES = FIXTURE_WIDTH * FIXTURE_HEIGHT * 4

/** The exact bytes `fixtures/resample-24x18.bin` holds. */
export function fixtureSource(): ResampleSource {
  return makeSource(FIXTURE_WIDTH, FIXTURE_HEIGHT, FIXTURE_SEED)
}
