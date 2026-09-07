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
 * The guard takes the requested *key* — `crumple.requested ?? shown.id` at the call site — the key
 * `useCrumple` itself compares at `use-crumple.ts:261`, where it moves in lockstep with
 * `core.synced.key`. This is NOT `crumple.shown` (the sprite actually on the canvas): the two
 * diverge precisely on the rollback path, where a failed acquisition leaves `requested` at
 * `'broken'` while `shown` is still the previous sprite's key. The 'flags a repeat swap to broken
 * after a rollback' case below pins that: comparing against `shown` instead would let the click
 * through, re-arm the transport, and nothing would ever disarm it (App.tsx `startSwap`'s comment
 * has the full sequence).
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

  it('flags a repeat swap to broken after a rollback', () => {
    // After a rollback, `crumple.requested` stays at `'broken'` (`synced.key` never moved off it —
    // only the on-canvas `shown` sprite reverted to the previous key). The guard is called with
    // `requested`, so a second click on "broken URL" must be flagged as a no-op: `useCrumple`
    // refuses by construction and the rollback demo cannot be re-armed by clicking Swap again.
    const broken = {
      id: BROKEN_ID,
      label: 'broken URL (rollback demo)',
      url: 'https://example.invalid/missing.png',
    }
    expect(isNoOpSwap(BROKEN_ID, broken)).toBe(true)
  })
})
