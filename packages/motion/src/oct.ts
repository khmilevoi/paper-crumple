/**
 * Octahedral unit-vector encoding into two signed bytes; the mirror of `encode_oct` /
 * `decode_oct` in `bake/pack.py` (spec 9). +Z is (0, 0); the lower hemisphere folds into the
 * corners, so -Z is (127, 127).
 */
import { PackError } from '@paper-crumple/core'

/**
 * `floor(v * 127 + 0.5)`, clamped to the signed range. Python's `round()` is half-to-even and
 * this deliberately is not — `pack.py` spells the same expression out with `math.floor` so the
 * two sides agree byte for byte.
 */
export function snorm8(v: number): number {
  return Math.max(-127, Math.min(127, Math.floor(v * 127 + 0.5)))
}

/**
 * A unit normal to its two stored bytes. A non-finite component — a NaN out of an unguarded
 * `sqrt` upstream — returns a `PackError` rather than encoding garbage into a pack that would
 * then parse cleanly and shade wrongly.
 */
export function encodeOct(
  n: readonly [number, number, number],
): InstanceType<typeof PackError> | [number, number] {
  const [x, y, z] = n
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    return new PackError(`encodeOct: non-finite normal [${String(x)}, ${String(y)}, ${String(z)}]`)
  }
  const l = Math.abs(x) + Math.abs(y) + Math.abs(z)
  if (l === 0) return [0, 0]
  let ox = x / l
  let oy = y / l
  if (z < 0) {
    const tx = (1 - Math.abs(oy)) * (ox >= 0 ? 1 : -1)
    const ty = (1 - Math.abs(ox)) * (oy >= 0 ? 1 : -1)
    ox = tx
    oy = ty
  }
  return [snorm8(ox), snorm8(oy)]
}

/** Two stored bytes back to a unit normal. */
export function decodeOct(a: number, b: number): [number, number, number] {
  let x = a / 127
  let y = b / 127
  const z = 1 - Math.abs(x) - Math.abs(y)
  if (z < 0) {
    const tx = (1 - Math.abs(y)) * (x >= 0 ? 1 : -1)
    const ty = (1 - Math.abs(x)) * (y >= 0 ? 1 : -1)
    x = tx
    y = ty
  }
  const l = Math.hypot(x, y, z)
  return [x / l, y / l, z / l]
}
