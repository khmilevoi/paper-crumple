import { describe, expect, it } from 'vitest'
import {
  decideCollision,
  decideStop,
  planStagePlay,
  stagePlayReport,
  type ChainOutcome,
  type StagePlayCandidate,
} from './collisions.js'

const view = (name: string): { name: string } => ({ name })

const candidate = (
  name: string,
  over: Partial<StagePlayCandidate<{ name: string }>> = {},
): StagePlayCandidate<{ name: string }> => ({
  view: view(name),
  hasSprite: true,
  disposed: false,
  liveOwner: null,
  ...over,
})

describe('decideCollision — §4.4, decided by scope and not by method', () => {
  it('starts when nothing is live', () => {
    expect(decideCollision('view', null)).toBe('start')
    expect(decideCollision('stage', null)).toBe('start')
  })

  it('reproduces the three-row table exactly', () => {
    expect(decideCollision('stage', 'view')).toBe('skip')
    expect(decideCollision('stage', 'stage')).toBe('supersede')
    expect(decideCollision('view', 'view')).toBe('supersede')
    expect(decideCollision('view', 'stage')).toBe('supersede')
  })

  it('makes stage.play supersede a stage-owned run, because that is a tie', () => {
    // So re-triggering a grid loader restarts it instead of silently doing nothing.
    expect(decideCollision('stage', 'stage')).toBe('supersede')
  })

  it('makes skip what latest-wins looks like from the losing side of a wide call', () => {
    expect(decideCollision('stage', 'view')).toBe('skip')
  })
})

describe('decideStop — the same scope principle applied to cancellation', () => {
  it('does nothing when nothing is live', () => {
    expect(decideStop('view', null)).toBe(false)
    expect(decideStop('stage', null)).toBe(false)
    expect(decideStop('stage', null, true)).toBe(false)
  })

  it('stage.stop() stops only stage-owned runs', () => {
    expect(decideStop('stage', 'stage')).toBe(true)
    expect(decideStop('stage', 'view')).toBe(false)
  })

  it('stage.stop({ all: true }) stops everything', () => {
    expect(decideStop('stage', 'view', true)).toBe(true)
    expect(decideStop('stage', 'stage', true)).toBe(true)
  })

  it('view.stop() stops whatever is live on that view', () => {
    expect(decideStop('view', 'view')).toBe(true)
    expect(decideStop('view', 'stage')).toBe(true)
  })
})

describe('planStagePlay — the eligible set, fixed at the call', () => {
  it('keeps registration order, which is the order stage.views is snapshotted in', () => {
    const e = planStagePlay([candidate('a'), candidate('b'), candidate('c')])
    expect(e.start.map((c) => c.view.name)).toEqual(['a', 'b', 'c'])
    expect(e.skipped).toEqual([])
  })

  it('skips a busy view — one owned by a narrower scope — with reason busy', () => {
    const e = planStagePlay([candidate('a'), candidate('b', { liveOwner: 'view' })])
    expect(e.start.map((c) => c.view.name)).toEqual(['a'])
    expect(e.skipped).toEqual([{ view: e.skipped[0].view, reason: 'busy' }])
    expect(e.skipped[0].view.name).toBe('b')
  })

  it('starts over a stage-owned run, because that is a tie and not a collision', () => {
    const e = planStagePlay([candidate('a', { liveOwner: 'stage' })])
    expect(e.start).toHaveLength(1)
    expect(e.skipped).toEqual([])
  })

  it('skips a view with no sprite, and a disposed one, with their own reasons', () => {
    const e = planStagePlay([
      candidate('a', { hasSprite: false }),
      candidate('b', { disposed: true }),
    ])
    expect(e.start).toEqual([])
    expect(e.skipped.map((s) => s.reason)).toEqual(['no-sprite', 'disposed'])
  })

  it('reports disposed before no-sprite before busy, so one view has one reason', () => {
    const e = planStagePlay([
      candidate('a', { disposed: true, hasSprite: false, liveOwner: 'view' }),
    ])
    expect(e.skipped.map((s) => s.reason)).toEqual(['disposed'])
  })

  it('reports no-sprite before busy, which the disposed case cannot show on its own', () => {
    // `disposed` short-circuits, so the test above proves only that it beats the other two.
    // This is the middle arm: not disposed, no sprite, and busy at the same time.
    const e = planStagePlay([candidate('a', { hasSprite: false, liveOwner: 'view' })])
    expect(e.start).toEqual([])
    expect(e.skipped.map((s) => s.reason)).toEqual(['no-sprite'])
  })

  it('carries the view tag, so a skip correlates without a reverse Map<View, id>', () => {
    const e = planStagePlay([candidate('a', { tag: 'tile-7', hasSprite: false })])
    expect(e.skipped[0].tag).toBe('tile-7')
  })

  it('omits tag entirely rather than writing tag: undefined', () => {
    const e = planStagePlay([candidate('a', { hasSprite: false })])
    expect('tag' in e.skipped[0]).toBe(false)
  })
})

describe('stagePlayReport — skipping is never silent (§4.4)', () => {
  const three = (): ReturnType<typeof planStagePlay<{ name: string }>> =>
    planStagePlay([candidate('a'), candidate('b'), candidate('c')])

  const completed: ChainOutcome = { kind: 'completed' }

  it('never returns an Error and never rejects — it is a plain report', () => {
    const report = stagePlayReport(three(), [completed, completed, completed])
    expect(report).not.toBeInstanceOf(Error)
    expect(report.started.map((v) => v.name)).toEqual(['a', 'b', 'c'])
    expect(report.skipped).toEqual([])
    expect(report.failed).toEqual([])
    expect(report.completed).toBe(true)
  })

  it('partitions the eligible set: started, skipped and failed never overlap', () => {
    const boom = new Error('draw failed')
    const eligibility = three()
    const report = stagePlayReport(eligibility, [
      completed,
      { kind: 'failed', error: boom },
      { kind: 'incomplete' },
    ])
    expect(report.started.map((v) => v.name)).toEqual(['a', 'c'])
    expect(report.failed.map((f) => f.view.name)).toEqual(['b'])
    expect(report.skipped).toEqual([])
    expect(report.started.length + report.skipped.length + report.failed.length).toBe(3)
  })

  it('moves a chain cancelled before its staggered start into skipped', () => {
    const report = stagePlayReport(three(), [completed, { kind: 'cancelled' }, completed])
    expect(report.skipped.map((s) => s.reason)).toEqual(['cancelled'])
    expect(report.started.map((v) => v.name)).toEqual(['a', 'c'])
  })

  it('is not completed when a view was superseded mid-flight', () => {
    const report = stagePlayReport(three(), [completed, completed, { kind: 'incomplete' }])
    expect(report.completed).toBe(false)
    expect(report.started).toHaveLength(3)
  })

  it('is not completed when anything was skipped or failed', () => {
    const eligibility = planStagePlay([candidate('a'), candidate('b', { liveOwner: 'view' })])
    expect(stagePlayReport(eligibility, [completed]).completed).toBe(false)
  })

  it('is not completed when nothing started, rather than vacuously true', () => {
    const report = stagePlayReport(planStagePlay([]), [])
    expect(report.started).toEqual([])
    expect(report.completed).toBe(false)
  })

  it('carries the tag on both skipped and failed entries (amendment 14)', () => {
    const boom = new Error('draw failed')
    const eligibility = planStagePlay([
      candidate('a', { tag: 'tile-1' }),
      candidate('b', { tag: 'tile-2', hasSprite: false }),
    ])
    const report = stagePlayReport(eligibility, [{ kind: 'failed', error: boom }])
    expect(report.failed[0].tag).toBe('tile-1')
    expect(report.skipped[0].tag).toBe('tile-2')
  })

  it('is index-correlated with the eligible set, so a short outcome list is not silently padded', () => {
    const report = stagePlayReport(three(), [completed])
    expect(report.started.map((v) => v.name)).toEqual(['a'])
    expect(report.skipped.map((s) => s.reason)).toEqual(['cancelled', 'cancelled'])
  })
})
