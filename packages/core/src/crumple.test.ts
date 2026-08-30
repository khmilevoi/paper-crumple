import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ABORTED } from './abort.js'
import { createEventBus, type EventBus } from './emitter.js'
import { AssetError, GlError, SheetError } from './errors.js'
import type { Events } from './events.js'
import { createRunController, type RunController, type RunHost } from './runner.js'
import { createFakeTimers, type FakeTimers } from './testing/fake-timers.js'
import type { ViewState } from './view-state.js'

interface Sprite {
  readonly key: string
}

interface Recorded {
  event: string
  payload: unknown
}

interface Harness {
  bus: EventBus
  timers: FakeTimers
  controller: RunController<Sprite>
  events: Recorded[]
  states: ViewState[]
  rendered: number[]
  errors: Error[]
  adopted: Sprite[]
  failAt: (pose: number | null) => void
}

function harness(): Harness {
  const timers = createFakeTimers(0)
  const bus = createEventBus()
  const events: Recorded[] = []
  const states: ViewState[] = []
  const rendered: number[] = []
  const errors: Error[] = []
  const adopted: Sprite[] = []
  let failing: number | null = null

  const host: RunHost = {
    emit: (event, payload) => {
      events.push({ event, payload })
      bus.emit(event, payload)
    },
    reportError: (error) => {
      errors.push(error)
    },
    render: (pose) => {
      rendered.push(pose)
      return failing === pose ? new GlError(`draw failed at pose ${pose}`) : undefined
    },
    frameFor: (pose) => pose,
    setState: (state) => {
      states.push(state)
    },
    timers,
  }

  const controller = createRunController<Sprite>(host, { poseCount: 6 })
  return {
    bus,
    timers,
    controller,
    events,
    states,
    rendered,
    errors,
    adopted,
    failAt: (pose) => {
      failing = pose
    },
  }
}

const names = (events: Recorded[]): string[] => events.map((e) => e.event)
const settle = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

let h: Harness
const adopt = (sprite: Sprite): undefined => {
  h.adopted.push(sprite)
  return undefined
}

beforeEach(() => {
  h = harness()
})

describe('the crumple is one run (§7.1)', () => {
  it('emits one start with via: 5, and one end, across eleven renders', async () => {
    const run = h.controller.crumple(0, { key: 'b' }, { adopt })
    await settle()
    h.timers.advance(2000)
    expect(h.events[0].payload).toEqual({ from: 0, to: 0, via: 5 })
    expect(names(h.events).filter((n) => n === 'start')).toHaveLength(1)
    expect(names(h.events).filter((n) => n === 'end')).toHaveLength(1)
    expect(h.rendered).toEqual([0, 1, 2, 3, 4, 5, 4, 3, 2, 1, 0])
    await expect(run).resolves.toBeUndefined()
  })

  it('emits start synchronously, before the first microtask — swapTo inherits this exactly', () => {
    let microtaskRan = false
    queueMicrotask(() => {
      microtaskRan = true
    })
    let sawMicrotask: boolean | null = null
    h.bus.on('start', () => {
      sawMicrotask = microtaskRan
    })
    h.controller.crumple(0, { key: 'b' }, { adopt })
    expect(sawMicrotask).toBe(false)
    expect(names(h.events)).toEqual(['start', 'step'])
  })

  it('renders pose 5 exactly once, by the outgoing sprite', async () => {
    h.controller.crumple(0, { key: 'b' }, { adopt })
    await settle()
    h.timers.advance(2000)
    expect(h.rendered.filter((p) => p === 5)).toHaveLength(1)
    expect(h.adopted).toEqual([{ key: 'b' }])
    // The sprite is adopted between the pose-5 render and the pose-4 render, so the first frame
    // drawn with the incoming bucket is pose 4 — that bucket's own geometry anyway.
    expect(h.rendered.indexOf(4, h.rendered.indexOf(5))).toBe(6)
  })

  it('from the ball there is no rise and no extra pose-5 render', async () => {
    h.controller.crumple('ball', { key: 'b' }, { adopt })
    await settle()
    h.timers.advance(2000)
    expect(h.rendered).toEqual([5, 4, 3, 2, 1, 0])
  })
})

describe('the timing (§7.2)', () => {
  it('costs 985 ms from pose 0 when the target is already settled', async () => {
    let endedAt = -1
    h.bus.on('end', () => {
      endedAt = h.timers.now()
    })
    h.controller.crumple(0, { key: 'b' }, { adopt })
    await settle()
    h.timers.advance(2000)
    expect(endedAt).toBe(985)
  })

  it('holds at the ball for DWELL_MS[5], the gap no ordinary traversal ever spends', async () => {
    const at: Array<{ pose: number; ms: number }> = []
    h.bus.on('step', (e: Events['step']) => at.push({ pose: e.pose, ms: e.ms }))
    h.controller.crumple(0, { key: 'b' }, { adopt })
    await settle()
    h.timers.advance(2000)
    const ball = at.find((s) => s.pose === 5)
    const firstFall = at[at.indexOf(ball!) + 1]
    expect(ball!.ms).toBe(495)
    expect(firstFall.ms - ball!.ms).toBe(90)
  })

  it('rescales all ten gaps, the ball dwell included, by one multiplier', async () => {
    let endedAt = -1
    h.bus.on('end', () => {
      endedAt = h.timers.now()
    })
    h.controller.crumple(0, { key: 'b' }, { adopt, duration: 1970 })
    await settle()
    h.timers.advance(4000)
    expect(endedAt).toBeCloseTo(1970, 6)
  })
})

describe('the park (§7.2: park time is never rescaled)', () => {
  it('waits at the ball for as long as the work takes, with no draws', async () => {
    let resolveTarget: (s: Sprite) => void = () => {}
    const target = new Promise<Sprite>((r) => {
      resolveTarget = r
    })
    h.controller.crumple(0, target, { adopt })
    h.timers.advance(600)
    expect(h.rendered).toEqual([0, 1, 2, 3, 4, 5])
    expect(h.states[h.states.length - 1]).toBe('crumpling.ball')
    // Two seconds of parking, and not one extra draw.
    h.timers.advance(2000)
    expect(h.rendered).toEqual([0, 1, 2, 3, 4, 5])
    resolveTarget({ key: 'b' })
    await settle()
    h.timers.advance(2000)
    expect(h.rendered).toEqual([0, 1, 2, 3, 4, 5, 4, 3, 2, 1, 0])
  })

  it('re-bases the deadline on leaving the ball, so a stall is not debt the descent catches up on', async () => {
    let resolveTarget: (s: Sprite) => void = () => {}
    const target = new Promise<Sprite>((r) => {
      resolveTarget = r
    })
    const stepAt: Array<{ pose: number; at: number }> = []
    h.bus.on('step', (e: Events['step']) => stepAt.push({ pose: e.pose, at: h.timers.now() }))
    h.controller.crumple(0, target, { adopt })
    h.timers.advance(3000)
    resolveTarget({ key: 'b' })
    await settle()
    h.timers.advance(2000)
    const leftBallAt = stepAt.find((s) => s.pose === 4 && s.at > 495)!.at
    const endAt = stepAt[stepAt.length - 1].at
    // The whole 400 ms fall is spent after the ball is left; none of it is swallowed as debt.
    expect(endAt - leftBallAt).toBe(400)
    expect(leftBallAt).toBeGreaterThanOrEqual(3000)
  })

  it('holds at least the scaled ball dwell even when the target is already settled', async () => {
    const stepAt: Array<{ pose: number; at: number }> = []
    h.bus.on('step', (e: Events['step']) => stepAt.push({ pose: e.pose, at: h.timers.now() }))
    h.controller.crumple(0, { key: 'b' }, { adopt })
    await settle()
    h.timers.advance(2000)
    const ballAt = stepAt.find((s) => s.pose === 5)!.at
    const fallAt = stepAt.find((s) => s.pose === 4 && s.at > ballAt)!.at
    expect(fallAt - ballAt).toBe(90)
  })
})

describe('target failure rolls back (§7.1)', () => {
  it('emits error at the ball, descends on the old sprite, and ends a full descent later', async () => {
    const boom = new SheetError('the pending sprite never built')
    h.controller.crumple(0, Promise.resolve(boom), { adopt })
    await settle()
    h.timers.advance(600)
    expect(h.errors).toEqual([boom])
    expect(h.states[h.states.length - 1]).toBe('crumpling.recover')
    expect(h.adopted).toEqual([])
    const endsSoFar = names(h.events).filter((n) => n === 'end')
    expect(endsSoFar).toHaveLength(0)
    h.timers.advance(2000)
    expect(h.rendered).toEqual([0, 1, 2, 3, 4, 5, 4, 3, 2, 1, 0])
    expect(names(h.events).filter((n) => n === 'end')).toHaveLength(1)
  })

  it('settles to the target error, so `if (r instanceof Error)` narrows after the rollback', async () => {
    const boom = new SheetError('the pending sprite never built')
    const run = h.controller.crumple(0, Promise.resolve(boom), { adopt })
    await settle()
    h.timers.advance(2000)
    await expect(run).resolves.toBe(boom)
  })

  it('forces completed: false, because an error was emitted', async () => {
    h.controller.crumple(0, Promise.resolve(new SheetError('nope')), { adopt })
    await settle()
    h.timers.advance(2000)
    const end = h.events.filter((e) => e.event === 'end')[0].payload as Events['end']
    expect(end).toEqual({ from: 0, to: 0, completed: false })
  })

  it('treats a failing adopt exactly as a failed target', async () => {
    const boom = new GlError('the incoming bucket would not bind')
    h.controller.crumple(
      0,
      { key: 'b' },
      {
        adopt: () => boom,
      },
    )
    await settle()
    h.timers.advance(2000)
    expect(h.errors).toEqual([boom])
    expect(h.states).toContain('crumpling.recover')
  })

  it('wraps a rejected target promise, since a paper-crumple promise resolves rather than rejects', async () => {
    h.controller.crumple(0, Promise.reject(new Error('foreign')), { adopt })
    await settle()
    h.timers.advance(2000)
    expect(h.errors[0]).toBeInstanceOf(AssetError)
    expect((h.errors[0] as Error).cause).toBeInstanceOf(Error)
  })
})

describe('an aborted target is a cancellation, not a failure (§10.5, §4.5)', () => {
  it('emits no error at all, because a returned ABORTED is never emitted', async () => {
    h.controller.crumple(0, Promise.resolve(ABORTED), { adopt })
    await settle()
    h.timers.advance(2000)
    expect(h.errors).toEqual([])
  })

  it('freezes at the ball and issues no draw — a cancel path must not render', async () => {
    h.controller.crumple(0, Promise.resolve(ABORTED), { adopt })
    await settle()
    h.timers.advance(2000)
    expect(h.rendered).toEqual([0, 1, 2, 3, 4, 5])
    expect(h.states[h.states.length - 1]).toBe('idle')
  })

  it('still emits exactly one end, with completed: false, and settles to the sentinel', async () => {
    const run = h.controller.crumple(0, Promise.resolve(ABORTED), { adopt })
    await settle()
    h.timers.advance(2000)
    expect(names(h.events).filter((n) => n === 'end')).toHaveLength(1)
    await expect(run).resolves.toBe(ABORTED)
  })
})

describe('supersession and cancellation of a parked run', () => {
  it('releases the pending target: a late settle changes nothing', async () => {
    let resolveTarget: (s: Sprite) => void = () => {}
    const target = new Promise<Sprite>((r) => {
      resolveTarget = r
    })
    const first = h.controller.crumple(0, target, { adopt })
    h.timers.advance(600)
    h.controller.play('ball', 'flat')
    h.rendered.length = 0
    h.adopted.length = 0
    resolveTarget({ key: 'b' })
    await settle()
    h.timers.advance(2000)
    expect(h.adopted).toEqual([])
    await expect(first).resolves.toBe(ABORTED)
  })

  it('clears the park timer, so a superseded run arms nothing', async () => {
    const target = new Promise<Sprite>(() => {})
    h.controller.crumple(0, target, { adopt })
    h.timers.advance(400)
    h.controller.stop()
    expect(h.timers.pending).toBe(0)
    expect(h.controller.live).toBe(false)
  })

  it('a signal that fires while parked ends the run and draws nothing more', async () => {
    const ac = new AbortController()
    const target = new Promise<Sprite>(() => {})
    const run = h.controller.crumple(0, target, { adopt, signal: ac.signal })
    h.timers.advance(600)
    h.rendered.length = 0
    ac.abort()
    h.timers.advance(2000)
    expect(h.rendered).toEqual([])
    await expect(run).resolves.toBe(ABORTED)
  })
})

describe('the states it moves through (§4.5)', () => {
  it('rise, ball, fall, idle — under the table s own names', async () => {
    h.controller.crumple(0, { key: 'b' }, { adopt })
    await settle()
    h.timers.advance(2000)
    expect(h.states).toEqual(['crumpling.rise', 'crumpling.ball', 'crumpling.fall', 'idle'])
  })

  it('enters crumpling.ball directly when there is no rise, never showing crumpling.rise', async () => {
    h.controller.crumple('ball', { key: 'b' }, { adopt })
    await settle()
    h.timers.advance(2000)
    expect(h.states).toEqual(['crumpling.ball', 'crumpling.fall', 'idle'])
  })

  it('uses crumpling.recover rather than crumpling.fall after a target failure', async () => {
    h.controller.crumple(0, Promise.resolve(new SheetError('nope')), { adopt })
    await settle()
    h.timers.advance(2000)
    expect(h.states).toEqual(['crumpling.rise', 'crumpling.ball', 'crumpling.recover', 'idle'])
  })
})

describe('refusals', () => {
  it('refuses a bad from pose, emitting nothing', async () => {
    const run = h.controller.crumple(9, { key: 'b' }, { adopt })
    expect(h.events).toEqual([])
    await expect(run).resolves.toBeInstanceOf(Error)
  })

  it('refuses on a disposed controller with the sentinel', async () => {
    h.controller.dispose()
    h.events.length = 0
    const run = h.controller.crumple(0, { key: 'b' }, { adopt })
    expect(h.events).toEqual([])
    await expect(run).resolves.toBe(ABORTED)
  })

  it('works without an adopt hook, for a caller that swaps nothing', async () => {
    const noop = vi.fn()
    h.bus.on('end', noop)
    const run = h.controller.crumple(0, { key: 'b' })
    await settle()
    h.timers.advance(2000)
    expect(noop).toHaveBeenCalledTimes(1)
    await expect(run).resolves.toBeUndefined()
  })
})
