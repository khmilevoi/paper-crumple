import { describe, expect, it } from 'vitest'

import * as motion from './index.js'

describe('the @paper-crumple/motion barrel', () => {
  it('exports the format tooling spec 3.2 puts on the root subpath', () => {
    expect(Object.keys(motion).sort()).toEqual(
      [
        'BUCKETS',
        'HEADER_BYTES',
        'MAGIC',
        'MAX_STRETCH',
        'MAX_VERTS_PER_SIDE',
        'STRETCH_TOLERANCE',
        'VERSION',
        'align4',
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

  it('exports no test-only helper', () => {
    expect(Object.keys(motion)).not.toContain('readTinyBin')
    expect(Object.keys(motion)).not.toContain('readTinyManifest')
  })
})
