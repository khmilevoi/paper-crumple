/**
 * @vitest-environment jsdom
 */
import { useLayoutEffect } from 'react'
import { expect, test } from 'vitest'
import { useEvent } from './use-event.js'
import { render, renderHook } from './testing/render.js'

test('the identity never changes, across a re-render that replaces the function', async () => {
  let fn = (): string => 'first'
  const harness = await renderHook(() => useEvent(fn))
  const first = harness.result.current
  fn = (): string => 'second'
  await harness.rerender()
  expect(harness.result.current).toBe(first)
  await harness.unmount()
})

test('a stale callback is never invoked: the wrapper calls the newest committed function', async () => {
  let fn = (): string => 'first'
  const harness = await renderHook(() => useEvent(fn))
  const wrapper = harness.result.current
  expect(wrapper()).toBe('first')
  fn = (): string => 'second'
  await harness.rerender()
  expect(wrapper()).toBe('second')
  await harness.unmount()
})

test('arguments and the return value pass through unchanged', async () => {
  const harness = await renderHook(() => useEvent((a: number, b: string) => `${a}${b}`))
  expect(harness.result.current(1, 'x')).toBe('1x')
  await harness.unmount()
})

test('the first render publishes its function before any layout effect has run', async () => {
  const seen: string[] = []
  function Probe(): null {
    const call = useEvent(() => 'first')
    useLayoutEffect(() => {
      seen.push(call())
    }, [call])
    return null
  }
  const harness = await render(<Probe />)
  expect(seen).toEqual(['first'])
  await harness.unmount()
})

test('identity survives strict mode, and the newest function still wins', async () => {
  let fn = (): string => 'first'
  const harness = await renderHook(() => useEvent(fn), { strict: true })
  const wrapper = harness.result.current
  fn = (): string => 'second'
  await harness.rerender()
  expect(harness.result.current).toBe(wrapper)
  expect(wrapper()).toBe('second')
  await harness.unmount()
})
