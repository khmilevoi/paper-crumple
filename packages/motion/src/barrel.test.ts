import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import * as motion from './index.js'

describe('the @paper-crumple/motion barrel', () => {
  it('exports the format tooling spec 3.2 puts on the root subpath', () => {
    expect(Object.keys(motion).sort()).toEqual(
      [
        'ATTR',
        'BUCKETS',
        'DEBUG_VIEWS',
        'FIBRE_TILE_PX',
        'HEADER_BYTES',
        'MAGIC',
        'MAX_STRETCH',
        'MAX_VERTS_PER_SIDE',
        'MOTION_KNOBS',
        'SHEET_FS',
        'SHEET_VS',
        'STRETCH_TOLERANCE',
        'VERSION',
        'align4',
        'bakedMotion',
        'createPackStore',
        'createSheetMesh',
        'decodeFrame',
        'decodeOct',
        'encodeOct',
        'fitSheet',
        'frameBytes',
        'frameLayout',
        'fromHalf',
        'loadPack',
        'packOffsets',
        'parsePack',
        'pickBucket',
        'setKeyFrames',
        'snorm8',
        'toHalf',
      ].sort(),
    )
  })

  it('exports no pack: the main entry must not import ./packs at all (§3.2, §14)', async () => {
    const source = await import('./index.js')
    for (const key of Object.keys(source)) {
      expect(key).not.toMatch(/^pack(2x3|1x1|3x2)$/)
    }
    // The three modules are reachable only through their own subpaths.
    const barrel = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
    expect(barrel).not.toContain('./packs/')
  })

  it('exports no test-only harness', () => {
    expect(Object.keys(motion)).not.toContain('createGlFixture')
    expect(Object.keys(motion)).not.toContain('readPackBin')
  })
})
