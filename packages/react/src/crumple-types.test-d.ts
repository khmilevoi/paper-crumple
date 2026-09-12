import type { CanvasHTMLAttributes } from 'react'
import type {
  Fit,
  PlayOptions,
  PlayResult,
  PoseRef,
  Run,
  SpriteSource,
  ViewFrame,
  ViewState,
} from '@paper-crumple/core'
import { expectTypeOf, test } from 'vitest'
import {
  Crumple,
  useCrumple,
  type CrumpleFrameStyle,
  type CrumpleOptions,
  type CrumpleProps,
  type StageErrorListener,
} from './index.js'

declare const bitmap: ImageBitmap
declare const blob: Blob
declare const widened: SpriteSource

// The hook is never CALLED in this file: `react-hooks/rules-of-hooks` would refuse a call outside
// a component, and `expectTypeOf` needs only the reference.

test('a bare ImageBitmap without pin: true does not typecheck as src (§5.1, §9)', () => {
  // A source written at the call site whose bytes no re-supplier can be derived from must say so,
  // or the byte budget silently stops bounding anything.
  // @ts-expect-error — `pin: true` is required for an ImageBitmap source.
  const refused: CrumpleOptions<ImageBitmap> = { spriteKey: 'hero', src: bitmap }
  void refused
  const accepted: CrumpleOptions<ImageBitmap> = { spriteKey: 'hero', src: bitmap, pin: true }
  void accepted
  // @ts-expect-error — and the same at the call site, where `S` is inferred.
  expectTypeOf(useCrumple<ImageBitmap>).toBeCallableWith({ spriteKey: 'hero', src: bitmap })
})

test('a reclaimable source needs no pin', () => {
  expectTypeOf(useCrumple<string>).toBeCallableWith({ spriteKey: 'hero', src: 'hero.png' })
  const fromBlob: CrumpleOptions<Blob> = { spriteKey: 'hero', src: blob }
  void fromBlob
})

test('a source widened to the whole union keeps the core s own hole, neither wider nor closed', () => {
  // `PinFor` tests `[S] extends [PinnedSource]`, so a source read out of a data model passes and
  // reaches the runtime check instead. The binding inherits that exactly (§5.1).
  const widenedOptions: CrumpleOptions<SpriteSource> = { spriteKey: 'hero', src: widened }
  void widenedOptions
})

test('fit is a hook option and never a prop (§2)', () => {
  expectTypeOf<CrumpleOptions<string>['fit']>().toEqualTypeOf<Fit | undefined>()
  expectTypeOf<CrumpleProps>().not.toHaveProperty('fit')
  expectTypeOf<CrumpleProps>().not.toHaveProperty('frameTo')
})

test('onError uses the binding-owned StageErrorListener (§4.3)', () => {
  expectTypeOf<NonNullable<CrumpleOptions<string>['onError']>>().toEqualTypeOf<StageErrorListener>()
})

test('state carries all seven view states plus detached (§5.2)', () => {
  expectTypeOf<Crumple['state']>().toEqualTypeOf<ViewState | 'detached'>()
})

test('play is not async and hands back the raw Run (§5.1, §7)', () => {
  expectTypeOf<Crumple['play']>().toEqualTypeOf<
    (from: PoseRef, to: PoseRef, o?: PlayOptions) => Run<PlayResult> | null
  >()
})

test('ref is void-returning, so React 19 falls back to the null call (§2.1)', () => {
  expectTypeOf<Crumple['ref']>().toEqualTypeOf<(el: HTMLCanvasElement | null) => void>()
})

test('frame is the core type and frameStyle is the four CSS strings (§6)', () => {
  expectTypeOf<Crumple['frame']>().toEqualTypeOf<ViewFrame | null>()
  expectTypeOf<Crumple['frameStyle']>().toEqualTypeOf<CrumpleFrameStyle | null>()
})

test('canvasProps excludes ref, width and height (§6)', () => {
  expectTypeOf<NonNullable<CrumpleProps['canvasProps']>>().toEqualTypeOf<
    Omit<CanvasHTMLAttributes<HTMLCanvasElement>, 'ref' | 'width' | 'height'>
  >()
  // @ts-expect-error — nobody but the stage writes width on the canvas.
  const refusedCanvas: CrumpleProps['canvasProps'] = { width: 300 }
  void refusedCanvas
})

test('<Crumple> takes the instance and nothing else configures it (§2)', () => {
  expectTypeOf<Crumple>().toExtend<CrumpleProps['value']>()
  expectTypeOf(Crumple).toBeFunction()
})
