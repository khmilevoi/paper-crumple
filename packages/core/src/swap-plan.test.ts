import { describe, expect, it } from 'vitest'
import { authoredSwapTotal, swapPlan } from './dwell.js'

const poses = (plan: { steps: readonly { pose: number }[] }): number[] =>
  plan.steps.map((s) => s.pose)

describe('the swap, from pose 0 (§7.2)', () => {
  const plan = swapPlan(0)

  it('is eleven renders across ten gaps', () => {
    expect(plan.rise.steps.length + plan.fall.steps.length).toBe(11)
  })

  it('rises 0→5, holds at the ball, and falls 4→0 — pose 5 rendered exactly once', () => {
    expect(poses(plan.rise)).toEqual([0, 1, 2, 3, 4, 5])
    expect(poses(plan.fall)).toEqual([4, 3, 2, 1, 0])
    expect(poses(plan.rise).filter((p) => p === 5)).toHaveLength(1)
    expect(poses(plan.fall)).not.toContain(5)
  })

  it('spends 495 rising, 90 at the ball and 400 falling, for 985 ms', () => {
    expect(plan.rise.total).toBe(495)
    expect(plan.hold).toBe(90)
    expect(plan.fall.total).toBe(400)
    expect(plan.total).toBe(985)
  })

  it('puts the hold in the gap no ordinary traversal ever spends', () => {
    // DWELL_MS[5] is the ball's own dwell: a play never waits after its last pose, so pose 5's
    // dwell is unspent by every traversal. That is what makes it the natural home for the hold.
    expect(plan.hold).toBe(90)
    expect(plan.rise.steps[plan.rise.steps.length - 1].gap).toBe(0)
  })

  it('re-bases the fall at zero, because the deadline re-bases on leaving the ball', () => {
    expect(plan.fall.steps[0].offset).toBe(0)
  })
})

describe('the swap from an arbitrary pose, which supersession produces (§7.2)', () => {
  it('reproduces every published total', () => {
    expect(swapPlan(0).total).toBe(985)
    expect(swapPlan(1).total).toBe(890)
    expect(swapPlan(2).total).toBe(820)
    expect(swapPlan(3).total).toBe(700)
    expect(swapPlan(4).total).toBe(625)
    expect(swapPlan(5).total).toBe(490)
  })

  it('from the ball there is no rise and no extra pose-5 render', () => {
    const plan = swapPlan(5)
    // §7.1 still requires the run to render its `from` pose, so pose 5 is rendered once — as the
    // `from`. "No extra pose-5 render" is the rule that it is not rendered a second time, and the
    // arithmetic agrees: 90 + 400 = 490, five gaps across six renders.
    expect(poses(plan.rise)).toEqual([5])
    expect(plan.rise.total).toBe(0)
    expect(poses(plan.fall)).toEqual([4, 3, 2, 1, 0])
    expect(plan.rise.steps.length + plan.fall.steps.length).toBe(6)
  })

  it('shortens only the rise, never the hold or the fall', () => {
    for (const from of [0, 1, 2, 3, 4, 5]) {
      const plan = swapPlan(from)
      expect(plan.hold, `from ${from}`).toBe(90)
      expect(plan.fall.total, `from ${from}`).toBe(400)
    }
  })
})

describe('authoredSwapTotal', () => {
  it('is the rescale basis: rise + ball dwell + fall', () => {
    expect(authoredSwapTotal(0)).toBe(985)
    expect(authoredSwapTotal(5)).toBe(490)
  })
})

describe('duration (§7.2)', () => {
  it('rescales all ten gaps, the ball dwell included, by one multiplier', () => {
    const plan = swapPlan(0, { duration: 1970 })
    expect(plan.rise.total).toBeCloseTo(990, 9)
    expect(plan.hold).toBeCloseTo(180, 9)
    expect(plan.fall.total).toBeCloseTo(800, 9)
    expect(plan.total).toBe(1970)
  })

  it('means what the run costs when nothing has to be waited for', () => {
    // Which is exactly what an audio clip's length is. Park time is never rescaled; the excess
    // sits entirely at the ball and `hold` is only the floor of the park (see runner.ts).
    expect(swapPlan(0, { duration: 985 }).total).toBe(985)
  })

  it('clamps a negative duration to zero', () => {
    expect(swapPlan(0, { duration: -1 }).total).toBe(0)
  })

  it('accepts a custom dwell table, deriving the ball from its length', () => {
    const plan = swapPlan(0, { dwells: [10, 20, 30] })
    expect(poses(plan.rise)).toEqual([0, 1, 2])
    expect(plan.hold).toBe(30)
    expect(poses(plan.fall)).toEqual([1, 0])
    expect(plan.rise.total).toBe(30)
    expect(plan.fall.total).toBe(20)
    expect(plan.total).toBe(80)
  })
})

describe('defensive bounds', () => {
  it('clamps a from outside the pack rather than producing an unbounded traversal', () => {
    expect(poses(swapPlan(-3).rise)).toEqual([0, 1, 2, 3, 4, 5])
    expect(poses(swapPlan(99).rise)).toEqual([5])
  })
})
