import { expectTypeOf, test } from 'vitest'
import type { BitmapSupplier, PinFor, PinnedSource, SpriteSource } from './index.js'

test('the stable barrel publishes the four names the add signature is written in', () => {
  expectTypeOf<PinnedSource>().toEqualTypeOf<ImageBitmap | HTMLImageElement | HTMLCanvasElement>()
  expectTypeOf<SpriteSource>().toEqualTypeOf<
    string | URL | Blob | ImageBitmap | HTMLImageElement | HTMLCanvasElement | BitmapSupplier
  >()
  expectTypeOf<BitmapSupplier>().toEqualTypeOf<() => Promise<ImageBitmap | Error>>()
  expectTypeOf<PinFor<ImageBitmap>>().toEqualTypeOf<{ pin: true }>()
  expectTypeOf<PinFor<string>>().toEqualTypeOf<{ pin?: true }>()
})

/**
 * The machinery stays inside the package. P9 imports `./source.js`, as it imports `./front-lru.js`.
 * Only the runtime exports are named: `keyof` a module namespace covers values, and everything this
 * plan publishes is a type, so a value of any of these names in a barrel is the whole error class.
 */
type PublishedFrom<M> = Extract<
  keyof M,
  'normalizeSource' | 'classifySource' | 'staleSourceWarning'
>

test('it publishes nothing else from this plan: the machinery is imported by relative path', () => {
  expectTypeOf<PublishedFrom<typeof import('./index.js')>>().toBeNever()
  expectTypeOf<PublishedFrom<typeof import('./unstable.js')>>().toBeNever()
})
