import { describe, expect, it } from 'vitest'

import { SAMPLES } from '../samples'
import { droppedSample } from '../hero'
import { nextLibrarySample } from './App'

/**
 * `nextLibrarySample` is the "sample" `<select>`'s whole desync guard (Finding B, P4 task 4 fix
 * round 1): `SourceSection` only ever renders an `<option>` per `SAMPLES` entry, so the value fed
 * to its controlled `<select>` must always be one. A dropped file's `dropped-N` id — or, before
 * this fix, the rollback demo's `broken` id — has no matching option, which is exactly the
 * regression this covers: if the guard is dropped and the raw target wins unconditionally again,
 * these cases start failing.
 */
describe('nextLibrarySample', () => {
  const sweater = SAMPLES.find((s) => s.id === 'sweater')
  const trench = SAMPLES.find((s) => s.id === 'trench')
  expect(sweater).toBeDefined()
  expect(trench).toBeDefined()
  if (sweater === undefined || trench === undefined) return

  it('adopts the target when it is a library sample', () => {
    expect(nextLibrarySample(sweater, trench)).toBe(trench)
  })

  it('keeps the current library sample when the target is a dropped file', () => {
    const dropped = droppedSample(new File([], 'picture.png'), 'blob:fake', 1)
    expect(nextLibrarySample(sweater, dropped)).toBe(sweater)
  })

  it('keeps the current library sample when the target is the broken-URL rollback demo', () => {
    const broken = { id: 'broken', label: 'broken URL (rollback demo)', url: '/nope.png' }
    expect(nextLibrarySample(sweater, broken)).toBe(sweater)
  })
})
