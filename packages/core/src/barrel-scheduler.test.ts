import { describe, expect, it } from 'vitest'
import * as root from './index.js'

/**
 * A subset check and never an exact-set check: `index.ts` is an append-only surface at sync 2 and
 * P2, P3, P4 and P5 all append to it. Asserting the exact set would turn a neighbour's append
 * into a P4 failure.
 */
describe('the stable root, after P4', () => {
  it('exports DWELL_MS, which a consumer chaining by hand needs (§7.2)', () => {
    expect(Object.hasOwn(root, 'DWELL_MS')).toBe(true)
    expect([...(root.DWELL_MS as readonly number[])]).toEqual([95, 70, 120, 75, 135, 90])
  })

  it('still exports what P2 put there, so the append did not rewrite the file', () => {
    for (const name of ['ABORTED', 'isAborted', 'attempt', 'matchError', 'VERSION']) {
      expect(Object.hasOwn(root, name), `P4 clobbered ${name}`).toBe(true)
    }
  })

  it('keeps the scheduler machinery off the public surface', () => {
    // The bus, the stepper, the controller and the decision functions are P9's to consume by
    // relative import. Nothing in the spec puts them on a consumer's surface, and a name on the
    // root is a name the package is stuck with.
    for (const name of [
      'createEventBus',
      'createRunController',
      'runSteps',
      'systemTimers',
      'playPlan',
      'swapPlan',
      'resolvePose',
      'decideCollision',
      'planStagePlay',
      'stagePlayReport',
      'transition',
      'createRun',
    ]) {
      expect(Object.hasOwn(root, name), `leaked internal: ${name}`).toBe(false)
    }
  })
})
