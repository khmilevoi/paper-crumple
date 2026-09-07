/**
 * @vitest-environment jsdom
 */
import { expect, test } from 'vitest'
import { PaperScene, useScene } from './scene-context.js'
import type { Scene } from './scene-types.js'
import { render, renderHook } from './testing/render.js'
import { createFakeStage } from './testing/fake-stage.js'

function readyScene(): Scene {
  const fake = createFakeStage()
  return {
    status: 'ready',
    stage: fake.stage,
    error: null,
    warnings: [],
    lost: false,
    generation: 1,
    knobEpoch: 0,
    play: async () => ({ started: [], skipped: [], failed: [], completed: false }),
    stop: () => {},
  }
}

test('useScene reads the value the provider carries', async () => {
  const scene = readyScene()
  let seen: Scene | null = null
  function Child(): null {
    seen = useScene()
    return null
  }
  const harness = await render(
    <PaperScene value={scene}>
      <Child />
    </PaperScene>,
  )
  expect(seen).toBe(scene)
  await harness.unmount()
})

test('PaperScene renders no DOM of its own (§4.2, §8)', async () => {
  const harness = await render(<PaperScene value={readyScene()}>{null}</PaperScene>)
  expect(harness.container.innerHTML).toBe('')
  await harness.unmount()
})

test('useScene outside a provider returns a permanently failed scene, and does not throw', async () => {
  const harness = await renderHook(() => useScene())
  const scene = harness.result.current
  expect(scene.status).toBe('failed')
  expect(scene.stage).toBeNull()
  expect(scene.error).toBeInstanceOf(Error)
  expect(scene.lost).toBe(false)
  await harness.unmount()
})

test('the no-provider scene is one stable object, so it never re-renders a consumer', async () => {
  const harness = await renderHook(() => useScene())
  const first = harness.result.current
  await harness.rerender()
  expect(harness.result.current).toBe(first)
  await harness.unmount()
})

test('the no-provider scene play resolves to an empty report and stop is a no-op (§7)', async () => {
  const harness = await renderHook(() => useScene())
  const scene = harness.result.current
  await expect(scene.play('flat', 'ball')).resolves.toEqual({
    started: [],
    skipped: [],
    failed: [],
    completed: false,
  })
  expect(scene.stop()).toBeUndefined()
  await harness.unmount()
})
