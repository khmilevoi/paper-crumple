// @vitest-environment jsdom
import { createFakeStage, deferred, readyScene } from '@paper-crumple/react/testing'
import type { FakeStageHandle } from '@paper-crumple/react/testing'
import { PaperScene } from '@paper-crumple/react'
import type { PlayResult, Run, Sprite } from '@paper-crumple/core'
import { act, createElement } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { swapDurationFor, SWAP_DURATION_MS, useTransport } from './transport'
import type { TransportHandle } from './transport'
import type { Sample } from './samples'

const A: Sample = { id: 'a', label: 'A', src: 'a.png' }
const B: Sample = { id: 'b', label: 'B', src: 'b.png' }

interface TransportHarness {
  readonly fake: FakeStageHandle
  readonly audio: {
    beginSequence: ReturnType<typeof vi.fn>
    endSequence: ReturnType<typeof vi.fn>
  }
  readonly settled: ReturnType<typeof vi.fn>
  readonly result: { current: TransportHandle }
  setShown(sample: Sample): Promise<void>
  unmount(): Promise<void>
}

let root: ReturnType<typeof createRoot> | null = null

afterEach(() => {
  if (root === null) return
  act(() => {
    root?.unmount()
  })
  root = null
})

async function renderTransport(
  fake: FakeStageHandle,
  observed: ReturnType<typeof vi.fn> = vi.fn(),
): Promise<TransportHarness> {
  const audio = {
    beginSequence: vi.fn(() => 600),
    endSequence: vi.fn(),
  }
  const settled = vi.fn()
  const result: { current: TransportHandle } = { current: null as unknown as TransportHandle }
  let shown = A
  const scene = readyScene(fake.stage)
  const activeRoot = createRoot(document.createElement('div'))
  root = activeRoot

  function Probe(): ReactNode {
    const transport = useTransport({
      shown,
      audio,
      observed,
      onSettle: settled,
    })
    result.current = transport
    return createElement('canvas', { ref: transport.crumple.ref })
  }

  const render = async (): Promise<void> => {
    await act(async () => {
      activeRoot.render(createElement(PaperScene, { value: scene }, createElement(Probe)))
    })
  }

  await render()
  return {
    fake,
    audio,
    settled,
    result,
    async setShown(sample: Sample): Promise<void> {
      shown = sample
      await render()
    },
    async unmount(): Promise<void> {
      await act(async () => {
        activeRoot.unmount()
      })
      root = null
    },
  }
}

function rejectingRun(): { readonly run: Run<PlayResult>; reject(error: Error): void } {
  let rejectDone: ((reason?: unknown) => void) | undefined
  const done = new Promise<PlayResult>((_resolve, reject) => {
    rejectDone = reject
  })
  const run: Run<PlayResult> = {
    done,
    then: (onFulfilled, onRejected) => done.then(onFulfilled, onRejected),
    stop: () => {},
  }
  return {
    run,
    reject(error: Error): void {
      rejectDone?.(error)
    },
  }
}

describe('useTransport', () => {
  it('draws once through Crumple.draw and never chases it with refresh', async () => {
    const harness = await renderTransport(createFakeStage({ sprites: ['a'] }))
    act(() => harness.result.current.draw(2))
    expect(harness.fake.calls.filter((call) => call.method === 'view.draw')).toHaveLength(1)
    expect(harness.fake.calls.filter((call) => call.method === 'view.refresh')).toHaveLength(0)
    await harness.unmount()
  })

  it('is busy while the crumple has an acquisition pending', async () => {
    const gate = deferred<Sprite>()
    const fake = createFakeStage({ add: () => gate.promise })
    const harness = await renderTransport(fake)
    expect(harness.result.current.busy).toBe(true)
    gate.resolve(fake.addSprite('a'))
    await act(async () => {})
    await harness.unmount()
  })

  it('begins and ends one fold sequence around the returned run', async () => {
    const harness = await renderTransport(createFakeStage({ sprites: ['a'] }))
    let done: Promise<void> | undefined
    act(() => {
      done = harness.result.current.runFold('flat', 'ball')
    })
    expect(harness.audio.beginSequence).toHaveBeenCalledTimes(1)
    harness.fake.views[0]?.settleRun(undefined)
    await act(async () => done)
    expect(harness.audio.endSequence).toHaveBeenCalledTimes(1)
    await harness.unmount()
  })

  it('arms a swap before the shown sample changes and forwards its settle', async () => {
    const harness = await renderTransport(createFakeStage({ sprites: ['a'] }))
    act(() => harness.result.current.beginSwap())
    await harness.setShown(B)
    harness.fake.views[0]?.settleRun(undefined)
    await act(async () => {})
    expect(harness.audio.beginSequence).toHaveBeenCalledTimes(1)
    expect(harness.audio.endSequence).toHaveBeenCalledTimes(1)
    expect(harness.settled).toHaveBeenCalledWith({ key: 'b', error: null, reduced: false }, true)
    await harness.unmount()
  })

  it('ends audio and observes a rejected fold run', async () => {
    const observed = vi.fn()
    const harness = await renderTransport(createFakeStage({ sprites: ['a'] }), observed)
    const rejected = rejectingRun()
    const view = harness.fake.views[0]?.view
    expect(view).not.toBeUndefined()
    if (view === undefined) return
    view.play = () => rejected.run

    let done: Promise<void> | undefined
    act(() => {
      done = harness.result.current.runFold('flat', 'ball')
    })
    const error = new Error('run rejected')
    rejected.reject(error)
    await expect(done).resolves.toBeUndefined()
    expect(harness.audio.endSequence).toHaveBeenCalledTimes(1)
    expect(observed).toHaveBeenCalledWith('crumple.play', error)
    await harness.unmount()
  })

  it('handles transport keys on window but ignores them from form controls', async () => {
    const harness = await renderTransport(createFakeStage({ sprites: ['a'] }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }))

    expect(harness.fake.calls.filter((call) => call.method === 'view.draw')).toHaveLength(1)
    expect(harness.fake.calls.filter((call) => call.method === 'view.play')).toHaveLength(1)

    await act(async () => {
      harness.fake.views[0]?.settleRun(undefined)
    })

    const input = document.createElement('input')
    document.body.append(input)
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))

    expect(harness.fake.calls.filter((call) => call.method === 'view.draw')).toHaveLength(1)
    expect(harness.fake.calls.filter((call) => call.method === 'view.play')).toHaveLength(1)
    input.remove()
    await harness.unmount()
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
