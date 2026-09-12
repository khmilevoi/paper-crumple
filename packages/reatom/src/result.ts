import { ABORTED, type Aborted } from '@paper-crumple/core'
import { throwAbort } from '@reatom/core'

/** Convert a core Result into Reatom's native success, failure, or cancellation. */
export function toAsyncValue<T>(value: T | Error | Aborted): T {
  if (value === ABORTED) throwAbort()
  if (value instanceof Error) throw value
  return value
}
