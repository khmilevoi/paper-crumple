import { describe, expect, it } from 'vitest'
import { createRebuildQueue, REBUILD_BUDGET_MS } from './rebuild-queue.js'
import { createFakeTimers } from './testing/fake-timers.js'

function harness(costMs: Record<string, number> = {}) {
  const timers = createFakeTimers()
  const built: string[] = []
  const queue = createRebuildQueue({
    timers,
    rebuild: (key) => {
      built.push(key)
      timers.freeze(costMs[key] ?? 1)
    },
  })
  return { timers, built, queue }
}

describe('the rebuild queue', () => {
  it('drains in insertion order and clears the dirty flag as it goes', () => {
    const h = harness()
    h.queue.mark('a')
    h.queue.mark('b')
    expect(h.queue.dirty('a')).toBe(true)
    expect(h.queue.drain({ demand: 'show' })).toEqual(['a', 'b'])
    expect(h.queue.dirty('a')).toBe(false)
    expect(h.queue.size).toBe(0)
  })

  it('marks a key once however often it is dirtied — a 60 Hz slider is one rebuild', () => {
    const h = harness()
    for (let i = 0; i < 60; i += 1) h.queue.mark('a')
    expect(h.queue.size).toBe(1)
    expect(h.queue.drain({ demand: 'front-set' })).toEqual(['a'])
  })

  it(`stops at the ${REBUILD_BUDGET_MS} ms budget and leaves the rest queued`, () => {
    const h = harness({ a: 3, b: 3, c: 3 })
    h.queue.mark('a')
    h.queue.mark('b')
    h.queue.mark('c')
    expect(h.queue.drain({ demand: 'step' })).toEqual(['a', 'b'])
    expect(h.queue.size).toBe(1)
    expect(h.queue.dirty('c')).toBe(true)
  })

  it('always completes the mandatory item, whatever it costs, and puts it first', () => {
    const h = harness({ a: 3, mandatory: 50 })
    h.queue.mark('a')
    h.queue.mark('mandatory')
    // The mandatory item alone blows the budget; it still runs, and nothing else does.
    expect(h.queue.drain({ demand: 'step', mandatory: 'mandatory' })).toEqual(['mandatory'])
    expect(h.queue.dirty('a')).toBe(true)
  })

  it('builds a mandatory item that was never marked dirty', () => {
    const h = harness()
    expect(h.queue.drain({ demand: 'show', mandatory: 'fresh' })).toEqual(['fresh'])
  })

  it('forget() drops a queued key without building it, for a removed sprite', () => {
    const h = harness()
    h.queue.mark('gone')
    h.queue.forget('gone')
    expect(h.queue.drain({ demand: 'prepare' })).toEqual([])
    expect(h.built).toEqual([])
  })

  it('is re-entrant-safe: a rebuild that marks another key does not extend this drain', () => {
    const timers = createFakeTimers()
    const built: string[] = []
    const queue = createRebuildQueue({
      timers,
      rebuild: (key) => {
        built.push(key)
        timers.freeze(1)
        if (key === 'a') queue.mark('late')
      },
    })
    queue.mark('a')
    expect(queue.drain({ demand: 'target-settled' })).toEqual(['a'])
    expect(queue.dirty('late')).toBe(true)
  })
})
