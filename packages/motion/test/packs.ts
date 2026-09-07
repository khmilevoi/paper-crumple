/**
 * Test-only access to the three shipped pack binaries (§9, §11).
 *
 * **Level-1 tests cannot `fetch` a `file://` URL at all** — undici implements no `file:` scheme on
 * any current Node — so the binaries are read through `node:fs` and injected into `parsePack`.
 * The level-2 tier fetches them through `PackModule.binUrl` instead, which is what exercises the
 * `new URL(…, import.meta.url)` design the packaging depends on.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Every shipped bucket is exactly this size (§9). */
export const PACK_BIN_BYTES = 539_320

const PACKS = new URL('../src/packs/', import.meta.url)

/** One shipped binary, as its own tightly fitting `ArrayBuffer`. */
export function readPackBin(bucket: string): ArrayBuffer {
  // A Buffer from readFileSync is a view into a pooled ArrayBuffer, so `.buffer` is the whole
  // 64 KB pool at some arbitrary byteOffset. Copy into an ArrayBuffer of exactly this file's
  // length, or every offset the parser derives lands in the wrong place.
  const buffer = readFileSync(fileURLToPath(new URL(`${bucket}.bin`, PACKS)))
  const copy: Uint8Array<ArrayBuffer> = new Uint8Array(buffer.byteLength)
  copy.set(buffer)
  return copy.buffer
}
