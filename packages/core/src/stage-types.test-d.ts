import { expectTypeOf, test } from 'vitest'
import type { Events, StageEvent } from './events.js'
import type { View } from './forward.js'
import type { MotionSource } from './motion.js'
import type { SheetRenderer } from './sheet.js'
import type { BlitTarget, StageOptions, ViewTarget } from './stage-types.js'

declare const sheet: SheetRenderer
declare const motion: MotionSource

test('exactly one of maxSize and cssPx is required (amendment 12)', () => {
  const withMax: StageOptions = { sheet, motion, maxSize: 384 }
  const withCss: StageOptions = { sheet, motion, cssPx: 192 }
  void withMax
  void withCss

  // @ts-expect-error - neither given
  const neither: StageOptions = { sheet, motion }
  // @ts-expect-error - both given
  const both: StageOptions = { sheet, motion, maxSize: 384, cssPx: 192 }
  void neither
  void both
})

test('the blit destination carries size and tag (amendment 13)', () => {
  const target: BlitTarget = {
    canvas: {} as HTMLCanvasElement,
    fit: 'contain',
    size: 'managed',
    tag: 'tile-7',
  }
  expectTypeOf(target).toExtend<ViewTarget>()
})

test('tag is on all three targets, because view.tag is a property of a view', () => {
  const direct: ViewTarget = { rect: { x: 0, y: 0, w: 8, h: 8 }, tag: 'a' }
  const hosted: ViewTarget = {
    framebuffer: {} as WebGLFramebuffer,
    viewport: { x: 0, y: 0, w: 8, h: 8 },
    tag: 'b',
  }
  void direct
  void hosted
})

test('the error event carries observed; view lives in the handler type (§7.1, amendment 5)', () => {
  expectTypeOf<Events['error']>().toEqualTypeOf<{ error: Error; observed: boolean }>()
  expectTypeOf<StageEvent<'error'>>().toEqualTypeOf<
    {
      error: Error
      observed: boolean
    } & { view: View | null }
  >()
})

test('the stage-side handler adds view to every member, lost included', () => {
  expectTypeOf<StageEvent<'end'>['view']>().toEqualTypeOf<View | null>()
  expectTypeOf<StageEvent<'lost'>['view']>().toEqualTypeOf<View | null>()
  expectTypeOf<StageEvent<'start'>['via']>().toEqualTypeOf<number | undefined>()
  expectTypeOf<StageEvent<'step'>['pose']>().toEqualTypeOf<number>()
})
