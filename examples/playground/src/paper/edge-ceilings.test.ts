import { describe, expect, it } from 'vitest'
import { ceilingsFor, reserveRadiusFor } from './edge-ceilings'

// Every number below is derived, not guessed — see `edge-ceilings.ts`'s own doc comment for the
// closed form. Pinned to 4 decimals; a `toBeCloseTo` this precise is a change detector for the
// formula, not a licence to fudge a wrong one to make it pass (ruling R10: these are the pinned
// OUTPUTS an assertion exists to record, not the implementation's inputs).
describe('reserveRadiusFor', () => {
  it(
    'is undefined under edgeWidthUnit: percent — the live percent reserve needs handle.artwork ' +
      'and handle.front, neither reachable from the public Sprite (see the doc comment)',
    () => {
      expect(
        reserveRadiusFor({ shape: 'smooth', finish: 'clean', widthUnit: 'percent' }, 0.3),
      ).toBeUndefined()
    },
  )

  it('matches the closed form at smooth/clean, headroom 0.3', () => {
    // r = 47 * 1.53 + 12 = 83.91; frozen = 83.91 * 1.3 = 109.083.
    const r = reserveRadiusFor({ shape: 'smooth', finish: 'clean', widthUnit: 'px' }, 0.3)
    expect(r).toBeCloseTo(109.083, 4)
  })

  it(
    'is the same at torn/clean as at smooth/clean — the width/variance defaults and the zero ' +
      'finish terms under clean do not depend on shape',
    () => {
      const smooth = reserveRadiusFor({ shape: 'smooth', finish: 'clean', widthUnit: 'px' }, 0.3)
      const torn = reserveRadiusFor({ shape: 'torn', finish: 'clean', widthUnit: 'px' }, 0.3)
      expect(torn).toBeCloseTo(smooth as number, 10)
    },
  )

  it('adds the finish terms under paper: r = 47*1.53 + 4*4 + 7 + 12 = 106.91, frozen 138.983', () => {
    const r = reserveRadiusFor({ shape: 'torn', finish: 'paper', widthUnit: 'px' }, 0.3)
    expect(r).toBeCloseTo(138.983, 4)
  })
})

describe('ceilingsFor', () => {
  it('both ceilings are undefined under percent', () => {
    const c = ceilingsFor({ shape: 'smooth', finish: 'clean', widthUnit: 'percent' }, 0.3, {})
    expect(c.widthMax).toBeUndefined()
    expect(c.varianceMax).toBeUndefined()
  })

  it(
    'at the library defaults on smooth/clean, headroom 0.3: widthMax ~63.45, varianceMax ~1.066 ' +
      '(past the descriptor max of 1 — the whole variance range is reachable)',
    () => {
      const c = ceilingsFor({ shape: 'smooth', finish: 'clean', widthUnit: 'px' }, 0.3, {})
      expect(c.widthMax).toBeCloseTo(63.4529, 3)
      expect(c.varianceMax).toBeCloseTo(1.0655, 3)
    },
  )

  it(
    'headroom 0.25 (the pre-fix default) tops the variance ceiling at 0.976 on torn/clean, just ' +
      'short of the descriptor max of 1 — the bug this task fixes',
    () => {
      const c = ceilingsFor({ shape: 'torn', finish: 'clean', widthUnit: 'px' }, 0.25, {})
      expect(c.varianceMax).toBeCloseTo(0.9763, 3)
    },
  )

  it('on torn/paper at the defaults, headroom 0.3: widthMax ~67.96, varianceMax ~1.212', () => {
    const c = ceilingsFor({ shape: 'torn', finish: 'paper', widthUnit: 'px' }, 0.3, {})
    expect(c.widthMax).toBeCloseTo(67.9628, 3)
    expect(c.varianceMax).toBeCloseTo(1.2124, 3)
  })

  it('reads live knob values over defaults: a live edgeVariance of 0 raises the widthMax ceiling', () => {
    const atDefault = ceilingsFor({ shape: 'smooth', finish: 'clean', widthUnit: 'px' }, 0.3, {})
    const atZeroVariance = ceilingsFor({ shape: 'smooth', finish: 'clean', widthUnit: 'px' }, 0.3, {
      'sheet.edgeVariance': 0,
    })
    expect(atZeroVariance.widthMax).toBeGreaterThan(atDefault.widthMax as number)
  })

  it(
    'a live edgeWidth of 0 leaves edgeVariance unconstrained by the reserve (its own descriptor ' +
      'range is the only bound left)',
    () => {
      const c = ceilingsFor({ shape: 'smooth', finish: 'clean', widthUnit: 'px' }, 0.3, {
        'sheet.edgeWidth': 0,
      })
      expect(c.varianceMax).toBe(Number.POSITIVE_INFINITY)
    },
  )
})
