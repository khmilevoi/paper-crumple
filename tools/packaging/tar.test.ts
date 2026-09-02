import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { readTarEntries } from './tar.mjs'

/**
 * A POSIX ustar header. `readTarEntries` does not verify the checksum, so the checksum field is
 * left as the eight spaces an unfilled header carries.
 */
function header(name: string, size: number, typeFlag = '0', prefix = ''): Buffer {
  const block = Buffer.alloc(512)
  block.write(name, 0, 100, 'utf8')
  block.write('000644 \0', 100, 8, 'utf8')
  block.write(`${size.toString(8).padStart(11, '0')} `, 124, 12, 'utf8')
  block.write('        ', 148, 8, 'utf8')
  block.write(typeFlag, 156, 1, 'utf8')
  block.write('ustar\0', 257, 6, 'utf8')
  block.write('00', 263, 2, 'utf8')
  block.write(prefix, 345, 155, 'utf8')
  return block
}

function body(text: string): Buffer {
  const raw = Buffer.from(text, 'utf8')
  const padded = Buffer.alloc(Math.ceil(raw.length / 512) * 512)
  raw.copy(padded)
  return padded
}

describe('readTarEntries', () => {
  it('reads names, sizes and bytes of regular files', () => {
    const tar = Buffer.concat([
      header('package/package.json', 2),
      body('{}'),
      header('package/dist/index.js', 5),
      body('hello'),
      Buffer.alloc(1024),
    ])

    const entries = readTarEntries(gzipSync(tar))

    expect(entries.map((e) => e.name)).toEqual(['package/package.json', 'package/dist/index.js'])
    expect(entries[0]!.size).toBe(2)
    expect(entries[1]!.data.toString('utf8')).toBe('hello')
  })

  it('joins the ustar prefix field, which npm uses for long paths', () => {
    const tar = Buffer.concat([
      header('fibre-a.webp', 4, '0', 'package/dist/tiles'),
      body('RIFF'),
      Buffer.alloc(1024),
    ])

    expect(readTarEntries(gzipSync(tar))[0]!.name).toBe('package/dist/tiles/fibre-a.webp')
  })

  it('skips directory entries and anything that is not a regular file', () => {
    const tar = Buffer.concat([
      header('package/dist/', 0, '5'),
      header('package/dist/index.js', 1),
      body('x'),
      Buffer.alloc(1024),
    ])

    expect(readTarEntries(gzipSync(tar)).map((e) => e.name)).toEqual(['package/dist/index.js'])
  })

  it('stops at the end-of-archive block rather than reading padding as entries', () => {
    const tar = Buffer.concat([header('package/a', 1), body('x'), Buffer.alloc(4096)])

    expect(readTarEntries(gzipSync(tar))).toHaveLength(1)
  })
})
