import type { PackError } from '@paper-crumple/core'
import { describe, expectTypeOf, it } from 'vitest'

import type { Pack } from './index.js'
import { parsePack } from './index.js'

declare const bytes: ArrayBuffer
declare const view: Uint8Array
declare const manifest: unknown

describe('parsePack', () => {
  it('returns a union a caller cannot use without narrowing', () => {
    expectTypeOf(parsePack(bytes, manifest)).toEqualTypeOf<InstanceType<typeof PackError> | Pack>()
  })

  it('refuses a result assigned straight to Pack, which is the forgotten check', () => {
    // @ts-expect-error the error arm is not assignable to Pack (spec 10, 11)
    const pack: Pack = parsePack(bytes, manifest)
    void pack
  })

  it('accepts an ArrayBufferView as well, which is what the injected-bytes path needs', () => {
    expectTypeOf(parsePack(view, manifest)).toEqualTypeOf<InstanceType<typeof PackError> | Pack>()
  })
})
