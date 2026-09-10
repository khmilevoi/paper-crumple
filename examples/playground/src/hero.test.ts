// @vitest-environment jsdom
import { createFakeStage, readyScene } from '@paper-crumple/react/testing'
import { PaperScene, type Crumple } from '@paper-crumple/react'
import { act, createElement } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { droppedSample, swapDurationFor, SWAP_DURATION_MS, useHero } from './hero'
import type { Sample } from './samples'

const A: Sample = { id: 'a', label: 'A', src: 'a.png' }
const B: Sample = { id: 'b', label: 'B', src: 'b.png' }

let root: ReturnType<typeof createRoot> | null = null
afterEach(() => {
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
    let shown = A
    let current: Crumple | null = null
    const scene = { ...readyScene(fake.stage), meta: { artworkCssPx: 360 } }
    const activeRoot = createRoot(document.createElement('div'))
    root = activeRoot
    function Probe(): ReactNode {
      current = useHero({ shown, duration: 800, onSettle, observed: vi.fn() })
      return createElement('canvas', { ref: current.ref })
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
    expect(onSettle).toHaveBeenCalledWith({ key: 'b', error: null, reduced: false })
    expect(current?.requested).toBe('b')
  })
})

describe('droppedSample', () => {
  it('gives every drop its own sprite key, because a key names a picture and not a slot', () => {
    const fileA = new File([], 'photo.png')
    const fileB = new File([], 'photo.png')
    const a = droppedSample(fileA, 1)
    const b = droppedSample(fileB, 2)
    expect(a.id).not.toBe(b.id)
    expect(a.src).toBe(fileA)
    expect(b.src).toBe(fileB)
  })

  it('keeps the file name as the label the chips show', () => {
    expect(droppedSample(new File([], 'camel.png'), 7).label).toBe('camel.png')
  })
})

describe('swapDurationFor', () => {
  it('takes the audio clip length when there is one', () => {
    expect(swapDurationFor(585)).toBe(585)
  })

  it('falls back to the demo constant when sound is off or silent', () => {
    expect(swapDurationFor(null)).toBe(SWAP_DURATION_MS)
    expect(swapDurationFor(undefined)).toBe(SWAP_DURATION_MS)
  })

  it('never hands the binding a zero, which is a swap with no traversal at all', () => {
    expect(swapDurationFor(0)).toBe(SWAP_DURATION_MS)
  })
})
