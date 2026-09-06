/**
 * @vitest-environment jsdom
 */
import { expect, test } from 'vitest'
import { deferred } from './testing/deferred.js'
import { flush, render, renderHook } from './testing/render.js'

test('the unit project renders React into jsdom', async () => {
  const harness = await render(<p>ok</p>)
  expect(harness.container.textContent).toBe('ok')
  await harness.rerender(<p>changed</p>)
  expect(harness.container.textContent).toBe('changed')
  await harness.unmount()
  expect(harness.container.isConnected).toBe(false)
})

test('renderHook exposes the latest returned value and re-runs on rerender', async () => {
  let value = 1
  const harness = await renderHook(() => value)
  expect(harness.result.current).toBe(1)
  value = 2
  await harness.rerender()
  expect(harness.result.current).toBe(2)
  await harness.unmount()
})

test('strict mode double-invokes the hook body and still reports one value', async () => {
  let renders = 0
  const harness = await renderHook(
    () => {
      renders += 1
      return renders
    },
    { strict: true },
  )
  expect(renders).toBe(2)
  expect(harness.result.current).toBe(2)
  await harness.unmount()
})

test('deferred resolves through flush', async () => {
  const d = deferred<string>()
  let seen: string | null = null
  void d.promise.then((v) => {
    seen = v
  })
  d.resolve('done')
  await flush()
  expect(seen).toBe('done')
})
