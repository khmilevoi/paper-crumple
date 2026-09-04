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
