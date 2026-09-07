import { expectTypeOf, test } from 'vitest'
import { ABORTED, type Aborted } from './abort.js'
import { GlError } from './errors.js'
import type { Rect } from './geometry.js'
import type { MotionSource } from './motion.js'
import type { BuildError, SourceError } from './results.js'
import type { SheetFront, SheetHandle, SheetRenderer, SourceOptions } from './sheet.js'

const RECT: Rect = { x: 0, y: 0, w: 8, h: 8 }
const FRONT: SheetFront = {
  texture: {} as WebGLTexture,
  width: 8,
  height: 8,
  rect: RECT,
  artwork: RECT,
  bytes: 256,
}

test('a minimal sheet renderer satisfies the contract', () => {
  const sheet: SheetRenderer = {
    knobs: [],
    overscan: 0.04,
    mount: () => undefined,
    source: () => Promise.resolve(ABORTED),
    build: () => FRONT,
    releaseFront: () => undefined,
    release: () => undefined,
    dispose: () => undefined,
  }
  expectTypeOf(sheet.overscan).toEqualTypeOf<number>()
})

test('source() carries Aborted because it takes a signal (§10.5, amendment 1)', () => {
  type SourceReturn = Awaited<ReturnType<SheetRenderer['source']>>
  expectTypeOf<SourceReturn>().toEqualTypeOf<SourceError | Aborted | SheetHandle>()
  expectTypeOf<Aborted>().toExtend<SourceReturn>()
})

test('build() takes no signal, so it never mentions Aborted', () => {
  type BuildReturn = ReturnType<SheetRenderer['build']>
  expectTypeOf<BuildReturn>().toEqualTypeOf<BuildError | SheetFront>()
  expectTypeOf<Aborted>().not.toExtend<BuildReturn>()
})

test('a minimal motion source satisfies the contract', () => {
  const motion: MotionSource = {
    knobs: [],
    mount: () => undefined,
    fit: () => ({ frontSize: { w: 8, h: 8 }, sortKey: 'bucket-0' }),
    load: () => Promise.resolve(ABORTED),
    draw: () => new GlError('not implemented'),
    release: () => undefined,
    dispose: () => undefined,
  }
  expectTypeOf(motion.fit).parameter(0).toEqualTypeOf<Rect>()
})

test('load() carries Aborted; fit() is pure and does not', () => {
  expectTypeOf<Aborted>().toExtend<Awaited<ReturnType<MotionSource['load']>>>()
  expectTypeOf<Aborted>().not.toExtend<ReturnType<MotionSource['fit']>>()
})

test('SourceOptions.artworkLongSide is optional (§8.6 amendment, artworkCssPx)', () => {
  const withoutArtworkLongSide: SourceOptions = { maxSize: 1, exact: false }
  const withArtworkLongSide: SourceOptions = { maxSize: 1, exact: false, artworkLongSide: 2 }
  expectTypeOf(withoutArtworkLongSide).toExtend<SourceOptions>()
  expectTypeOf(withArtworkLongSide).toExtend<SourceOptions>()
})
