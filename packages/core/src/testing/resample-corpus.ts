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
 * The PRNG is the one `resample.test.ts` already uses, so the GPU comparison runs over the same
 * corpus shape the reference's own level-1 suite does.
 */
import type { ResampleSource } from '../resample.js'

/** A tiny deterministic PRNG, so a corpus is reproducible without a fixture file. */
export function makeRandom(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff
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
export const FIXTURE_SEED = 117
export const FIXTURE_BYTES = FIXTURE_WIDTH * FIXTURE_HEIGHT * 4

/** The exact bytes `fixtures/resample-24x18.bin` holds. */
export function fixtureSource(): ResampleSource {
  return makeSource(FIXTURE_WIDTH, FIXTURE_HEIGHT, FIXTURE_SEED)
}
