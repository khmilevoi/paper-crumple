import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
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
  })

  it('imports ./packs from nowhere but src/packs itself (§3.2, §14)', () => {
    const srcDir = fileURLToPath(new URL('.', import.meta.url))
    const isTestFile = (name: string): boolean =>
      name.endsWith('.test.ts') || name.endsWith('.gl.test.ts') || name.endsWith('.test-d.ts')

    const sourceFiles = readdirSync(srcDir, { recursive: true })
      .map((entry) => String(entry).replaceAll('\\', '/'))
      .filter((entry) => entry.endsWith('.ts'))
      .filter((entry) => !entry.split('/').some((segment) => segment === 'packs'))
      .filter((entry) => !isTestFile(entry.split('/').at(-1) ?? entry))

    expect(sourceFiles.length).toBeGreaterThan(0)

    const srcDirUrl = new URL('.', import.meta.url)
    for (const relativePath of sourceFiles) {
      const contents = readFileSync(new URL(relativePath, srcDirUrl), 'utf8')
      // Catches a `from` import, a side-effect import, a dynamic `import()` and a `require`, in
      // single or double quotes, however the path to `./packs/` is spelled.
      expect(contents, `${relativePath} must not reference ./packs/`).not.toMatch(
        /['"]\.{1,2}\/packs\//,
      )
    }
  })

  it('exports no test-only helper', () => {
    expect(Object.keys(motion)).not.toContain('readTinyBin')
    expect(Object.keys(motion)).not.toContain('readTinyManifest')
  })

  it('exports no test-only harness', () => {
    expect(Object.keys(motion)).not.toContain('createGlFixture')
    expect(Object.keys(motion)).not.toContain('readPackBin')
  })
})
