/**
 * §4.1 — **the key also selects the fold preset.** "A grid must not fold in unison" depends on
 * this, and changing a key changes the visible animation.
 *
 * §5.3 says the core cannot mint a *variant name*, because `MotionFit` is opaque to it. Both
 * hold at once if the core mints a **stable, opaque token** and the slot maps it onto its own
 * preset space. The stage passes this token as `motion.fit(rect, override)`'s second argument on
 * every fit.
 *
 * **The contract clause this puts on a `MotionSource`:** a slot maps an unrecognised `override`
 * deterministically onto one of its own presets and does **not** error on it. A slot that
 * returned a `MotionError` for a token it did not author would make every sprite unfittable.
 *
 * FNV-1a over UTF-16 code units, rendered as eight lowercase hex digits. Not a security hash and
 * not stable across a change to this function — it selects an animation, and the only property
 * that matters is that two different keys usually get different tokens.
 */
export function presetForImageId(key: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i)
    // The FNV prime, 16777619, by shift-and-add: `hash * 16777619` overflows a double's exact
    // integer range and Math.imul does not.
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}
