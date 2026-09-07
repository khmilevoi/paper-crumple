import { describe, expect, it } from 'vitest'
import { PoseError } from './errors.js'
import {
  authoredTotal,
  ballPose,
  DWELL_MS,
  FLAT_POSE,
  playPlan,
  resolvePose,
  traversal,
} from './dwell.js'

const POSES = 6

describe('DWELL_MS (§7.2)', () => {
  it('is the authored cadence, and sums to 585', () => {
    expect([...DWELL_MS]).toEqual([95, 70, 120, 75, 135, 90])
    expect(DWELL_MS.reduce((a, b) => a + b, 0)).toBe(585)
  })

  it('is frozen, because a consumer chaining by hand reads DWELL_MS[5] and must not edit it', () => {
    expect(Object.isFrozen(DWELL_MS)).toBe(true)
  })
})

describe('resolvePose (amendment 21)', () => {
  it('resolves the named forms, which are canonical at every call site', () => {
    expect(resolvePose('flat', POSES)).toBe(0)
    expect(resolvePose('ball', POSES)).toBe(5)
    expect(FLAT_POSE).toBe(0)
    expect(ballPose(POSES)).toBe(5)
  })

  it("resolves 'ball' per pack, which is the reason raw indices are the escape hatch", () => {
    expect(resolvePose('ball', 8)).toBe(7)
    expect(resolvePose('ball', 2)).toBe(1)
  })

  it('passes a valid raw index straight through', () => {
    expect(resolvePose(0, POSES)).toBe(0)
    expect(resolvePose(3, POSES)).toBe(3)
    expect(resolvePose(5, POSES)).toBe(5)
  })

  it('returns a PoseError out of range, and names the range', () => {
    const low = resolvePose(-1, POSES)
    const high = resolvePose(6, POSES)
    expect(low).toBeInstanceOf(PoseError)
    expect(high).toBeInstanceOf(PoseError)
    expect(String(high)).toMatch(/0 … 5/)
  })

  it('returns a PoseError for a non-integer, which would otherwise never terminate a traversal', () => {
    expect(resolvePose(2.5, POSES)).toBeInstanceOf(PoseError)
    expect(resolvePose(Number.NaN, POSES)).toBeInstanceOf(PoseError)
    expect(resolvePose(Number.POSITIVE_INFINITY, POSES)).toBeInstanceOf(PoseError)
  })

  it('returns a PoseError for a pack with no poses', () => {
    expect(resolvePose('flat', 0)).toBeInstanceOf(PoseError)
  })

  it('never throws — a bad pose is a returned Error like everything else (§10.8)', () => {
    expect(() => resolvePose(99, POSES)).not.toThrow()
  })
})

describe('traversal', () => {
  it('walks up, down, and stands still', () => {
    expect(traversal(0, 5)).toEqual([0, 1, 2, 3, 4, 5])
    expect(traversal(5, 0)).toEqual([5, 4, 3, 2, 1, 0])
    expect(traversal(2, 4)).toEqual([2, 3, 4])
    expect(traversal(3, 3)).toEqual([3])
  })
})

describe('authoredTotal — N poses, N−1 gaps, `to` excluded (§7.2)', () => {
  it('reproduces the four rows of §7.2 exactly', () => {
    expect(authoredTotal(0, 5)).toBe(495)
    expect(authoredTotal(5, 0)).toBe(490)
    expect(authoredTotal(2, 4)).toBe(195)
    expect(authoredTotal(3, 3)).toBe(0)
  })

  it('is not sum(DWELL_MS): including the trailing dwell is the 15 % trap', () => {
    expect(authoredTotal(0, 5)).not.toBe(585)
    expect((585 - 495) / 585).toBeCloseTo(0.154, 3)
  })

  it('is not an off-by-one window either — that error is 1 %, and is not the trap', () => {
    expect(Math.abs(495 - 490) / 495).toBeLessThan(0.02)
  })

  it('sums a custom dwell table, so poseCount stays a per-pack number', () => {
    expect(authoredTotal(0, 2, [10, 20, 30])).toBe(30)
  })
})

describe('playPlan', () => {
  it('renders every traversed pose, in order', () => {
    expect(playPlan(0, 5).steps.map((s) => s.pose)).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('never waits after the last pose, so the last gap is zero', () => {
    const plan = playPlan(0, 5)
    expect(plan.steps[plan.steps.length - 1].gap).toBe(0)
    expect(plan.total).toBe(495)
  })

  it('carries absolute offsets, which is what an absolute-deadline stepper walks', () => {
    expect(playPlan(0, 5).steps.map((s) => s.offset)).toEqual([0, 95, 165, 285, 360, 495])
  })

  it('costs 0 ms for play(x, x): one render, zero dwells', () => {
    const plan = playPlan(3, 3)
    expect(plan.steps).toHaveLength(1)
    expect(plan.total).toBe(0)
    expect(plan.steps[0]).toEqual({ pose: 3, gap: 0, offset: 0 })
  })

  it('applies duration as one multiplier, and finishes at t=585 rather than t=495 (§11)', () => {
    const plan = playPlan(0, 5, { duration: 585 })
    expect(plan.total).toBe(585)
    expect(plan.steps[plan.steps.length - 1].offset).toBe(585)
  })

  it('keeps the hand-made uneven cadence exactly, rather than flattening it', () => {
    const plain = playPlan(0, 5)
    const scaled = playPlan(0, 5, { duration: 990 })
    for (let i = 0; i < plain.steps.length; i += 1) {
      expect(scaled.steps[i].offset).toBeCloseTo(plain.steps[i].offset * 2, 9)
    }
  })

  it('ignores duration when there is nothing to scale', () => {
    expect(playPlan(3, 3, { duration: 900 }).total).toBe(0)
  })

  it('treats duration: 0 as "as fast as possible", which §7.2 says overruns rather than skips', () => {
    const plan = playPlan(0, 5, { duration: 0 })
    expect(plan.total).toBe(0)
    expect(plan.steps.map((s) => s.pose)).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('clamps a negative duration to zero rather than running the traversal backwards', () => {
    expect(playPlan(0, 5, { duration: -100 }).total).toBe(0)
  })

  it('accepts a custom dwell table', () => {
    const plan = playPlan(0, 2, { dwells: [10, 20, 30] })
    expect(plan.total).toBe(30)
    expect(plan.steps.map((s) => s.offset)).toEqual([0, 10, 30])
  })

  it('makes gaps the differences between offsets, so a stepper never re-derives them', () => {
    const plan = playPlan(5, 0)
    for (let i = 0; i < plan.steps.length - 1; i += 1) {
      expect(plan.steps[i].gap).toBe(plan.steps[i + 1].offset - plan.steps[i].offset)
    }
  })
})
