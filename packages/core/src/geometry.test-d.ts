import { expectTypeOf, test } from 'vitest'
import type { Rect, Size } from './geometry.js'
import type { PoseRef } from './pose.js'

test('Rect is the four-field form §7.4.1 writes as srcRect.w', () => {
  expectTypeOf<Rect>().toEqualTypeOf<{
    readonly x: number
    readonly y: number
    readonly w: number
    readonly h: number
  }>()
})

test('Size is the two-field form MotionFit.frontSize carries', () => {
  expectTypeOf<Size>().toEqualTypeOf<{ readonly w: number; readonly h: number }>()
})

test('PoseRef is the canonical input form, named members first (amendment 21)', () => {
  expectTypeOf<PoseRef>().toEqualTypeOf<'flat' | 'ball' | number>()
  expectTypeOf<'flat'>().toExtend<PoseRef>()
  expectTypeOf<'ball'>().toExtend<PoseRef>()
  expectTypeOf<number>().toExtend<PoseRef>()
})
