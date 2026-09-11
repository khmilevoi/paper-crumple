import { expect, it, vi } from 'vitest'
import type { PlayResult } from '../index.js'
import { createRun } from '../run.js'
import { createRequestGate } from './request.js'

it('cancellation stops its own adopted Run exactly once', () => {
  const stop = vi.fn()
  const gate = createRequestGate(() => true)
  gate.adopt(createRun<PlayResult>(stop).run)
  gate.cancel()
  gate.cancel()
  expect(stop).toHaveBeenCalledTimes(1)
  expect(gate.current()).toBe(false)
  expect(gate.signal.aborted).toBe(true)
})

it('finish releases ownership without aborting or stopping, even on later parent abort', () => {
  const parent = new AbortController()
  const stop = vi.fn()
  const gate = createRequestGate(() => true, parent.signal)
  gate.adopt(createRun<PlayResult>(stop).run)
  gate.finish()
  gate.finish()
  parent.abort()
  gate.cancel()
  expect(stop).not.toHaveBeenCalled()
  expect(gate.signal.aborted).toBe(false)
  expect(gate.current()).toBe(false)
})

it('captures the owned run before synchronous abort listeners finish the gate', () => {
  const stop = vi.fn()
  const gate = createRequestGate(() => true)
  gate.adopt(createRun<PlayResult>(stop).run)
  gate.signal.addEventListener('abort', () => gate.finish())
  gate.cancel()
  expect(stop).toHaveBeenCalledTimes(1)
})

it('a synchronous abort listener cannot adopt a new live run during cancellation', () => {
  const gate = createRequestGate(() => true)
  const stop = vi.fn()
  gate.signal.addEventListener('abort', () => gate.adopt(createRun<PlayResult>(stop).run))
  gate.cancel()
  expect(stop).toHaveBeenCalledTimes(1)
})

it('a parent abort cancels only its consumer and rejects its late adopted run', () => {
  const parent = new AbortController()
  const other = createRequestGate(() => true)
  const gate = createRequestGate(() => true, parent.signal)
  parent.abort()
  const stop = vi.fn()
  gate.adopt(createRun<PlayResult>(stop).run)
  expect(stop).toHaveBeenCalledTimes(1)
  expect(other.current()).toBe(true)
  expect(other.signal.aborted).toBe(false)
})

it('an already aborted parent prevents the request from starting', () => {
  const parent = new AbortController()
  parent.abort()
  const gate = createRequestGate(() => true, parent.signal)
  expect(gate.current()).toBe(false)
  expect(gate.signal.aborted).toBe(true)
})

it('a stale identity cannot adopt a live run', () => {
  let current = true
  const gate = createRequestGate(() => current)
  current = false
  const stop = vi.fn()
  gate.adopt(createRun<PlayResult>(stop).run)
  expect(stop).toHaveBeenCalledTimes(1)
  expect(gate.current()).toBe(false)
  gate.finish()
})
