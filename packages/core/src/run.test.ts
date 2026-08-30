import { describe, expect, it, vi } from 'vitest'
import { ABORTED } from './abort.js'
import { PoseError } from './errors.js'
import type { PlayResult } from './results.js'
import { createRun, settledRun } from './run.js'

describe('createRun (amendment 22)', () => {
  it('is a thenable, so `await view.play(…)` reads exactly as it did', async () => {
    const handle = createRun<PlayResult>(() => {})
    handle.settle(undefined)
    await expect(handle.run).resolves.toBeUndefined()
  })

  it('is not a promise, which is the whole point', () => {
    const { run } = createRun<PlayResult>(() => {})
    expect(run).not.toBeInstanceOf(Promise)
    expect('catch' in run).toBe(false)
    expect('finally' in run).toBe(false)
  })

  it('exposes `done` as a real promise for the consumer who wants one', async () => {
    const handle = createRun<PlayResult>(() => {})
    expect(handle.run.done).toBeInstanceOf(Promise)
    handle.settle(undefined)
    await expect(handle.run.done).resolves.toBeUndefined()
  })

  it('resolves to an Error rather than rejecting (§10.8)', async () => {
    const handle = createRun<PlayResult>(() => {})
    const boom = new PoseError('pose 9 is out of range')
    handle.settle(boom)
    await expect(handle.run).resolves.toBe(boom)
    await expect(handle.run.done).resolves.toBe(boom)
  })

  it('carries the abort sentinel, which is a return and not a failure', async () => {
    const handle = createRun<PlayResult>(() => {})
    handle.settle(ABORTED)
    await expect(handle.run).resolves.toBe(ABORTED)
  })

  it('settles once — the first call wins and later ones are ignored', async () => {
    const handle = createRun<PlayResult>(() => {})
    expect(handle.settled).toBe(false)
    handle.settle(undefined)
    expect(handle.settled).toBe(true)
    handle.settle(ABORTED)
    await expect(handle.run).resolves.toBeUndefined()
  })

  it('settles on a microtask from the awaiter s point of view, never synchronously', async () => {
    const handle = createRun<PlayResult>(() => {})
    const seen: string[] = []
    void handle.run.then(() => seen.push('settled'))
    handle.settle(undefined)
    expect(seen).toEqual([])
    await Promise.resolve()
    expect(seen).toEqual(['settled'])
  })

  it('stop() calls the closure it was built with, and nothing else', () => {
    const stop = vi.fn()
    const { run } = createRun<PlayResult>(stop)
    run.stop()
    expect(stop).toHaveBeenCalledTimes(1)
    run.stop()
    expect(stop).toHaveBeenCalledTimes(2)
  })

  it('never rejects, so an unawaited run cannot become an unhandled rejection', async () => {
    const handle = createRun<PlayResult>(() => {})
    handle.settle(new PoseError('bad'))
    const outcome = await handle.run.done.then(
      () => 'resolved',
      () => 'rejected',
    )
    expect(outcome).toBe('resolved')
  })
})

describe('settledRun', () => {
  it('is the refused call: already settled, and stopping it does nothing', async () => {
    const run = settledRun<PlayResult>(ABORTED)
    await expect(run).resolves.toBe(ABORTED)
    expect(() => run.stop()).not.toThrow()
  })
})
