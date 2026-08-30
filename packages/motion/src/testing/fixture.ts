/**
 * Test-only access to the committed CRMP fixture (spec 9.2, 11).
 *
 * **Level-1 tests cannot `fetch` a `file://` URL at all** — undici implements no `file:` scheme
 * on any current Node, and a browser has no filesystem either — so the fixture is read through
 * `node:fs` and its bytes are injected into `parsePack`. This file is never a tsdown entry and
 * `files: ["dist"]` keeps it out of the tarball; nothing under `src/` outside `testing/` may
 * import it.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** `bake/pack.py --fixture` writes exactly this many bytes. */
export const TINY_BIN_BYTES = 320
/** `json.dumps(..., sort_keys=True, indent=1) + '\n'`, LF, exactly this many bytes. */
export const TINY_JSON_BYTES = 653

const FIXTURES = new URL('../../test/fixtures/', import.meta.url)

function read(name: string): Uint8Array<ArrayBuffer> {
  // A Buffer from readFileSync is a view into a pooled ArrayBuffer, so `.buffer` is the whole
  // 64 KB pool at some arbitrary byteOffset. Copy into an ArrayBuffer of exactly this file's
  // length, or every offset the parser derives lands in the wrong place.
  const buffer = readFileSync(fileURLToPath(new URL(name, FIXTURES)))
  const copy = new Uint8Array(buffer.byteLength)
  copy.set(buffer)
  return copy
}

/** The fixture binary, as its own tightly fitting `ArrayBuffer`. */
export function readTinyBin(): ArrayBuffer {
  return read('tiny.bin').buffer
}

/** The raw manifest bytes, for the assertions about size and line endings. */
export function readTinyJsonBytes(): Uint8Array {
  return read('tiny.json')
}

/** The parsed manifest. `unknown`, because `parsePack` is what narrows it. */
export function readTinyManifest(): unknown {
  return JSON.parse(new TextDecoder().decode(readTinyJsonBytes())) as unknown
}
