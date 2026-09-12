import { makeFakeSprite } from './testing/fake-stage.js'
import { createChanges } from '../../core/src/changes.js'
import type { View, ViewFrame } from '@paper-crumple/core'
import { expect, test } from 'vitest'
import { createCrumpleCore, onRunEnd, onRunStart, onRunStep, readCrumple } from './crumple-state.js'

const FRAME: ViewFrame = { box: { w: 240, h: 240 }, artwork: { x: 20, y: 20, w: 200, h: 200 } }

function fakeView(o?: { sprite?: string; frame?: ViewFrame }): View {
  return {
    state: 'crumpling.rise',
    pose: 3,
    changes: createChanges(),
    appliedKnobs: {},
    sprite: o?.sprite === undefined ? null : makeFakeSprite(o.sprite),
    frame: o?.frame ?? null,
  } as unknown as View
}

test('a core with no view reads as the detached snapshot (§5.2, §8)', () => {
  const snapshot = readCrumple(createCrumpleCore())
  expect(snapshot).toEqual({
    state: 'detached',
    status: 'detached',
    parked: false,
    pose: 0,
    shown: null,
    sprite: null,
    requested: null,
    pending: null,
    error: null,
    frame: null,
    view: null,
  })
})

test('the reading carries neither style and the record no frameTo — the hook derives both (§2.7, §2.3)', () => {
  const core = createCrumpleCore()
  expect(core).not.toHaveProperty('frameTo')
  const snapshot = readCrumple(core)
  // Neither style is in the reading: both are derived in the hook's render from the `frameTo`
  // PROP, so the record cannot lag its own commit (§2.7, §2.3, §9.1).
  expect(snapshot).not.toHaveProperty('frameStyle')
  expect(snapshot).not.toHaveProperty('artworkStyle')
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
  const sprite = makeFakeSprite('a')
  core.view = {
    state: 'idle',
    pose: 0,
    sprite,
    frame: null,
    changes: createChanges(),
    appliedKnobs: {},
  } as unknown as View
  const reading = readCrumple(core)
  expect(reading.sprite).toBe(sprite)
  expect(reading.shown).toBe('a')
})

test('status is detached with no view, whatever else the record says (§2.5)', () => {
  const core = createCrumpleCore()
  core.requested = 'a'
  core.error = new Error('stale')
  expect(readCrumple(core).status).toBe('detached')
})

test('the in-flight statuses come from pending, and beat a stale rollback (§2.5)', () => {
  const core = createCrumpleCore()
  core.view = {
    state: 'idle',
    pose: 0,
    sprite: makeFakeSprite('a'),
    frame: null,
    changes: createChanges(),
    appliedKnobs: {},
  } as unknown as View
  core.requested = 'b'
  // No `start` fires on the degraded path, so a previous rollback's error is still standing while
  // the next request acquires. The request is the more informative of the two.
  core.error = new Error('the previous target never arrived')
  core.pending = { key: 'b', phase: 'acquiring', run: null }
  expect(readCrumple(core).status).toBe('acquiring')
})

test('status is rolled-back when the request and the canvas disagree after an error (§2.5)', () => {
  const core = createCrumpleCore()
  core.view = {
    state: 'idle',
    pose: 0,
    sprite: makeFakeSprite('a'),
    frame: null,
    changes: createChanges(),
    appliedKnobs: {},
  } as unknown as View
  core.requested = 'b'
  core.error = new Error('the target never arrived')
  expect(readCrumple(core).status).toBe('rolled-back')
})

test('an error on the key that IS shown is not a rollback (§2.5)', () => {
  const core = createCrumpleCore()
  core.view = {
    state: 'idle',
    pose: 0,
    sprite: makeFakeSprite('a'),
    frame: null,
    changes: createChanges(),
    appliedKnobs: {},
  } as unknown as View
  core.requested = 'a'
  core.error = new Error('a knob refused')
  expect(readCrumple(core).status).toBe('shown')
})

test('a view showing nothing and asking for nothing is empty (§2.5)', () => {
  const core = createCrumpleCore()
  core.view = {
    state: 'idle',
    pose: 0,
    sprite: null,
    frame: null,
    changes: createChanges(),
    appliedKnobs: {},
  } as unknown as View
  expect(readCrumple(core).status).toBe('empty')
})

test('a run the consumer started with play() reads as playing without a pending (§2.5)', () => {
  const core = createCrumpleCore()
  core.view = {
    state: 'playing',
    pose: 4,
    sprite: makeFakeSprite('a'),
    frame: null,
    changes: createChanges(),
    appliedKnobs: {},
  } as unknown as View
  core.requested = 'a'
  expect(readCrumple(core).status).toBe('playing')
})
