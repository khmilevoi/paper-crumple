import { expectTypeOf, test } from 'vitest'
import { ABORTED, isAborted, type Aborted } from './abort.js'
import { GlError } from './errors.js'

type Result = number | InstanceType<typeof GlError> | Aborted

test('an unchecked Aborted does not narrow to success (§10.5)', () => {
  const r = ABORTED as Result
  if (!(r instanceof Error)) {
    expectTypeOf(r).toEqualTypeOf<number | Aborted>()
  }
})

test('narrowing abort first, then errors, leaves the success type', () => {
  const r = ABORTED as Result
  if (!isAborted(r) && !(r instanceof Error)) {
    expectTypeOf(r).toEqualTypeOf<number>()
  }
})

test('Aborted is the sentinel type and nothing else', () => {
  expectTypeOf<Aborted>().toEqualTypeOf<typeof ABORTED>()
})
