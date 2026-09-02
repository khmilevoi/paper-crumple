import { gunzipSync } from 'node:zlib'

const BLOCK = 512

/**
 * @typedef {object} TarEntry
 * @property {string} name Full path as stored in the archive, e.g. `package/dist/index.js`.
 * @property {number} size Size in bytes.
 * @property {Buffer} data The file's bytes.
 */

/**
 * Reads a gzipped POSIX ustar archive. npm and pnpm both emit plain ustar with the `prefix` field
 * for long paths and no PAX extensions, which is why thirty lines here beat a dependency: a
 * packaging gate that needs a package installed to check packaging is one supply-chain hop away
 * from checking nothing.
 *
 * @param {Buffer} gzip the raw `.tgz` bytes
 * @returns {TarEntry[]} every regular file, in archive order
 */
export function readTarEntries(gzip) {
  const tar = gunzipSync(gzip)
  /** @type {TarEntry[]} */
  const entries = []
  let offset = 0

  while (offset + BLOCK <= tar.length) {
    const head = tar.subarray(offset, offset + BLOCK)
    // A zero block ends the archive; everything after it is padding.
    if (head.every((byte) => byte === 0)) break

    const name = field(head, 0, 100)
    const prefix = field(head, 345, 155)
    const size = Number.parseInt(field(head, 124, 12).trim() || '0', 8)
    const typeFlag = field(head, 156, 1)

    offset += BLOCK
    const data = tar.subarray(offset, offset + size)
    offset += Math.ceil(size / BLOCK) * BLOCK

    // '0' is a regular file and '' is the pre-POSIX spelling of the same thing. Directories ('5'),
    // long-name extensions ('L') and PAX records ('x', 'g') are not files and are dropped.
    if (typeFlag === '0' || typeFlag === '') {
      entries.push({ name: prefix === '' ? name : `${prefix}/${name}`, size, data })
    }
  }

  return entries
}

/**
 * @param {Buffer} block
 * @param {number} start
 * @param {number} length
 * @returns {string} the NUL-terminated string in that header field
 */
function field(block, start, length) {
  const raw = block.subarray(start, start + length)
  const end = raw.indexOf(0)
  return raw.toString('utf8', 0, end === -1 ? raw.length : end)
}
