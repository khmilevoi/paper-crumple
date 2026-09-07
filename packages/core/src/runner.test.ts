import { beforeEach, describe, expect, it } from 'vitest'
import { ABORTED } from './abort.js'
import { createEventBus, type EventBus } from './emitter.js'
import { GlError, PoseError } from './errors.js'
import type { Events } from './events.js'
import { createRunController, type RunController, type RunHost } from './runner.js'
import { createFakeTimers, type FakeTimers } from './testing/fake-timers.js'
import type { ViewState } from './view-state.js'

interface Recorded {
  event: string
  payload: unknown
}

interface Harness {
  bus: EventBus
  timers: FakeTimers
  controller: RunController
  events: Recorded[]
  states: ViewState[]
  rendered: number[]
  errors: Error[]
  failAt: (pose: number | null) => void
}

function harness(): Harness {
  const timers = createFakeTimers(0)
  const bus = createEventBus()
  const events: Recorded[] = []
  const states: ViewState[] = []
  const rendered: number[] = []
  const errors: Error[] = []
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
    frameFor: (pose) => pose * 8,
    setState: (state) => {
      states.push(state)
    },
    timers,
  }

  return {
    bus,
    timers,
    controller: createRunController(host, { poseCount: 6 }),
    events,
    states,
    rendered,
    errors,
    failAt: (pose) => {
      failing = pose
    },
  }
}

const names = (events: Recorded[]): string[] => events.map((e) => e.event)
const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

let h: Harness
beforeEach(() => {
  h = harness()
})

describe('start is synchronous, and the bound is the microtask (amendment 22)', () => {
  it('emits start before the first microtask, not merely before the first setTimeout', () => {
    // A body that emits `start` after any `await` passes the setTimeout form and fails this one,
    // which is exactly the edit the amendment exists to catch. The tighter bound is what lets a
    // consumer call AudioContext.resume() from inside the user gesture that started the fold.
    let microtaskRan = false
    queueMicrotask(() => {
      microtaskRan = true
    })
    let sawMicrotask: boolean | null = null
    h.bus.on('start', () => {
      sawMicrotask = microtaskRan
    })
    h.controller.play('flat', 'ball')
    expect(sawMicrotask).toBe(false)
    expect(names(h.events)).toEqual(['start', 'step'])
  })

  it('has already emitted start by the time the call returns', () => {
    const run = h.controller.play('flat', 'ball')
    expect(run).toBeDefined()
    expect(h.events[0].event).toBe('start')
  })

  it('emits start with the resolved indices, never a PoseRef (amendment 21)', () => {
    h.controller.play('flat', 'ball', { duration: 900 })
    expect(h.events[0].payload).toEqual({ from: 0, to: 5, duration: 900 })
  })

  it('omits duration rather than writing duration: undefined', () => {
    h.controller.play('flat', 'ball')
    expect(h.events[0].payload).toStrictEqual({ from: 0, to: 5 })
  })
})

describe('start is always immediately followed by step { pose: from }', () => {
  it('renders the from pose in the same synchronous block, with nothing between', () => {
    h.controller.play(2, 4)
    expect(names(h.events)).toEqual(['start', 'step'])
    expect(h.events[1].payload).toEqual({ pose: 2, frame: 16, ms: 0 })
    expect(h.rendered).toEqual([2])
  })

  it('reports ms as the elapsed run clock, so an audio clip can be synchronised against it', () => {
    h.controller.play('flat', 'ball')
    h.timers.advance(1000)
    const steps = h.events.filter((e) => e.event === 'step').map((e) => e.payload as Events['step'])
    expect(steps.map((s) => s.ms)).toEqual([0, 95, 165, 285, 360, 495])
  })

  it('reports the stored frame the host resolves, not the pose index', () => {
    h.controller.play('flat', 'ball')
    h.timers.advance(1000)
    const steps = h.events.filter((e) => e.event === 'step').map((e) => e.payload as Events['step'])
    expect(steps.map((s) => s.frame)).toEqual([0, 8, 16, 24, 32, 40])
  })
})

describe('exactly one end per start (§7.1)', () => {
  it('on a completed traversal', async () => {
    const run = h.controller.play('flat', 'ball')
    h.timers.advance(1000)
    expect(names(h.events).filter((n) => n === 'end')).toHaveLength(1)
    expect(h.events[h.events.length - 1].payload).toEqual({ from: 0, to: 5, completed: true })
    await expect(run).resolves.toBeUndefined()
  })

  it('on stop(), which is not an exception', async () => {
    const run = h.controller.play('flat', 'ball')
    h.controller.stop()
    expect(names(h.events).filter((n) => n === 'end')).toHaveLength(1)
    expect(h.events[h.events.length - 1].payload).toEqual({ from: 0, to: 5, completed: false })
    await expect(run).resolves.toBe(ABORTED)
  })

  it('on dispose(), which is not an exception', async () => {
    const run = h.controller.play('flat', 'ball')
    h.controller.dispose()
    expect(names(h.events).filter((n) => n === 'end')).toHaveLength(1)
    await expect(run).resolves.toBe(ABORTED)
  })

  it('on supersession, which is not an exception', () => {
    h.controller.play('flat', 'ball')
    h.controller.play('ball', 'flat')
    expect(names(h.events).filter((n) => n === 'end')).toHaveLength(1)
  })

  it('on a run that raised an error, which is not an exception either', () => {
    h.failAt(3)
    h.controller.play('flat', 'ball')
    h.timers.advance(1000)
    expect(names(h.events).filter((n) => n === 'end')).toHaveLength(1)
  })

  it('emits neither for a run that never started', () => {
    h.controller.play('flat', 99)
    expect(h.events).toEqual([])
  })
})

describe('teardown to idle before end (§7.1)', () => {
  it('has cleared the timer and dropped the run before the end handler sees it', () => {
    let liveInsideEnd: boolean | null = null
    let pendingInsideEnd: number | null = null
    h.bus.on('end', () => {
      liveInsideEnd = h.controller.live
      pendingInsideEnd = h.timers.pending
    })
    h.controller.play('flat', 'ball')
    h.timers.advance(1000)
    expect(liveInsideEnd).toBe(false)
    expect(pendingInsideEnd).toBe(0)
  })

  it('is idle by the time end is emitted, which is what lets a play from an end handler run clean', () => {
    const stateAtEnd: ViewState[] = []
    h.bus.on('end', () => stateAtEnd.push(h.states[h.states.length - 1]))
    h.controller.play('flat', 'ball')
    h.timers.advance(1000)
    expect(stateAtEnd).toEqual(['idle'])
  })
})

describe('supersession (§7.1)', () => {
  it('emits end before start, which is the only order that keeps isPlaying correct', () => {
    h.controller.play('flat', 'ball')
    h.events.length = 0
    h.controller.play('ball', 'flat')
    expect(names(h.events)).toEqual(['end', 'start', 'step'])
  })

  it('settles the superseded run to the sentinel, and after the new start', async () => {
    const seen: string[] = []
    h.bus.on('start', () => seen.push('start'))
    const first = h.controller.play('flat', 'ball')
    void first.then(() => seen.push('superseded-settled'))
    seen.length = 0
    h.controller.play('ball', 'flat')
    expect(seen).toEqual(['start'])
    await flush()
    expect(seen).toEqual(['start', 'superseded-settled'])
    await expect(first).resolves.toBe(ABORTED)
  })

  it('settles to ABORTED and never to an AbortedError (amendment 1)', async () => {
    const first = h.controller.play('flat', 'ball')
    h.controller.play('ball', 'flat')
    const settled = await first
    expect(settled).toBe(ABORTED)
    expect(settled).not.toBeInstanceOf(Error)
  })

  it('cancels the outgoing timer, so the superseded run draws no further pose', () => {
    h.controller.play('flat', 'ball')
    h.controller.play(3, 3)
    h.rendered.length = 0
    h.timers.advance(1000)
    expect(h.rendered).toEqual([])
  })
})

describe('error is never terminal on its own, but forces completed: false (§7.1)', () => {
  it('continues the run after a dropped frame — one frame must not kill a hundred-view grid', () => {
    h.failAt(2)
    h.controller.play('flat', 'ball')
    h.timers.advance(1000)
    expect(h.rendered).toEqual([0, 1, 2, 3, 4, 5])
    expect(h.errors).toHaveLength(1)
    expect(h.errors[0]).toBeInstanceOf(GlError)
  })

  it('forces completed: false, or a consumer awaiting end on error hangs forever', () => {
    h.failAt(2)
    h.controller.play('flat', 'ball')
    h.timers.advance(1000)
    expect(h.events[h.events.length - 1].payload).toEqual({ from: 0, to: 5, completed: false })
  })

  it('reports the error through the host, never onto a bus — §10.6 policy is P9 s', () => {
    h.failAt(0)
    h.controller.play('flat', 'ball')
    expect(names(h.events)).not.toContain('error')
    expect(h.errors).toHaveLength(1)
  })

  it('still settles the run to undefined: a dropped frame is not a return value', async () => {
    h.failAt(2)
    const run = h.controller.play('flat', 'ball')
    h.timers.advance(1000)
    await expect(run).resolves.toBeUndefined()
  })

  it('emits step before the error, so start is still immediately followed by step', () => {
    h.failAt(0)
    const order: string[] = []
    h.bus.on('start', () => order.push('start'))
    h.bus.on('step', () => order.push('step'))
    h.controller.play('flat', 'ball')
    expect(order).toEqual(['start', 'step'])
  })
})

describe('completed = reachedTo && noErrorEmitted && notSuperseded', () => {
  const endPayload = (): Events['end'] =>
    h.events.filter((e) => e.event === 'end').map((e) => e.payload as Events['end'])[0]

  it('is true only when all three hold', () => {
    h.controller.play('flat', 'ball')
    h.timers.advance(1000)
    expect(endPayload().completed).toBe(true)
  })

  it('is false when the run did not reach to', () => {
    h.controller.play('flat', 'ball')
    h.timers.advance(200)
    h.controller.stop()
    expect(endPayload().completed).toBe(false)
  })

  it('is false when an error was emitted, even though to was reached', () => {
    h.failAt(5)
    h.controller.play('flat', 'ball')
    h.timers.advance(1000)
    expect(endPayload().completed).toBe(false)
  })
})

describe('stop (§4.5)', () => {
  it('emits nothing on an idle view, or end would appear without a matching start', () => {
    h.controller.stop()
    expect(h.events).toEqual([])
  })

  it('freezes at the current pose and issues no draw — a cancel path must not render', () => {
    h.controller.play('flat', 'ball')
    h.timers.advance(200)
    h.rendered.length = 0
    h.controller.stop()
    expect(h.rendered).toEqual([])
    expect(h.states[h.states.length - 1]).toBe('idle')
    // Cancellation is not a failure: the sentinel is a return value and never reaches reportError.
    expect(h.errors).toEqual([])
  })

  it('is scoped: stage.stop() leaves a view-owned run alone', () => {
    h.controller.play('flat', 'ball', { owner: 'view' })
    h.events.length = 0
    h.controller.stop({ owner: 'stage' })
    expect(h.events).toEqual([])
    expect(h.controller.live).toBe(true)
  })

  it('is scoped: stage.stop({ all: true }) stops everything', () => {
    h.controller.play('flat', 'ball', { owner: 'view' })
    h.controller.stop({ owner: 'stage', all: true })
    expect(h.controller.live).toBe(false)
  })

  it('run.stop() stops that one run whatever its owner', async () => {
    const run = h.controller.play('flat', 'ball', { owner: 'stage' })
    run.stop()
    expect(h.controller.live).toBe(false)
    await expect(run).resolves.toBe(ABORTED)
  })

  it('run.stop() on an already-settled run is a no-op', async () => {
    const run = h.controller.play('flat', 'ball')
    h.timers.advance(1000)
    h.events.length = 0
    run.stop()
    expect(h.events).toEqual([])
    await expect(run).resolves.toBeUndefined()
  })
})

describe('the collision rule applied (§4.4)', () => {
  it('a stage-scoped call loses to a view-owned run, emitting nothing', async () => {
    h.controller.play('flat', 'ball', { owner: 'view' })
    h.events.length = 0
    const skipped = h.controller.play('ball', 'flat', { owner: 'stage' })
    expect(h.events).toEqual([])
    await expect(skipped).resolves.toBe(ABORTED)
    expect(h.controller.owner).toBe('view')
  })

  it('a stage-scoped call supersedes a stage-owned run, because that is a tie', () => {
    h.controller.play('flat', 'ball', { owner: 'stage' })
    h.events.length = 0
    h.controller.play('ball', 'flat', { owner: 'stage' })
    expect(names(h.events)).toEqual(['end', 'start', 'step'])
  })

  it('defaults the owner to view, since view.play is the ordinary caller', () => {
    h.controller.play('flat', 'ball')
    expect(h.controller.owner).toBe('view')
  })
})

describe('argument errors and cancellation before the run (§7.1, §10.5)', () => {
  it('an out-of-range pose emits nothing and settles to the PoseError', async () => {
    const run = h.controller.play('flat', 9)
    expect(h.events).toEqual([])
    await expect(run).resolves.toBeInstanceOf(PoseError)
  })

  it('a pre-aborted signal emits nothing and settles to the sentinel', async () => {
    const controllerAbort = new AbortController()
    controllerAbort.abort()
    const run = h.controller.play('flat', 'ball', { signal: controllerAbort.signal })
    expect(h.events).toEqual([])
    await expect(run).resolves.toBe(ABORTED)
  })

  it('a signal that fires mid-run ends it with completed: false and settles to the sentinel', async () => {
    const controllerAbort = new AbortController()
    const run = h.controller.play('flat', 'ball', { signal: controllerAbort.signal })
    h.timers.advance(200)
    controllerAbort.abort()
    expect(h.events[h.events.length - 1].payload).toEqual({ from: 0, to: 5, completed: false })
    await expect(run).resolves.toBe(ABORTED)
  })

  it('detaches its abort listener when the run settles, so a later abort is inert', () => {
    const controllerAbort = new AbortController()
    h.controller.play('flat', 'ball', { signal: controllerAbort.signal })
    h.timers.advance(1000)
    h.events.length = 0
    controllerAbort.abort()
    expect(h.events).toEqual([])
  })
})

describe('the disposed row (§4.5)', () => {
  it('refuses every later play with the sentinel and emits nothing', async () => {
    h.controller.dispose()
    h.events.length = 0
    const run = h.controller.play('flat', 'ball')
    expect(h.events).toEqual([])
    await expect(run).resolves.toBe(ABORTED)
  })

  it('is idempotent, and stop() on it is a no-op', () => {
    h.controller.dispose()
    expect(() => h.controller.dispose()).not.toThrow()
    expect(() => h.controller.stop()).not.toThrow()
  })

  it('lands on disposed after the end it owed a live run', () => {
    h.controller.play('flat', 'ball')
    h.controller.dispose()
    expect(h.states.slice(-2)).toEqual(['idle', 'disposed'])
  })
})

describe('play(x, x) — legal, and no longer the documented redraw (amendment 15)', () => {
  it('emits the whole triple synchronously for a repaint, which is why it is a pun', () => {
    const run = h.controller.play(3, 3)
    expect(names(h.events)).toEqual(['start', 'step', 'end'])
    expect(h.rendered).toEqual([3])
    expect(h.timers.pending).toBe(0)
    expect(run).toBeDefined()
  })

  it('reports completed: true — one render, zero dwells', () => {
    h.controller.play(3, 3)
    expect(h.events[2].payload).toEqual({ from: 3, to: 3, completed: true })
  })
})

describe('the run clock', () => {
  it('overruns rather than skipping a pose when duration is shorter than the blocking cost', () => {
    h.controller.play('flat', 'ball', { duration: 0 })
    h.timers.advance(1000)
    expect(h.rendered).toEqual([0, 1, 2, 3, 4, 5])
    expect(h.events[h.events.length - 1].payload).toEqual({ from: 0, to: 5, completed: true })
  })

  it('finishes at t=585 rather than t=495 with duration: 585 (§11)', () => {
    let endedAt = -1
    h.bus.on('end', () => {
      endedAt = h.timers.now()
    })
    h.controller.play('flat', 'ball', { duration: 585 })
    h.timers.advance(2000)
    expect(endedAt).toBe(585)
  })

  it('chains with a zero-length seam: 495 + 490 is 985, not 1170', () => {
    // A trailing dwell would make play('flat','ball') cost 585 and reintroduce the 15 % error.
    let firstEnd = -1
    h.bus.once('end', () => {
      firstEnd = h.timers.now()
    })
    h.controller.play('flat', 'ball')
    h.timers.advance(495)
    expect(firstEnd).toBe(495)
    let secondEnd = -1
    h.bus.once('end', () => {
      secondEnd = h.timers.now()
    })
    h.controller.play('ball', 'flat')
    h.timers.advance(490)
    expect(secondEnd).toBe(985)
  })
})

describe('a play() issued from an end handler (§4.5)', () => {
  it('installs the run when the end is a completion: current is null before end, so the view is clean', () => {
    h.bus.on('end', (e: Events['end']) => {
      if (e.completed) h.controller.play(e.to, e.from)
    })
    h.controller.play('flat', 'ball')
    h.timers.advance(495)
    // The documented looping indicator: the first leg completed, and the `play()` from its `end`
    // installed the return leg against an idle controller — no supersession, no second `end`.
    expect(names(h.events).filter((n) => n === 'end')).toHaveLength(1)
    expect(names(h.events).slice(-3)).toEqual(['end', 'start', 'step'])
    expect(h.controller.live).toBe(true)
    expect(h.timers.pending).toBe(1)
  })

  it('refuses the run a handler starts during a supersession: the superseding call wins, and nothing is orphaned', async () => {
    const first = h.controller.play('flat', 'ball')
    let reentrant: ReturnType<RunController['play']> | null = null
    const off = h.bus.on('end', () => {
      off()
      reentrant = h.controller.play(1, 2)
    })
    h.controller.play('ball', 'flat')
    // Two runs, one end: the superseded one's. The handler's `play()` was refused outright rather
    // than installed and then cancelled by the next turn of `supersede`'s loop — so it emitted no
    // `start`, rendered nothing, and left no timer for the caller's `current = r` to orphan.
    expect(names(h.events).filter((n) => n === 'end')).toHaveLength(1)
    expect(names(h.events).filter((n) => n === 'start')).toHaveLength(2)
    expect(h.rendered).toEqual([0, 5])
    expect(h.timers.pending).toBe(1)
    expect(h.controller.live).toBe(true)
    await expect(first).resolves.toBe(ABORTED)
    await expect(reentrant!).resolves.toBe(ABORTED)
  })

  it('cannot be kept alive by a handler that re-plays on every end, completed or not', async () => {
    // The looping indicator written without the `completed` check — the mistake §7.1's
    // `completed: false` convention exists to make harmless. Each `end` the supersede loop emits
    // would otherwise be answered with a fresh run for the next iteration to cancel, forever.
    let ends = 0
    const fromHandler: Array<ReturnType<RunController['play']>> = []
    h.bus.on('end', () => {
      ends += 1
      // A fuse, so the failing shape of this test is a wrong count and not a hung worker.
      if (ends < 50) fromHandler.push(h.controller.play('ball', 'flat'))
    })
    h.controller.play('flat', 'ball')
    h.timers.advance(495)
    // The completion path: the handler's `play()` installed the next leg, as documented.
    expect(ends).toBe(1)
    expect(h.controller.live).toBe(true)

    // A supersession from outside, while the handler's leg is live.
    const outside = h.controller.play(2, 3)
    // Exactly one more `end` — the superseded leg's. The `play()` the handler issued from inside
    // it was refused, so the loop ran once and the outside call installed its run.
    expect(ends).toBe(2)
    expect(names(h.events).slice(-3)).toEqual(['end', 'start', 'step'])
    expect(h.events[h.events.length - 2]?.payload).toEqual({ from: 2, to: 3 })
    expect(h.controller.live).toBe(true)
    expect(h.timers.pending).toBe(1)
    await expect(fromHandler[1]!).resolves.toBe(ABORTED)
    expect(outside).toBeDefined()
  })

  it('stays disposed when a handler starts a run during dispose()', () => {
    h.controller.play('flat', 'ball')
    const off = h.bus.on('end', () => {
      off()
      h.controller.play(1, 2)
    })
    h.controller.dispose()
    expect(h.controller.live).toBe(false)
    expect(h.timers.pending).toBe(0)
    expect(h.states[h.states.length - 1]).toBe('disposed')
  })
})

describe('a teardown from inside the run s first step (§4.5)', () => {
  it('stops the walk when a step handler stops the run, instead of leaking the stepper', () => {
    const off = h.bus.on('step', () => {
      off()
      h.controller.stop()
    })
    h.controller.play('flat', 'ball')
    h.timers.advance(1000)
    // The stop landed inside step 0, before `r.stepper` had been assigned. Without the guard the
    // walk carries on: every remaining pose renders and emits `step` after this run's own `end`.
    expect(h.rendered).toEqual([0])
    expect(h.timers.pending).toBe(0)
    expect(names(h.events)).toEqual(['start', 'step', 'end'])
  })

  it('renders nothing when a start handler disposes the view before the first step', () => {
    const off = h.bus.on('start', () => {
      off()
      h.controller.dispose()
    })
    h.controller.play('flat', 'ball')
    h.timers.advance(1000)
    // `start` is emitted before `runSteps` is even called, so the run is already dead when step 0
    // fires. A cancel path must not render (§4.5).
    expect(h.rendered).toEqual([])
    expect(h.timers.pending).toBe(0)
  })

  it('refuses to install a run when an end handler disposed the view mid-supersession', async () => {
    h.controller.play('flat', 'ball')
    const off = h.bus.on('end', () => {
      off()
      h.controller.dispose()
    })
    const run = h.controller.play('ball', 'flat')
    // The dispose happened inside `supersede`'s `end`. Installing the run anyway would leave it
    // walking on a disposed controller with no way to stop it.
    expect(h.controller.live).toBe(false)
    expect(h.timers.pending).toBe(0)
    await expect(run).resolves.toBe(ABORTED)
  })
})
