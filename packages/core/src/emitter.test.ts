import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EventName, Events, StageEvent } from './events.js'
import { createEventBus, logUnobserved, rethrowFromMicrotask } from './emitter.js'

const START: Events['start'] = { from: 0, to: 5 }

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('on / once (§7.1)', () => {
  it('returns an unsubscribe closure rather than an Error union, because subscribing cannot fail', () => {
    const bus = createEventBus()
    const off = bus.on('start', () => {})
    expect(typeof off).toBe('function')
    expect(off).not.toBeInstanceOf(Error)
  })

  it('emits in registration order', () => {
    const bus = createEventBus()
    const seen: string[] = []
    bus.on('start', () => seen.push('a'))
    bus.on('start', () => seen.push('b'))
    bus.on('start', () => seen.push('c'))
    bus.emit('start', START)
    expect(seen).toEqual(['a', 'b', 'c'])
  })

  it('delivers the payload unchanged', () => {
    const bus = createEventBus()
    const seen: Array<Events['start']> = []
    bus.on('start', (e) => seen.push(e))
    bus.emit('start', START)
    expect(seen).toEqual([START])
  })

  it('registers the same function twice and calls it twice', () => {
    const bus = createEventBus()
    const fn = vi.fn()
    bus.on('start', fn)
    bus.on('start', fn)
    bus.emit('start', START)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('unsubscribes, and is idempotent about it', () => {
    const bus = createEventBus()
    const fn = vi.fn()
    const off = bus.on('start', fn)
    off()
    off()
    bus.emit('start', START)
    expect(fn).not.toHaveBeenCalled()
    expect(bus.listenerCount('start')).toBe(0)
  })

  it('does not call a listener unsubscribed by an earlier listener in the same emit', () => {
    const bus = createEventBus()
    const later = vi.fn()
    let off = (): void => {}
    bus.on('start', () => off())
    off = bus.on('start', later)
    bus.emit('start', START)
    expect(later).not.toHaveBeenCalled()
  })

  it('does not deliver the current emit to a listener added during it', () => {
    const bus = createEventBus()
    const added = vi.fn()
    bus.on('start', () => {
      bus.on('start', added)
    })
    bus.emit('start', START)
    expect(added).not.toHaveBeenCalled()
  })

  it('once fires exactly once and its closure removes it before it fires', () => {
    const bus = createEventBus()
    const fired = vi.fn()
    bus.once('start', fired)
    bus.emit('start', START)
    bus.emit('start', START)
    expect(fired).toHaveBeenCalledTimes(1)
    expect(bus.listenerCount('start')).toBe(0)

    const never = vi.fn()
    bus.once('start', never)()
    bus.emit('start', START)
    expect(never).not.toHaveBeenCalled()
  })

  it('clear() drops every listener on every event', () => {
    const bus = createEventBus()
    bus.on('start', () => {})
    bus.on('end', () => {})
    bus.clear()
    expect(bus.listenerCount('start')).toBe(0)
    expect(bus.listenerCount('end')).toBe(0)
  })
})

describe('a listener that throws (§7.1)', () => {
  it('does not interrupt emission, and the exception reaches rethrow exactly once', () => {
    const rethrow = vi.fn()
    const bus = createEventBus({ rethrow })
    const boom = new TypeError('listener blew up')
    const after = vi.fn()
    bus.on('start', () => {
      // eslint-disable-next-line no-restricted-syntax
      throw boom
    })
    bus.on('start', after)
    bus.emit('start', START)
    expect(after).toHaveBeenCalledTimes(1)
    expect(rethrow).toHaveBeenCalledTimes(1)
    expect(rethrow).toHaveBeenCalledWith(boom)
  })

  it('hands the thrown value through untouched, even when it is not an Error', () => {
    const rethrow = vi.fn()
    const bus = createEventBus({ rethrow })
    bus.on('start', () => {
      // eslint-disable-next-line no-restricted-syntax
      throw 'a string, which is pathological but legal'
    })
    bus.emit('start', START)
    expect(rethrow).toHaveBeenCalledWith('a string, which is pathological but legal')
  })
})

describe('rethrowFromMicrotask', () => {
  it('schedules on a microtask, and the scheduled callback throws the original error', () => {
    const scheduled: Array<() => void> = []
    vi.stubGlobal('queueMicrotask', (fn: () => void) => {
      scheduled.push(fn)
    })
    const boom = new RangeError('the original')
    rethrowFromMicrotask(boom)
    expect(scheduled).toHaveLength(1)
    expect(() => scheduled[0]()).toThrow(boom)
  })

  it('wraps a non-Error so something with a stack reaches the console', () => {
    const scheduled: Array<() => void> = []
    vi.stubGlobal('queueMicrotask', (fn: () => void) => {
      scheduled.push(fn)
    })
    rethrowFromMicrotask('not an error')
    expect(() => scheduled[0]()).toThrow(Error)
    expect(() => scheduled[0]()).toThrow(/threw a non-Error value/)
  })
})

describe('the relay (§7.1: the stage re-emits after the last view listener returns)', () => {
  it('runs after the last listener and inside the emit', () => {
    const seen: string[] = []
    const bus = createEventBus({
      relay: (event) => {
        seen.push(`relay:${event}`)
      },
    })
    bus.on('start', () => seen.push('a'))
    bus.on('start', () => seen.push('b'))
    bus.emit('start', START)
    expect(seen).toEqual(['a', 'b', 'relay:start'])
  })

  it('runs even with no listeners at all', () => {
    const relay = vi.fn()
    const bus = createEventBus({ relay })
    bus.emit('end', { from: 0, to: 5, completed: true })
    expect(relay).toHaveBeenCalledTimes(1)
  })

  it('a throwing relay does not escape the emit', () => {
    const rethrow = vi.fn()
    const boom = new Error('relay blew up')
    const bus = createEventBus({
      rethrow,
      relay: () => {
        // eslint-disable-next-line no-restricted-syntax
        throw boom
      },
    })
    expect(() => bus.emit('start', START)).not.toThrow()
    expect(rethrow).toHaveBeenCalledWith(boom)
  })

  it('receives the event name and the very payload the listeners saw, before emit returns', () => {
    const relay = vi.fn()
    const bus = createEventBus({ relay })
    let payloadAtListener: Events['start'] | null = null
    bus.on('start', (e) => {
      payloadAtListener = e
    })
    bus.emit('start', START)
    // Synchronous, so the stage's re-emission lands in the same block as the view's event — a
    // `start` the stage relays is still inside the gesture that began the run.
    expect(relay).toHaveBeenCalledTimes(1)
    expect(relay).toHaveBeenCalledWith('start', START)
    expect(relay.mock.calls[0][1]).toBe(payloadAtListener)
  })

  it('runs after a listener registered later than the bus was created — registration order does not decide it', () => {
    // The stage builds a view's bus, with its relay, before the consumer ever calls `view.on`.
    // A relay implemented as a listener would run first; the option runs last.
    const seen: string[] = []
    const bus = createEventBus({
      relay: () => {
        seen.push('relay')
      },
    })
    bus.on('end', () => seen.push('consumer'))
    bus.emit('end', { from: 0, to: 5, completed: true })
    expect(seen).toEqual(['consumer', 'relay'])
  })
})

describe('the unobserved-error fallback (§10.6)', () => {
  const orphan = { error: new Error('inside a timer'), observed: false }

  it('fires when nothing is subscribed and the error is unobserved', () => {
    const onUnobserved = vi.fn()
    const bus = createEventBus({ onUnobserved })
    bus.emit('error', orphan)
    expect(onUnobserved).toHaveBeenCalledWith(orphan.error)
  })

  it('fires at most once per bus, because logging every dropped frame teaches the console away', () => {
    const onUnobserved = vi.fn()
    const bus = createEventBus({ onUnobserved })
    bus.emit('error', orphan)
    bus.emit('error', { error: new Error('another'), observed: false })
    expect(onUnobserved).toHaveBeenCalledTimes(1)
  })

  it('never fires for an observed error, which the caller is about to narrow', () => {
    const onUnobserved = vi.fn()
    const bus = createEventBus({ onUnobserved })
    bus.emit('error', { error: new Error('returned too'), observed: true })
    expect(onUnobserved).not.toHaveBeenCalled()
  })

  it('never fires when a listener is attached', () => {
    const onUnobserved = vi.fn()
    const bus = createEventBus({ onUnobserved })
    bus.on('error', () => {})
    bus.emit('error', orphan)
    expect(onUnobserved).not.toHaveBeenCalled()
  })

  it('is silent by default, which is what a view bus wants — the stage logs, not the view', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const bus = createEventBus()
    bus.emit('error', orphan)
    expect(spy).not.toHaveBeenCalled()
  })

  it('logUnobserved is the ready-made stage form, and names the way to turn it off', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const boom = new Error('orphan')
    logUnobserved(boom)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(String(spy.mock.calls[0][0])).toMatch(/stage\.on\('error'/)
    expect(spy.mock.calls[0][1]).toBe(boom)
  })
})

describe('the stage-side widening', () => {
  it('accepts a payload map whose members carry view, which is what StageEvent adds', () => {
    type StageEvents = { [E in EventName]: StageEvent<E> }
    const bus = createEventBus<StageEvents>()
    const seen: Array<StageEvent<'error'>> = []
    bus.on('error', (e) => seen.push(e))
    const payload: StageEvent<'error'> = { error: new Error('x'), observed: true, view: null }
    bus.emit('error', payload)
    expect(seen).toEqual([payload])
  })
})
