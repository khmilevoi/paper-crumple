import type { SpriteSource } from '../index.js'

/**
 * `src` changed while `spriteKey` did not is a consumer error, and the hook detects it without
 * help from the core: it keeps a `Map<spriteKey, src>` of every pair it has requested and refuses
 * a request whose key it has seen bound to a different source (§5.3).
 *
 * **A map, not the last pair.** Requesting `(a, url1)`, `(b, urlB)`, `(a, url2)` changes the key
 * at every step, so a last-pair check passes all three; the third then takes the resident-key
 * cache hit and shows `url1` while the prop says `url2`. The map costs one entry per picture this
 * component has shown and turns a silent wrong picture into a reported Error.
 *
 * It reports and does nothing else. Automatic `replace` was rejected: `replace` releases the
 * source-derived halves before rebuilding, so the front the rise would animate on is gone and the
 * animation would silently vanish.
 *
 * Comparison is by identity, and deliberately: the sources this union carries — `Blob`,
 * `ImageBitmap`, a supplier function — have no structural equality worth the name, and a `URL`
 * rebuilt per render under one key is the same defect as a changed one.
 */
export function rememberPair(
  pairs: Map<string, SpriteSource>,
  key: string,
  src: SpriteSource,
): Error | undefined {
  const seen = pairs.get(key)
  if (seen === undefined) {
    pairs.set(key, src)
    return undefined
  }
  if (Object.is(seen, src)) return undefined
  return new Error(
    `useCrumple: spriteKey '${key}' was already requested with a different src. A key names a ` +
      'PICTURE, not a slot: the hull cache is keyed on (sprite key, sdfRes, hull knobs) and the ' +
      'bitmap is not in that key, so re-pointing a key would inherit the old hull. Nothing was ' +
      'requested. Use a new spriteKey for a new picture, or re-point this one yourself with ' +
      'scene.stage.replace(key, src).',
  )
}
