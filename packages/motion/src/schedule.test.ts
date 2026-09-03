import { DWELL_MS, PackError } from '@paper-crumple/core'
import { describe, expect, it } from 'vitest'

import { setKeyFrames } from './pack.js'
import { dwellsFor, evenKeyFrames, resolveSchedule } from './schedule.js'

describe('dwellsFor (§7.2)', () => {
  it('is DWELL_MS itself for six poses, so a six-pose schedule runs exactly as a built-in pack', () => {
    expect(dwellsFor(6)).toBe(DWELL_MS)
  })

  it('keeps the flat dwell first and the ball hold last at every other count', () => {
    expect(dwellsFor(2)).toEqual([95, 90])
    expect(dwellsFor(1)).toEqual([90])
    const twelve = dwellsFor(12) as readonly number[]
    expect(twelve[0]).toBe(95)
    expect(twelve[11]).toBe(90)
  })

  it('resamples the authored cadence linearly: eleven poses land on every authored value', () => {
    expect(dwellsFor(11)).toEqual([95, 83, 70, 95, 120, 98, 75, 105, 135, 113, 90])
  })

  it('returns a frozen table, one entry per pose', () => {
    for (const n of [1, 2, 3, 7, 12]) {
      const table = dwellsFor(n)
      expect(table).not.toBeInstanceOf(Error)
      expect((table as readonly number[]).length).toBe(n)
      expect(Object.isFrozen(table)).toBe(true)
    }
  })

  it('refuses a count that is not a positive integer', () => {
    expect(PackError.is(dwellsFor(0))).toBe(true)
    expect(PackError.is(dwellsFor(2.5))).toBe(true)
    expect(PackError.is(dwellsFor(Number.NaN))).toBe(true)
  })
})

describe('evenKeyFrames (§9.1)', () => {
  it('spreads the poses over the stored frames, first to slot 0 and last to the last slot', () => {
    expect(evenKeyFrames(6, 12)).toEqual([0, 2, 4, 7, 9, 11])
    expect(evenKeyFrames(12, 12)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
    expect(evenKeyFrames(1, 12)).toEqual([0])
  })

  it('repeats slots rather than failing when there are more poses than frames', () => {
    expect(evenKeyFrames(3, 2)).toEqual([0, 1, 1])
    expect(evenKeyFrames(4, 1)).toEqual([0, 0, 0, 0])
  })

  it('is valid under setKeyFrames by construction, for every pair of counts up to twelve', () => {
    for (let poses = 1; poses <= 12; poses++) {
      for (let frames = 1; frames <= 12; frames++) {
        const list = evenKeyFrames(poses, frames)
        expect(list).not.toBeInstanceOf(Error)
        expect(setKeyFrames(list as readonly number[], frames)).not.toBeInstanceOf(Error)
      }
    }
  })

  it('refuses a count that is not a positive integer, and says which', () => {
    expect(String(evenKeyFrames(0, 12))).toMatch(/pose count/)
    expect(String(evenKeyFrames(3, 0))).toMatch(/frame count/)
    expect(PackError.is(evenKeyFrames(1.5, 12))).toBe(true)
  })
})

describe('resolveSchedule', () => {
  it('fills in dwellsFor(keyFrames.length) when none are given', () => {
    const manifest = resolveSchedule({ keyFrames: [0, 2, 4, 6, 8, 11] }, 12)
    expect(manifest).toEqual({ keyFrames: [0, 2, 4, 6, 8, 11], dwells: DWELL_MS })
    const three = resolveSchedule({ keyFrames: [0, 5, 11] }, 12)
    expect(three).toEqual({ keyFrames: [0, 5, 11], dwells: [95, 98, 90] })
  })

  it('keeps an explicit table, as a frozen copy the caller can no longer edit', () => {
    const dwells = [40, 60]
    const r = resolveSchedule({ keyFrames: [0, 11], dwells }, 12)
    expect(r).toEqual({ keyFrames: [0, 11], dwells: [40, 60] })
    expect((r as { dwells: readonly number[] }).dwells).not.toBe(dwells)
    expect(Object.isFrozen(r)).toBe(true)
    expect(Object.isFrozen((r as { dwells: readonly number[] }).dwells)).toBe(true)
    expect(Object.isFrozen((r as { keyFrames: readonly number[] }).keyFrames)).toBe(true)
  })

  it("applies setKeyFrames's rules: pose 0 is slot 0, never decreasing, inside the pack", () => {
    expect(String(resolveSchedule({ keyFrames: [] }, 12))).toMatch(/at least one key frame/)
    expect(String(resolveSchedule({ keyFrames: [1, 2] }, 12))).toMatch(
      /pose 0 must be stored frame 0/,
    )
    expect(String(resolveSchedule({ keyFrames: [0, 3, 2] }, 12))).toMatch(/non-decreasing/)
    expect(String(resolveSchedule({ keyFrames: [0, 12] }, 12))).toMatch(/not a stored slot/)
  })

  it('an infinite frame count checks the structure alone, for a source with no pack resident', () => {
    expect(resolveSchedule({ keyFrames: [0, 999] }, Number.POSITIVE_INFINITY)).not.toBeInstanceOf(
      Error,
    )
    expect(PackError.is(resolveSchedule({ keyFrames: [5] }, Number.POSITIVE_INFINITY))).toBe(true)
  })

  it('refuses a table that does not agree with the key frames, which is the runner precondition', () => {
    expect(String(resolveSchedule({ keyFrames: [0, 11], dwells: [10] }, 12))).toMatch(
      /1 entries for 2 poses/,
    )
    expect(String(resolveSchedule({ keyFrames: [0, 11], dwells: [10, -1] }, 12))).toMatch(
      /entry 1 is -1/,
    )
    expect(PackError.is(resolveSchedule({ keyFrames: [0], dwells: [Number.NaN] }, 12))).toBe(true)
  })
})
