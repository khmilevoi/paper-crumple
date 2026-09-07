import { expectTypeOf, test } from 'vitest'
import type { PoseError } from './errors.js'
import { playPlan, resolvePose } from './dwell.js'
import type { PoseRef } from './pose.js'

test('PoseRef goes in (amendment 21: canonical at every call site)', () => {
  expectTypeOf(resolvePose).parameter(0).toEqualTypeOf<PoseRef>()
})

test('a resolved index comes out, never a PoseRef — PoseRef is an input type only', () => {
  expectTypeOf(resolvePose).returns.toEqualTypeOf<number | InstanceType<typeof PoseError>>()
})

test('a plan works in indices, because the boundary resolved them once', () => {
  expectTypeOf(playPlan).parameter(0).toEqualTypeOf<number>()
  expectTypeOf(playPlan).parameter(1).toEqualTypeOf<number>()
  expectTypeOf(playPlan(0, 5).steps[0].pose).toEqualTypeOf<number>()
})

test('resolvePose refuses a pose that is neither named nor numeric', () => {
  // @ts-expect-error — 'crumpled' is not a PoseRef; the named forms are 'flat' and 'ball'.
  resolvePose('crumpled', 6)
})
