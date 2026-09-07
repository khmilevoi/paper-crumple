import type { Sprite, View, ViewFrame } from '@paper-crumple/core'
import { expect, test } from 'vitest'
import { createCrumpleCore, onRunEnd, onRunStart, onRunStep, readCrumple } from './crumple-state.js'

const FRAME: ViewFrame = { box: { w: 240, h: 240 }, artwork: { x: 20, y: 20, w: 200, h: 200 } }

function fakeView(o?: { sprite?: string; frame?: ViewFrame }): View {
  return {
    state: 'crumpling.rise',
    pose: 3,
    sprite: o?.sprite === undefined ? null : ({ key: o.sprite } as Sprite),
    frame: o?.frame ?? null,
  } as unknown as View
}

test('a core with no view reads as the detached snapshot (§5.2, §8)', () => {
  const snapshot = readCrumple(createCrumpleCore())
  expect(snapshot).toEqual({
    state: 'detached',
    parked: false,
    pose: 0,
    shown: null,
    sprite: null,
    requested: null,
    error: null,
    frame: null,
    view: null,
  })
})

test('the reading carries no frameStyle and the record no frameTo — the hook derives it (§2.7)', () => {
  const core = createCrumpleCore()
  expect(core).not.toHaveProperty('frameTo')
  const snapshot = readCrumple(core)
  expect(snapshot).not.toHaveProperty('frameStyle')
})

test('with a view, the getters are read through (§5.2)', () => {
  const core = createCrumpleCore()
  core.view = fakeView({ sprite: 'hero', frame: FRAME })
  core.requested = 'hero'
  const snapshot = readCrumple(core)
  expect(snapshot.state).toBe('crumpling.rise')
  expect(snapshot.pose).toBe(3)
  expect(snapshot.shown).toBe('hero')
  expect(snapshot.requested).toBe('hero')
  expect(snapshot.frame).toBe(FRAME)
})

test('requested and shown diverge on a rollback, and the error rides with them (§5.1)', () => {
  const core = createCrumpleCore()
  core.view = fakeView({ sprite: 'a' })
  core.requested = 'b'
  core.error = new Error('the target failed')
  const snapshot = readCrumple(core)
  expect(snapshot.requested).toBe('b')
  expect(snapshot.shown).toBe('a')
  expect(snapshot.error).toBeInstanceOf(Error)
})

test('parked goes true only at the step whose pose is the start via (§5.5)', () => {
  const core = createCrumpleCore()
  onRunStart(core, { from: 0, to: 0, via: 5 })
  expect(core.parked).toBe(false)
  onRunStep(core, { pose: 3, frame: 3, ms: 90 })
  expect(core.parked).toBe(false)
  onRunStep(core, { pose: 5, frame: 5, ms: 300 })
  expect(core.parked).toBe(true)
})

test('a plain play has no via and never parks, even on a step at the old ball index', () => {
  const core = createCrumpleCore()
  onRunStart(core, { from: 0, to: 5, via: 5 })
  onRunStep(core, { pose: 5, frame: 5, ms: 300 })
  expect(core.parked).toBe(true)
  // The next run is an ordinary play: `start` clears the remembered via with the flag, or a step
  // landing on the previous run's ball index would latch it again.
  onRunStart(core, { from: 5, to: 0 })
  expect(core.parked).toBe(false)
  onRunStep(core, { pose: 5, frame: 5, ms: 10 })
  expect(core.parked).toBe(false)
})

test('end clears parked — a park cut short never reaches another step (§5.5)', () => {
  const core = createCrumpleCore()
  onRunStart(core, { from: 0, to: 0, via: 5 })
  onRunStep(core, { pose: 5, frame: 5, ms: 300 })
  onRunEnd(core)
  expect(core.parked).toBe(false)
})

test('start clears the error, so a rollback notice goes the moment the next run begins (§5.1)', () => {
  const core = createCrumpleCore()
  core.error = new Error('the last swap rolled back')
  onRunStart(core, { from: 0, to: 5 })
  expect(core.error).toBeNull()
})

test('sprite is read in the same pass as shown, so the two never skew (§2.4)', () => {
  const core = createCrumpleCore()
  expect(readCrumple(core).sprite).toBeNull()
  const sprite = { key: 'a' } as Sprite
  core.view = { state: 'idle', pose: 0, sprite, frame: null } as unknown as View
  const reading = readCrumple(core)
  expect(reading.sprite).toBe(sprite)
  expect(reading.shown).toBe('a')
})
