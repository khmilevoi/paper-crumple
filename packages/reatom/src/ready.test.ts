import { expect, it, vi } from 'vitest'
import { joinReady } from './ready.js'
import { deferred } from './testing.js'
import { toAsyncValue } from './result.js'

it('joins the exact promise before a synchronous reentrant invocation', async () => {
  const gate = deferred<number>()
  let nested: Promise<number> | undefined
  const invoke = vi.fn(() => {
    if (invoke.mock.calls.length === 1) nested = ready()
    return gate.promise
  })
  const ready = joinReady(invoke, () => 0)
  const first = ready()
  expect(nested).toBe(first)
  expect(ready()).toBe(first)
  expect(invoke).toHaveBeenCalledTimes(1)
  gate.resolve(7)
  expect(await first).toBe(7)
})

it('old settlement cannot clear a newer identity and rejection allows retry', async () => {
  const first = deferred<number>()
  const second = deferred<number>()
  let key = 1
  const invoke = vi.fn(() => (key === 1 ? first.promise : second.promise))
  const ready = joinReady(invoke, () => key)
  const a = ready()
  key = 2
  const b = ready()
  first.resolve(1)
  await a
  expect(ready()).toBe(b)
  second.reject(new Error('retry me'))
  await expect(b).rejects.toThrow('retry me')
  const retry = ready()
  expect(retry).not.toBe(b)
  await expect(retry).rejects.toThrow('retry me')
  expect(invoke).toHaveBeenCalledTimes(3)
})

it('clears synchronous failures without leaving a poisoned entry', async () => {
  const invoke = vi.fn(() => Promise.resolve(4))
  invoke.mockImplementationOnce(() => {
    return toAsyncValue<never>(new Error('synchronous failure'))
  })
  const ready = joinReady(invoke, () => 0)
  await expect(ready()).rejects.toThrow('synchronous failure')
  expect(await ready()).toBe(4)
})
