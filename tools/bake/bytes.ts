/** Comparing two packs, without dumping 539 KB into a test report. */

/**
 * The index of the first byte at which `a` and `b` differ, or `-1` when they are equal. A
 * length mismatch reports the length of the shorter one, which is where the difference starts.
 */
export function firstDifference(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i
  return a.length === b.length ? -1 : n
}
