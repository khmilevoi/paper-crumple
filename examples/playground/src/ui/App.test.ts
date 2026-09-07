import { describe, expect, it } from 'vitest'

import { SAMPLES } from '../samples'
import { droppedSample } from '../hero'
import { isNoOpSwap, nextLibrarySample } from './App'
import { BROKEN_ID } from './SourceSection'

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

/**
 * `isNoOpSwap` is `startSwap`'s root guard (Finding A, P4 final-review fix round). `useCrumple`
 * refuses a same-key request silently — no `add`, no run, no `end` event — so without this guard
 * `startSwap` arms `direction` and `swappingRef` for an event that never arrives and the transport,
 * the keyboard shortcuts and the Swap button stay dead until reload. If the guard is dropped or its
 * condition is loosened, a request for the sample already shown stops being flagged as a no-op.
 *
 * The guard takes the shown *key* — what `useCrumple` itself compares (`crumple.shown ?? shown.id`
 * at the call site) — not a `Sample`, because the local `shown` request state has no path back
 * after a rollback demo: it stays pinned to the broken sample while `crumple.shown` reverts to the
 * previous sprite's key. The 'does not flag a swap to broken after a rollback' case below is that
 * regression: it is what a correction that reverts to comparing the local request state breaks.
 */
describe('isNoOpSwap', () => {
  const sweater = SAMPLES.find((s) => s.id === 'sweater')
  const trench = SAMPLES.find((s) => s.id === 'trench')
  expect(sweater).toBeDefined()
  expect(trench).toBeDefined()
  if (sweater === undefined || trench === undefined) return

  it('flags a swap to the sample already shown', () => {
    expect(isNoOpSwap(sweater.id, sweater)).toBe(true)
  })

  it('does not flag a swap to a different sample', () => {
    expect(isNoOpSwap(sweater.id, trench)).toBe(false)
  })

  it('does not flag a swap to broken after a rollback', () => {
    // After a rollback demo, `crumple.shown` reverts to the previous sprite's key (here `sweater`)
    // while the local `shown` request state would still read `broken` — the regression this guards
    // against. The guard must see the reverted key and NOT flag a further swap to `broken`.
    const broken = {
      id: BROKEN_ID,
      label: 'broken URL (rollback demo)',
      url: 'https://example.invalid/missing.png',
    }
    expect(isNoOpSwap(sweater.id, broken)).toBe(false)
  })
})
