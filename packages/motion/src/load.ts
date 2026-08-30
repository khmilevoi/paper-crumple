/**
 * Fetch one pack binary and parse it (spec 9.2, 14).
 *
 * `binUrl` is explicit and `manifest.bin` is never resolved against the manifest's own URL — the
 * spike did that, and it 404s the moment a bundler content-hashes the JSON while the field still
 * says `"2x3.bin"`. There is no `cache: 'no-store'` either: a per-bucket pack is shared by every
 * sprite in that bucket and is exactly the thing an HTTP cache should keep.
 *
 * This is a one-shot load. The concurrent-load dedupe, the refcount, and the rule that a shared
 * per-bucket fetch is never cancelled by a per-sprite `signal` are the motion slot's (spec 5.3),
 * which is why nothing here takes an `AbortSignal` and why nothing here returns `Aborted`.
 */
import { AssetError } from '@paper-crumple/core'
import type { LoadError } from '@paper-crumple/core'

import type { Pack } from './pack.js'
import { parsePack } from './pack.js'

export interface LoadPackOptions {
  /** The parsed manifest. `parsePack` is what validates it. */
  readonly manifest: unknown
  /** Where the `.bin` actually is. Never derived from `manifest.bin`. */
  readonly binUrl: string | URL
  /**
   * Injected by level-1 tests, which cannot `fetch` a `file://` URL on any current Node and have
   * no filesystem in a browser either (spec 11). Defaults to the platform `fetch`.
   */
  readonly fetch?: typeof globalThis.fetch
}

/** Fetch and parse one pack. Resolves to an `Error`; never rejects. */
export async function loadPack(o: LoadPackOptions): Promise<LoadError | Pack> {
  const url = String(o.binUrl)
  const doFetch = o.fetch ?? globalThis.fetch
  let response: Response
  try {
    response = await doFetch(url)
  } catch (cause) {
    return new AssetError(`pack: ${url}: the request failed`, { cause })
  }
  if (!response.ok) {
    return new AssetError(`pack: ${url}: HTTP ${response.status}`)
  }
  let bytes: ArrayBuffer
  try {
    bytes = await response.arrayBuffer()
  } catch (cause) {
    return new AssetError(`pack: ${url}: the body could not be read`, { cause })
  }
  // A `PackError` is already a `LoadError`, so the parser's result is returned as it stands.
  return parsePack(bytes, o.manifest)
}
