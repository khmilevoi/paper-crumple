// @vitest-environment jsdom
import { createFakeStage, deferred, readyScene } from '@paper-crumple/react/testing'
import type { FakeStageHandle } from '@paper-crumple/react/testing'
import { PaperScene } from '@paper-crumple/react'
import { SheetError } from '@paper-crumple/core'
import type { PlayResult, Run, Sprite } from '@paper-crumple/core'
import { act, createElement } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { swapDurationFor, useTransport } from './use-transport'
import type { TransportHandle } from './use-transport'
import type { Sample } from '../source/samples'

const A: Sample = { id: 'a', label: 'A', src: 'a.png' }
const B: Sample = { id: 'b', label: 'B', src: 'b.png' }

interface TransportHarness {
  readonly fake: FakeStageHandle
  readonly audio: {
    beginSequence: ReturnType<typeof vi.fn>
    endSequence: ReturnType<typeof vi.fn>
    cancel: ReturnType<typeof vi.fn>
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
  observed: ReturnType<typeof vi.fn<(where: string, error: Error) => void>> = vi.fn(),
): Promise<TransportHarness> {
  const audio = {
    beginSequence: vi.fn((): number | undefined => 600),
    endSequence: vi.fn(),
    cancel: vi.fn(),
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

  it.each([
    ['fold', 'flat', 'ball'],
    ['unfold', 'ball', 'flat'],
  ] as const)(
    'leaves authored %s timing intact when audio supplies no duration',
    async (_, from, to) => {
      const harness = await renderTransport(createFakeStage({ sprites: ['a'] }))
      harness.audio.beginSequence.mockReturnValue(undefined)

      let done: Promise<void> | undefined
      act(() => {
        done = harness.result.current.runFold(from, to)
      })

      const play = harness.fake.calls.find((call) => call.method === 'view.play')
      expect(play?.args[2]).toEqual({ duration: undefined })
      harness.fake.views[0]?.settleRun(undefined)
      await act(async () => done)
      await harness.unmount()
    },
  )

  it('passes a positive scaled-audio duration through to an ordinary fold exactly', async () => {
    const harness = await renderTransport(createFakeStage({ sprites: ['a'] }))
    harness.audio.beginSequence.mockReturnValue(585)

    let done: Promise<void> | undefined
    act(() => {
      done = harness.result.current.runFold('flat', 'ball')
    })

    const play = harness.fake.calls.find((call) => call.method === 'view.play')
    expect(play?.args[2]).toEqual({ duration: 585 })
    harness.fake.views[0]?.settleRun(undefined)
    await act(async () => done)
    await harness.unmount()
  })

  it('closes an armed swap from onSettle rather than a view end event', async () => {
    const harness = await renderTransport(createFakeStage({ sprites: ['a'] }))
    harness.settled.mockClear()
    act(() => harness.result.current.beginSwap('b'))
    await harness.setShown(B)
    harness.fake.views[0]?.settleRun(undefined)
    await act(async () => {})
    expect(harness.audio.beginSequence).toHaveBeenCalledTimes(1)
    expect(harness.audio.endSequence).toHaveBeenCalledTimes(1)
    expect(harness.settled).toHaveBeenCalledTimes(1)
    expect(harness.settled).toHaveBeenCalledWith({ key: 'b', error: null, reduced: false }, true)
    await harness.unmount()
  })

  it('uses the armed swap specification for audio and fixed-mode authored timing', async () => {
    const harness = await renderTransport(createFakeStage({ sprites: ['a', 'b'] }))
    harness.audio.beginSequence.mockReturnValue(undefined)

    act(() => harness.result.current.beginSwap('b'))
    await harness.setShown(B)

    expect(harness.audio.beginSequence).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'swap from 0', authored: 985 }),
    )
    const swap = harness.fake.calls.find((call) => call.method === 'view.crumpleTo')
    expect(swap?.args[1]).toMatchObject({ duration: 985 })
    expect(await swap?.args[0]).toBe(harness.fake.sprites.get('b'))
    await harness.unmount()
  })

  it('does not leak a scaled duration into the next fixed-mode swap', async () => {
    const C: Sample = { id: 'c', label: 'C', src: 'c.png' }
    const harness = await renderTransport(createFakeStage({ sprites: ['a', 'b', 'c'] }))
    harness.audio.beginSequence.mockReturnValueOnce(640).mockReturnValueOnce(undefined)

    act(() => harness.result.current.beginSwap('b'))
    await harness.setShown(B)
    act(() => harness.result.current.beginSwap('c'))
    await harness.setShown(C)

    const swaps = harness.fake.calls.filter((call) => call.method === 'view.crumpleTo')
    expect((swaps[0]?.args[1] as { duration?: number }).duration).toBe(640)
    expect((swaps[1]?.args[1] as { duration?: number }).duration).toBe(985)
    await harness.unmount()
  })

  it('forwards rollback errors as a settled swap outcome', async () => {
    const harness = await renderTransport(createFakeStage({ sprites: ['a'] }))
    harness.settled.mockClear()
    act(() => harness.result.current.beginSwap('b'))
    await harness.setShown(B)
    const error = new SheetError('target failed')
    harness.fake.views[0]?.settleRun(error)
    await act(async () => {})
    expect(harness.result.current.crumple.status).toBe('rolled-back')
    expect(harness.settled).toHaveBeenCalledTimes(1)
    expect(harness.settled).toHaveBeenCalledWith({ key: 'b', error, reduced: false }, true)
    await harness.unmount()
  })

  it('closes reduced-motion swaps from onSettle without a view end event', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    try {
      const harness = await renderTransport(createFakeStage({ sprites: ['a', 'b'] }))
      harness.settled.mockClear()
      act(() => harness.result.current.beginSwap('b'))
      await harness.setShown(B)
      await act(async () => {})
      expect(harness.audio.endSequence).toHaveBeenCalledTimes(1)
      expect(harness.settled).toHaveBeenCalledTimes(1)
      expect(harness.settled).toHaveBeenCalledWith({ key: 'b', error: null, reduced: true }, true)
      await harness.unmount()
    } finally {
      vi.unstubAllGlobals()
    }
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

  it('cancels an armed swap without fabricating settlement', async () => {
    const harness = await renderTransport(createFakeStage({ sprites: ['a', 'b'] }))
    harness.settled.mockClear()
    act(() => harness.result.current.beginSwap('b'))
    await harness.setShown(B)

    act(() => harness.result.current.cancelSwap('b'))

    expect(harness.result.current.direction).toBeNull()
    expect(harness.audio.cancel).toHaveBeenCalledTimes(1)
    expect(harness.audio.endSequence).not.toHaveBeenCalled()
    expect(harness.settled).not.toHaveBeenCalled()
    await harness.unmount()
  })

  it('does not let stale cancellation close a successor request', async () => {
    const C: Sample = { id: 'c', label: 'C', src: 'c.png' }
    const harness = await renderTransport(createFakeStage({ sprites: ['a', 'b', 'c'] }))
    act(() => harness.result.current.beginSwap('b'))
    await harness.setShown(B)
    act(() => harness.result.current.beginSwap('c'))
    await harness.setShown(C)
    harness.audio.cancel.mockClear()

    act(() => harness.result.current.cancelSwap('b'))

    expect(harness.result.current.direction).toBe('folding')
    expect(harness.audio.cancel).not.toHaveBeenCalled()
    act(() => harness.result.current.cancelSwap('c'))
    expect(harness.result.current.direction).toBeNull()
    expect(harness.audio.cancel).toHaveBeenCalledTimes(1)
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
    expect(swapDurationFor(585, 985)).toBe(585)
  })

  it('falls back to the armed swap authored timing when sound is off or silent', () => {
    expect(swapDurationFor(null, 985)).toBe(985)
    expect(swapDurationFor(undefined, 985)).toBe(985)
  })

  it('rejects zero and invalid audio durations in favor of authored timing', () => {
    expect(swapDurationFor(0, 985)).toBe(985)
    expect(swapDurationFor(Number.NaN, 985)).toBe(985)
    expect(swapDurationFor(Number.POSITIVE_INFINITY, 985)).toBe(985)
  })
})
