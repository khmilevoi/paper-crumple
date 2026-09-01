import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as tilesModule from './tiles.js'
import { tiles } from './tiles.js'

const names = ['crumpleR', 'crumpleG', 'crumpleA', 'fibreA'] as const

describe('the tiles subpath (spec 14, amendment 23)', () => {
  it('exports a named `tiles` and never a default', () => {
    expect(tiles).toBeDefined()
    expect('default' in tilesModule).toBe(false)
  })

  it('addresses four distinct files', () => {
    const hrefs = names.map((n) => tiles[n].href)
    expect(new Set(hrefs).size).toBe(4)
  })

  it('resolves every URL against this module, so the asset ships beside it', () => {
    for (const name of names) {
      expect(tiles[name].href).toMatch(/\/tiles\/[a-z-]+\.webp$/)
    }
  })
})

describe('the baked files', () => {
  it('are on disk and are WebP', () => {
    for (const name of names) {
      const bytes = readFileSync(fileURLToPath(tiles[name]))
      expect(bytes.byteLength).toBeGreaterThan(1024)
      expect(bytes.subarray(0, 4).toString('latin1')).toBe('RIFF')
      expect(bytes.subarray(8, 12).toString('latin1')).toBe('WEBP')
    }
  })
})
