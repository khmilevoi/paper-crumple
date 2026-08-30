/**
 * mulberry32: a small seeded PRNG, so a given seed always builds the same outline.
 *
 * The hull cache's premise depends on this: §8.2.1 keeps the cache because it is "deterministic in
 * `(key, sdfRes, hull knobs)`", and `seed` is one of those knobs.
 */
export function makeRandom(seed: number): () => number {
  let s = (Math.floor(seed) * 0x9e3779b1 + 0x85ebca6b) >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hashInt(i: number, seed: number): number {
  let x = (Math.imul(i | 0, 0x27d4eb2d) ^ Math.imul(seed | 0, 0x165667b1)) >>> 0
  x = Math.imul(x ^ (x >>> 15), 0x2c1b3c6d) >>> 0
  x = Math.imul(x ^ (x >>> 12), 0x297a2d39) >>> 0
  return ((x ^ (x >>> 15)) >>> 0) / 4294967296
}

/**
 * 1D value noise in [0, 1], smoothstep-interpolated.
 *
 * `buildHull` drifts its target distance along arc length with this rather than drawing per vertex:
 * pure per-vertex randomness is a sawtooth, while the reference cutout's distance varies over a few
 * segments. Not re-exported from the package barrel — it is `buildHull`'s implementation detail.
 */
export function noise1d(u: number, seed: number): number {
  const i = Math.floor(u)
  const f = u - i
  const t = f * f * (3 - 2 * f)
  return hashInt(i, seed) * (1 - t) + hashInt(i + 1, seed) * t
}
