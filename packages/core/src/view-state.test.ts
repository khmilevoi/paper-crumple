import { describe, expect, it } from 'vitest'
import { RUNNING_STATES, transition, type ViewAction, type ViewState } from './view-state.js'

const ALL_STATES: readonly ViewState[] = [
  'idle',
  'playing',
  'crumpling.rise',
  'crumpling.ball',
  'crumpling.fall',
  'crumpling.recover',
  'disposed',
]

const ALL_ACTIONS: readonly ViewAction[] = [
  'show',
  'play',
  'crumpleTo',
  'swapTo',
  'refresh',
  'draw',
  'stop',
  'dispose',
]

describe('the state vocabulary (§4.5)', () => {
  it('is the table exposed, seven states under the table own names, and no `stopped`', () => {
    expect(ALL_STATES).toHaveLength(7)
    expect(ALL_STATES).not.toContain('stopped')
  })

  it('names the five states in which a run is live', () => {
    expect(RUNNING_STATES).toEqual([
      'playing',
      'crumpling.rise',
      'crumpling.ball',
      'crumpling.fall',
      'crumpling.recover',
    ])
  })
})

describe('refresh and draw (amendment 15)', () => {
  it('draw at the current pose and create no run, supersede nothing, emit nothing, move nothing', () => {
    for (const state of RUNNING_STATES.concat('idle')) {
      for (const action of ['refresh', 'draw'] as const) {
        const t = transition(state, action)
        expect(t, `${state}/${action}`).toEqual({
          legal: true,
          endsLiveRun: false,
          startsRun: false,
          draws: true,
          emits: false,
          next: null,
        })
      }
    }
  })

  it('leaves view.state exactly where it was, which is what `next: null` means', () => {
    expect(transition('crumpling.ball', 'refresh').next).toBeNull()
    expect(transition('crumpling.ball', 'draw').next).toBeNull()
  })
})

describe('play, crumpleTo and swapTo', () => {
  it('start a run from idle', () => {
    expect(transition('idle', 'play')).toEqual({
      legal: true,
      endsLiveRun: false,
      startsRun: true,
      draws: true,
      emits: true,
      next: 'playing',
    })
    expect(transition('idle', 'crumpleTo').next).toBe('crumpling.rise')
    expect(transition('idle', 'swapTo').next).toBe('crumpling.rise')
  })

  it('supersede a live run from every running state, ending it first (§7.1)', () => {
    for (const state of RUNNING_STATES) {
      const t = transition(state, 'play')
      expect(t.endsLiveRun, state).toBe(true)
      expect(t.startsRun, state).toBe(true)
      expect(t.next, state).toBe('playing')
    }
  })
})

describe('show', () => {
  it('is instant, draws, and lands idle', () => {
    expect(transition('idle', 'show')).toEqual({
      legal: true,
      endsLiveRun: false,
      startsRun: false,
      draws: true,
      emits: false,
      next: 'idle',
    })
  })

  it('ends a live run first, so the run cannot draw over what show just put up', () => {
    const t = transition('crumpling.fall', 'show')
    expect(t.endsLiveRun).toBe(true)
    expect(t.emits).toBe(true)
    expect(t.next).toBe('idle')
  })
})

describe('stop (§4.5)', () => {
  it('emits nothing on an idle view, or an `end` would appear without a matching `start`', () => {
    expect(transition('idle', 'stop')).toEqual({
      legal: true,
      endsLiveRun: false,
      startsRun: false,
      draws: false,
      emits: false,
      next: 'idle',
    })
  })

  it('is a transition to idle and issues no draw — a cancel path must not render', () => {
    for (const state of RUNNING_STATES) {
      const t = transition(state, 'stop')
      expect(t.draws, state).toBe(false)
      expect(t.endsLiveRun, state).toBe(true)
      expect(t.next, state).toBe('idle')
    }
  })
})

describe('dispose (§4.6)', () => {
  it('ends a live run with completed: false and is terminal', () => {
    const t = transition('playing', 'dispose')
    expect(t.endsLiveRun).toBe(true)
    expect(t.draws).toBe(false)
    expect(t.next).toBe('disposed')
  })

  it('is idempotent', () => {
    expect(transition('disposed', 'dispose')).toEqual({
      legal: true,
      refusal: 'noop',
      endsLiveRun: false,
      startsRun: false,
      draws: false,
      emits: false,
      next: 'disposed',
    })
  })
})

describe('the disposed row', () => {
  it('refuses every call, emits nothing and draws nothing', () => {
    for (const action of ALL_ACTIONS) {
      const t = transition('disposed', action)
      expect(t.emits, action).toBe(false)
      expect(t.draws, action).toBe(false)
      expect(t.startsRun, action).toBe(false)
      expect(t.next, action).toBe('disposed')
    }
  })

  it('refuses the three Run-returning calls with ABORTED, because PlayResult has no SheetError', () => {
    for (const action of ['play', 'crumpleTo', 'swapTo'] as const) {
      expect(transition('disposed', action).refusal, action).toBe('aborted')
      expect(transition('disposed', action).legal, action).toBe(false)
    }
  })

  it('refuses show with a SheetError, which is the one refusal §4.5 can still express', () => {
    expect(transition('disposed', 'show').refusal).toBe('SheetError')
  })

  it('makes the void-returning calls no-ops, since they have nothing to return an error in', () => {
    for (const action of ['refresh', 'draw', 'stop'] as const) {
      expect(transition('disposed', action).refusal, action).toBe('noop')
    }
  })
})

describe('the table is total', () => {
  it('answers every state × action pair', () => {
    for (const state of ALL_STATES) {
      for (const action of ALL_ACTIONS) {
        expect(transition(state, action), `${state}/${action}`).toBeTypeOf('object')
      }
    }
  })
})
