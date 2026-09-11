// @vitest-environment jsdom
import { createFakeStage, readyScene } from '@paper-crumple/react/testing'
import { PaperScene, type Crumple } from '@paper-crumple/react'
import { act, createElement } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useHero } from './hero'
import type { Sample } from '../source/samples'

const A: Sample = { id: 'a', label: 'A', src: 'a.png' }
const B: Sample = { id: 'b', label: 'B', src: 'b.png' }

let root: ReturnType<typeof createRoot> | null = null
afterEach(() => {
  vi.restoreAllMocks()
  if (root === null) return
  act(() => {
    root?.unmount()
  })
  root = null
})

describe('useHero', () => {
  it('uses the provided scene and swaps without an explicit scene option', async () => {
    const fake = createFakeStage({ sprites: ['a', 'b'] })
    const onSettle = vi.fn()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let shown = A
    const current: { value: Crumple | null } = { value: null }
    const baseScene = readyScene(fake.stage)
    if (baseScene.status !== 'ready') {
      expect.fail(`readyScene returned ${baseScene.status}`)
    }
    const scene = { ...baseScene, meta: { artworkCssPx: 360 } }
    const activeRoot = createRoot(document.createElement('div'))
    root = activeRoot
    function Probe(): ReactNode {
      current.value = useHero({ shown, duration: 800, onSettle, observed: vi.fn() })
      return createElement('canvas', { ref: current.value.ref })
    }
    const render = async (): Promise<void> => {
      await act(async () => {
        activeRoot.render(createElement(PaperScene, { value: scene }, createElement(Probe)))
      })
    }
    await render()
    onSettle.mockClear()
    shown = B
    await render()
    expect(fake.calls.filter((call) => call.method === 'view.swapTo')).toHaveLength(1)
    expect(fake.calls.find((call) => call.method === 'view.swapTo')?.args[0]).toBe(B.src)
    fake.views[0]?.settleRun(undefined)
    await act(async () => {})
    expect(onSettle).toHaveBeenCalledTimes(1)
    expect(onSettle).toHaveBeenCalledWith({ key: 'b', error: null, reduced: false })
    expect(current.value?.requested).toBe('b')
    expect(fake.views[0]?.view.tag).toBe('hero')
    expect(warn).not.toHaveBeenCalled()
  })
})
