/**
 * The files permitted to use `throw` (spec §10.8).
 *
 * Everything above a boundary returns an Error rather than throwing one. The boundaries that
 * must throw — `compile()`, `createTarget()`, `fetch` / `createImageBitmap` / `decodeAudioData`,
 * `new Float32Array(buffer, offset, len)` on a bad or detached buffer, `JSON.parse` of a
 * manifest, `texStorage2D` and any allocation that can fail on GPU OOM — are wrapped by the
 * named helpers, and those helper files are listed here.
 *
 * P2 owns the helpers and fills this array. It is the only file that needs to change to permit
 * a throw; `eslint.config.js` does not.
 *
 * Entries are ESLint flat-config `files` globs, relative to the repository root.
 *
 * @type {string[]}
 */
export const boundaryFiles = [
  // §10.7: `unwrap` / `unwrapAsync` are the consumer-side conversion, and the one place an
  // abort has to become a throw. Nothing else in @paper-crumple/core throws.
  'packages/core/src/unwrap.ts',
]
