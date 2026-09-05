import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTurn } from './next-turn.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('nextTurn() — the platform yield (spec §8.10)', () => {
  it('resolves', async () => {
    await expect(nextTurn()).resolves.toBeUndefined()
  })

  it('does not resolve inside the microtask checkpoint: it is a later macrotask, never a microtask', async () => {
    let done = false
    void nextTurn().then(() => {
      done = true
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(done).toBe(false)
    await nextTurn()
    expect(done).toBe(true)
  })

  it('keeps FIFO order across calls', async () => {
    const order: number[] = []
    void nextTurn().then(() => order.push(1))
    void nextTurn().then(() => order.push(2))
    await nextTurn()
    expect(order).toEqual([1, 2])
  })

  it("prefers a stubbed globalThis.scheduler.postTask and passes { priority: 'user-visible' }", async () => {
    const postTask = vi.fn((fn: () => void, o: { priority: string }) => {
      setTimeout(fn, 0)
      return Promise.resolve(o.priority)
    })
    vi.stubGlobal('scheduler', { postTask })
    await nextTurn()
    expect(postTask).toHaveBeenCalledTimes(1)
    expect(postTask.mock.calls[0]?.[1]).toEqual({ priority: 'user-visible' })
  })
})

describe('nextTurn({ delay }) — the back-off turn (spec §8.10)', () => {
  it('goes to setTimeout(delay) and NOT to postTask, even where postTask exists (its delayed queue is frame-aligned)', async () => {
    const real = globalThis.setTimeout
    const delays: Array<number | undefined> = []
    const postTask = vi.fn((fn: () => void, o: { priority: string }) => {
      real(fn, 0)
      return Promise.resolve(o.priority)
    })
    vi.stubGlobal('scheduler', { postTask })
    vi.stubGlobal('setTimeout', (fn: () => void, ms?: number) => {
      delays.push(ms)
      return real(fn, ms)
    })
    await nextTurn({ delay: 4 })
    expect(delays).toEqual([4])
    expect(
      postTask,
      'a back-off turn is a timer, not a task the scheduler delays',
    ).not.toHaveBeenCalled()
  })

  it('leaves the no-delay options object byte-identical: no delay key for (), ({}) or ({ delay: 0 })', async () => {
    const postTask = vi.fn((fn: () => void, o: { priority: string; delay?: number }) => {
      setTimeout(fn, 0)
      return Promise.resolve(o.priority)
    })
    vi.stubGlobal('scheduler', { postTask })
    await nextTurn()
    await nextTurn({})
    await nextTurn({ delay: 0 })
    expect(postTask).toHaveBeenCalledTimes(3)
    for (const call of postTask.mock.calls) {
      expect(call[1]).toEqual({ priority: 'user-visible' })
      expect('delay' in call[1]).toBe(false)
    }
  })

  it('takes setTimeout(delay) — not the MessageChannel, which cannot delay — when postTask is absent too', async () => {
    const real = globalThis.setTimeout
    const delays: Array<number | undefined> = []
    vi.stubGlobal('scheduler', {})
    vi.stubGlobal('setTimeout', (fn: () => void, ms?: number) => {
      delays.push(ms)
      return real(fn, ms)
    })
    await nextTurn({ delay: 3 })
    expect(delays).toEqual([3])
  })

  it('still takes the MessageChannel route with no delay and no postTask', async () => {
    const real = globalThis.setTimeout
    const delays: Array<number | undefined> = []
    vi.stubGlobal('scheduler', {})
    vi.stubGlobal('setTimeout', (fn: () => void, ms?: number) => {
      delays.push(ms)
      return real(fn, ms)
    })
    await nextTurn()
    expect(delays).toEqual([])
  })
})
