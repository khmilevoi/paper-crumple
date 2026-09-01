import { expectTypeOf, test } from 'vitest'
import type { BitmapSupplier, PinFor, PinnedSource, SpriteSource } from './source.js'

declare const bitmap: ImageBitmap
declare const img: HTMLImageElement
declare const canvas: HTMLCanvasElement
declare const blob: Blob
declare const supplier: BitmapSupplier
declare const widened: SpriteSource

/**
 * The stand-in for `add`. P9 owns `add`'s real signature; what this plan owns is the type rule it
 * is built from, so the rule is asserted against a declaration with exactly the shape P9 composes:
 * `opts: <P9's own bag> & PinFor<S>`.
 */
declare function add<S extends SpriteSource>(src: S, o: { key: string } & PinFor<S>): void

test('a bare ImageBitmap without pin: true is not a legal add (§4.1, §11, amendment 9)', () => {
  // @ts-expect-error — no re-supplier can be derived from a bare ImageBitmap, so its front can
  // never be evicted and the byte budget cannot bound it. The unreclaimable sprite is a signed
  // decision, never something a consumer gets by omission.
  add(bitmap, { key: 'sweater' })
  add(bitmap, { key: 'sweater', pin: true })
})

test('the same holds for the other two bare arms', () => {
  // @ts-expect-error — an <img> is not re-suppliable either.
  add(img, { key: 'sweater' })
  // @ts-expect-error — nor is a <canvas>, whose pixels the consumer may repaint at any moment.
  add(canvas, { key: 'sweater' })
  add(img, { key: 'sweater', pin: true })
  add(canvas, { key: 'sweater', pin: true })
})

test('the four re-suppliable arms take pin optionally, and never require it', () => {
  add('/sweater.png', { key: 'sweater' })
  add(new URL('https://cdn.example/sweater.png'), { key: 'sweater' })
  add(blob, { key: 'sweater' })
  add(supplier, { key: 'sweater' })
  add('/sweater.png', { key: 'sweater', pin: true })
})

test('pin: false is not the opt-out — the flag is `true` or absent', () => {
  // @ts-expect-error — `pin?: true`, so `false` is not assignable. "Unpinned" is written by
  // omitting the key, which is what makes the pinned case grep-able.
  add('/sweater.png', { key: 'sweater', pin: false })
})

test('PinFor resolves to the two shapes it has, and to nothing else', () => {
  expectTypeOf<PinFor<ImageBitmap>>().toEqualTypeOf<{ pin: true }>()
  expectTypeOf<PinFor<HTMLImageElement>>().toEqualTypeOf<{ pin: true }>()
  expectTypeOf<PinFor<HTMLCanvasElement>>().toEqualTypeOf<{ pin: true }>()
  expectTypeOf<PinFor<PinnedSource>>().toEqualTypeOf<{ pin: true }>()
  expectTypeOf<PinFor<string>>().toEqualTypeOf<{ pin?: true }>()
  expectTypeOf<PinFor<URL>>().toEqualTypeOf<{ pin?: true }>()
  expectTypeOf<PinFor<Blob>>().toEqualTypeOf<{ pin?: true }>()
  expectTypeOf<PinFor<BitmapSupplier>>().toEqualTypeOf<{ pin?: true }>()
})

test('the widening hole is recorded rather than discovered (§6.8)', () => {
  // A source whose static type is the whole union — one read out of a data model rather than
  // written at the call site — does not require `pin`, exactly as a `Partial` knob patch built in
  // a variable loses its literal keys. `[S] extends [PinnedSource]` is false for a union with one
  // re-suppliable arm in it, and the runtime check P9 owns is what catches this case.
  expectTypeOf<PinFor<SpriteSource>>().toEqualTypeOf<{ pin?: true }>()
  add(widened, { key: 'sweater' })
  // A union of unreclaimable arms alone still requires it, which is the property that matters.
  expectTypeOf<PinFor<ImageBitmap | HTMLCanvasElement>>().toEqualTypeOf<{ pin: true }>()
})
