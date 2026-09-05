import { describe, expect, it, vi } from 'vitest'
import { ABORTED, raceAbort } from './abort.js'

/** A promise the test settles by hand. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('raceAbort (§5.2 amendment, §10.5): the cancellable wait on a shared promise', () => {
  it('is the promise itself without a signal', async () => {
    const d = deferred<number>()
    const raced = raceAbort(d.promise, undefined)
    expect(raced).toBe(d.promise)
    d.resolve(7)
    expect(await raced).toBe(7)
  })

  it('resolves ABORTED the moment the signal fires, leaving the shared promise pending and untouched', async () => {
    const d = deferred<number>()
    const controller = new AbortController()
    let settled = false
    void d.promise.then(() => {
      settled = true
    })
    const raced = raceAbort(d.promise, controller.signal)
    controller.abort()
    expect(await raced).toBe(ABORTED)
    expect(settled).toBe(false)
    // The promise still serves its other callers.
    d.resolve(3)
    expect(await d.promise).toBe(3)
  })

  it('resolves the value when the promise wins, and takes its listener off the signal', async () => {
    const d = deferred<string>()
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const raced = raceAbort(d.promise, controller.signal)
    d.resolve('linked')
    expect(await raced).toBe('linked')
    expect(remove).toHaveBeenCalledTimes(1)
    expect(remove.mock.calls[0]?.[0]).toBe('abort')
    // An abort after the wait ended is nobody's business here.
    controller.abort()
    expect(await raced).toBe('linked')
  })

  it('answers ABORTED without subscribing when the signal is already aborted', async () => {
    const d = deferred<number>()
    const controller = new AbortController()
    controller.abort()
    const add = vi.spyOn(controller.signal, 'addEventListener')
    expect(await raceAbort(d.promise, controller.signal)).toBe(ABORTED)
    expect(add).not.toHaveBeenCalled()
  })
})
