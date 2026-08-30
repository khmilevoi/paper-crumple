import { expectTypeOf, test } from 'vitest'
import { type Aborted } from './abort.js'
import { GlError, SheetError } from './errors.js'
import { partition } from './partition.js'

type Sprite = { readonly key: string }
type AddErr = InstanceType<typeof GlError> | InstanceType<typeof SheetError>

test('an element union without Aborted partitions into its two halves', () => {
  const values: (Sprite | AddErr)[] = []
  const [ok, bad] = partition(values)
  expectTypeOf(ok).toEqualTypeOf<Sprite[]>()
  expectTypeOf(bad).toEqualTypeOf<AddErr[]>()
})

test('an element union carrying Aborted is rejected (amendment 2)', () => {
  const values: (Sprite | AddErr | Aborted)[] = []
  // @ts-expect-error - a batch aborts whole; no element union may carry Aborted
  partition(values)
})
