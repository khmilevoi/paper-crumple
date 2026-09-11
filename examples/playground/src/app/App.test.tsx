// @vitest-environment jsdom
import { ABORTED, SheetError } from '@paper-crumple/core'
import { bakedMotion } from '@paper-crumple/motion'
import type { Pack } from '@paper-crumple/motion'
import pack1x1 from '@paper-crumple/motion/packs/1x1'
import { paperSheet } from '@paper-crumple/paper'
import type { Scene } from '@paper-crumple/react'
import { createFakeStage, deferred, readyScene } from '@paper-crumple/react/testing'
import type { FakeStageHandle } from '@paper-crumple/react/testing'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AudioHandle, AudioSnapshot } from '../sound/audio'
import { createAudio } from '../sound/audio'
import type { BuiltStage } from '../scene/config'
import { DEFAULT_CONFIG } from '../scene/config'
import type { DemoScene } from '../scene/scene'
import type { DemoSceneEvents } from '../scene/scene'
import { useDemoScene } from '../scene/scene'
import { encodeState } from './state'

import { App } from './App'
import { BROKEN_ID } from '../source/samples'

vi.mock('../sound/audio', async () => {
  const actual = await vi.importActual<typeof import('../sound/audio')>('../sound/audio')
  return { ...actual, createAudio: vi.fn() }
})

vi.mock('../scene/scene', async () => {
  const actual = await vi.importActual<typeof import('../scene/scene')>('../scene/scene')
  return { ...actual, useDemoScene: vi.fn() }
})

const mockedCreateAudio = vi.mocked(createAudio)
const mockedUseDemoScene = vi.mocked(useDemoScene)

interface AudioHarness {
  readonly handle: AudioHandle
  readonly beginSequence: ReturnType<typeof vi.fn>
  readonly endSequence: ReturnType<typeof vi.fn>
  readonly cancel: ReturnType<typeof vi.fn>
}

interface SceneHarness {
  readonly built: BuiltStage
  readonly demo: DemoScene
  readonly stop: ReturnType<typeof vi.fn>
}

let root: ReturnType<typeof createRoot> | null = null
let container: HTMLDivElement | null = null
let currentDemo: DemoScene | null = null
let currentEvents: DemoSceneEvents | null = null

afterEach(() => {
  if (root !== null) {
    act(() => root?.unmount())
  }
  container?.remove()
  root = null
  container = null
  currentDemo = null
  currentEvents = null
  history.replaceState(null, '', `${location.pathname}${location.search}`)
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

beforeEach(() => {
  mockedUseDemoScene.mockImplementation((_config, _observed, _initialKnobs, events) => {
    currentEvents = events ?? null
    if (currentDemo === null) return new Error('test scene is missing') as unknown as DemoScene
    return currentDemo
  })
})

function audioHarness(): AudioHarness {
  const snapshot: AudioSnapshot = {
    clips: [],
    clipId: 'none',
    volume: 0.8,
    sync: 'scale',
    summary: 'none',
  }
  const beginSequence = vi.fn(() => 600)
  const endSequence = vi.fn()
  const cancel = vi.fn()
  return {
    beginSequence,
    endSequence,
    cancel,
    handle: {
      snapshot: () => snapshot,
      subscribe: () => () => {},
      setClip: () => {},
      setVolume: () => {},
      setSync: () => {},
      probe: () => {},
      lines: () => [],
      beginSequence,
      endSequence,
      cancel,
    },
  }
}

function sceneHarness(fake: FakeStageHandle): SceneHarness {
  const motion = bakedMotion({ packs: [pack1x1] })
  const frames = pack1x1.manifest.frames.map((frame) => ({
    ...frame,
    byteOffset: frame.offset,
    byteLength: pack1x1.manifest.frameBytes,
  }))
  const pack = {
    bucket: pack1x1.bucket,
    frameCount: frames.length,
    frames,
    keyFrames: pack1x1.manifest.keyFrames.map((index) =>
      frames.findIndex((frame) => frame.index === index),
    ),
  } as unknown as Pack
  vi.spyOn(motion, 'packs').mockReturnValue([pack])
  const built: BuiltStage = {
    stage: fake.stage,
    sheet: paperSheet(),
    motion,
    buildMs: 1,
    artworkCssPx: 360,
  }
  const stop = vi.fn((options?: { all?: boolean }) => {
    fake.stage.stop(options)
    for (const view of fake.views) view.settleRun(ABORTED)
  })
  const scene = {
    ...readyScene(fake.stage),
    meta: built,
    stop,
  } as Scene<BuiltStage>
  return {
    built,
    stop,
    demo: {
      scene,
      knobs: {},
      setKnob: vi.fn(),
      resetKnobs: vi.fn(),
    },
  }
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

function buttonNamed(app: ParentNode, name: string): HTMLButtonElement | null {
  return (
    [...app.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === name,
    ) ?? null
  )
}

async function failBrokenSwap(
  app: HTMLDivElement,
  fake: FakeStageHandle,
  message = 'target failed',
): Promise<void> {
  const target = app.querySelector<HTMLSelectElement>('select[aria-label="swap target"]')
  const swap = buttonNamed(app, 'Swap')
  expect(target).not.toBeNull()
  expect(swap).not.toBeNull()
  if (target === null || swap === null) return
  act(() => change(target, BROKEN_ID))
  act(() => swap.click())
  fake.views[0]?.settleRun(new SheetError(message))
  await settle()
}

async function renderApp(): Promise<HTMLDivElement> {
  container ??= document.createElement('div')
  if (!container.isConnected) document.body.append(container)
  root ??= createRoot(container)
  await act(async () => {
    root?.render(<App />)
  })
  await act(async () => {
    await Promise.resolve()
  })
  return container
}

function change(select: HTMLSelectElement, value: string): void {
  select.value = value
  select.dispatchEvent(new Event('change', { bubbles: true }))
}

describe('App request outcomes', () => {
  it('renders an initial acquisition failure in the status pill', async () => {
    const audio = audioHarness()
    mockedCreateAudio.mockReturnValue(audio.handle)
    const error = new SheetError('initial image could not be baked')
    currentDemo = sceneHarness(createFakeStage({ add: async () => error })).demo

    const app = await renderApp()

    expect(app.querySelector('[role="status"]')?.textContent).toContain(
      'image failed: initial image could not be baked',
    )
  })

  it('renders a failed entrance after the stage is rebuilt', async () => {
    const audio = audioHarness()
    mockedCreateAudio.mockReturnValue(audio.handle)
    currentDemo = sceneHarness(createFakeStage({ sprites: ['sweater'] })).demo
    await renderApp()

    const error = new SheetError('rebuilt stage rejected the image')
    currentDemo = sceneHarness(createFakeStage({ add: async () => error })).demo
    const app = await renderApp()

    expect(app.querySelector('[role="status"]')?.textContent).toContain(
      'image failed: rebuilt stage rejected the image',
    )
  })

  it('cancels the owning swap when pose editing stops the scene', async () => {
    const audio = audioHarness()
    mockedCreateAudio.mockReturnValue(audio.handle)
    const fake = createFakeStage({ sprites: ['sweater', 'trench'] })
    const scene = sceneHarness(fake)
    currentDemo = scene.demo
    const app = await renderApp()
    const sample = app.querySelector<HTMLSelectElement>('select[aria-label="sample"]')
    expect(sample).not.toBeNull()
    if (sample === null) return

    await act(async () => change(sample, 'trench'))
    expect(audio.beginSequence).toHaveBeenCalledTimes(1)
    expect(app.querySelector('.transport-readout')?.textContent).toContain('folding')

    const poses = [...app.querySelectorAll<HTMLButtonElement>('.section-header')].find((button) =>
      button.textContent?.includes('Poses'),
    )
    expect(poses).not.toBeUndefined()
    act(() => poses?.click())
    const poseEdit = [
      app.querySelector<HTMLButtonElement>('button[aria-label="one pose fewer"]'),
      app.querySelector<HTMLButtonElement>('button[aria-label="one pose more"]'),
    ].find((button) => button !== null && !button.disabled)
    expect(poseEdit).not.toBeUndefined()
    act(() => poseEdit?.click())

    expect(scene.stop).toHaveBeenCalledWith({ all: true })
    expect(audio.cancel).toHaveBeenCalledTimes(1)
    expect(audio.endSequence).not.toHaveBeenCalled()
    expect(app.querySelector('.transport-readout')?.textContent).not.toContain('folding')
  })

  it('stops a swap when Reset keeps the existing default configuration', async () => {
    const audio = audioHarness()
    mockedCreateAudio.mockReturnValue(audio.handle)
    const fake = createFakeStage({ sprites: ['sweater', 'trench'] })
    const scene = sceneHarness(fake)
    currentDemo = scene.demo
    const app = await renderApp()
    const reset = app.querySelector<HTMLButtonElement>('.header-reset')
    const sample = app.querySelector<HTMLSelectElement>('select[aria-label="sample"]')
    expect(reset).not.toBeNull()
    expect(sample).not.toBeNull()
    if (reset === null || sample === null) return

    act(() => reset.click())
    await act(async () => {})
    await act(async () => change(sample, 'trench'))
    expect(app.querySelector('.transport-readout')?.textContent).toContain('folding')

    act(() => reset.click())
    await act(async () => {})

    expect(scene.stop).toHaveBeenCalledWith({ all: true })
    expect(audio.cancel).toHaveBeenCalledTimes(1)
    expect(audio.endSequence).not.toHaveBeenCalled()
    expect(app.querySelector<HTMLButtonElement>('.btn-inline')?.disabled).toBe(false)
    expect(app.querySelector('[role="status"]')?.textContent).toContain(
      'reset to manifest defaults',
    )

    fake.views[0]?.settleRun(new SheetError('late rollback'))
    await act(async () => {})
    expect(app.querySelector('[role="status"]')?.textContent).toContain(
      'reset to manifest defaults',
    )
  })

  it('rebuilds Reset from the last successful sample after a settled rollback', async () => {
    history.replaceState(null, '', encodeState({ ...DEFAULT_CONFIG, edgeShape: 'torn' }, {}))
    const audio = audioHarness()
    mockedCreateAudio.mockReturnValue(audio.handle)
    const original = createFakeStage({ sprites: ['sweater'] })
    currentDemo = sceneHarness(original).demo
    const app = await renderApp()
    await settle()
    original.views[0]?.settleRun(undefined)
    await settle()
    await failBrokenSwap(app, original, 'broken target')
    expect(app.querySelector('[role="status"]')?.textContent).toContain(
      'swap failed, rolled back to the previous sprite: broken target',
    )

    const acquired: { readonly key: string; readonly src: unknown }[] = []
    const fresh = createFakeStage({
      add: async (src, options) => {
        acquired.push({ key: options.key, src })
        return fresh.addSprite(options.key)
      },
    })
    currentDemo = sceneHarness(fresh).demo
    const reset = app.querySelector<HTMLButtonElement>('.header-reset')
    expect(reset).not.toBeNull()
    expect(mockedUseDemoScene.mock.calls.at(-1)?.[0].edgeShape).toBe('torn')
    act(() => reset?.click())
    await settle()

    expect(acquired).toContainEqual({
      key: 'sweater',
      src: '/samples/garment-sweater.png',
    })
    expect(acquired.some(({ key }) => key === BROKEN_ID)).toBe(false)
    expect(app.querySelectorAll('.pose-step')).toHaveLength(6)
    const poses = [...app.querySelectorAll<HTMLButtonElement>('.section-header')].find((button) =>
      button.textContent?.includes('Poses'),
    )
    act(() => poses?.click())
    expect(
      app.querySelector<HTMLButtonElement>('button[aria-label="one pose more"]')?.disabled,
    ).toBe(false)
  })

  it('commits the newly armed duration before retrying a rolled-back key', async () => {
    const audio = audioHarness()
    audio.beginSequence.mockReturnValueOnce(640).mockReturnValueOnce(undefined)
    mockedCreateAudio.mockReturnValue(audio.handle)
    const fake = createFakeStage({ sprites: ['sweater'] })
    currentDemo = sceneHarness(fake).demo
    const app = await renderApp()

    await failBrokenSwap(app, fake)
    const firstSwap = fake.calls.find((call) => call.method === 'view.swapTo')
    expect((firstSwap?.args[1] as { duration?: number }).duration).toBe(640)

    act(() => buttonNamed(app, 'Swap')?.click())
    await settle()

    const swaps = fake.calls.filter((call) => call.method === 'view.swapTo')
    expect((swaps[1]?.args[1] as { duration?: number }).duration).toBe(985)
  })

  it('retains the complete dropped File through rollback and a config rebuild', async () => {
    const audio = audioHarness()
    mockedCreateAudio.mockReturnValue(audio.handle)
    const original = createFakeStage({ sprites: ['sweater'] })
    currentDemo = sceneHarness(original).demo
    const app = await renderApp()
    const file = new File(['paper'], 'kept.png', { type: 'image/png' })
    const drop = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(drop, 'dataTransfer', { value: { files: [file] } })
    act(() => app.querySelector('.stage')?.dispatchEvent(drop))
    original.views[0]?.settleRun(undefined)
    await settle()
    await failBrokenSwap(app, original)
    act(() => buttonNamed(app, 'Fold')?.click())
    original.views[0]?.emit('start', { from: 0, to: 5 })
    original.views[0]?.settleRun(undefined)
    await settle()

    const acquired: { readonly key: string; readonly src: unknown }[] = []
    const fresh = createFakeStage({
      add: async (src, options) => {
        acquired.push({ key: options.key, src })
        return fresh.addSprite(options.key)
      },
    })
    currentDemo = sceneHarness(fresh).demo
    const bucket = [...app.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === '1x1',
    )
    expect(bucket).not.toBeUndefined()
    act(() => bucket?.click())
    await settle()

    expect(acquired).toHaveLength(1)
    expect(acquired[0]?.key).toBe('dropped-1')
    expect(acquired[0]?.src).toBe(file)
  })

  it('does not let an older rollback replace a newer pending request during rebuild', async () => {
    const audio = audioHarness()
    mockedCreateAudio.mockReturnValue(audio.handle)
    const original = createFakeStage({ sprites: ['sweater'] })
    currentDemo = sceneHarness(original).demo
    const app = await renderApp()
    await failBrokenSwap(app, original, 'older failure')

    const sample = app.querySelector<HTMLSelectElement>('select[aria-label="sample"]')
    expect(sample).not.toBeNull()
    if (sample === null) return
    await act(async () => change(sample, 'trench'))

    const acquired: string[] = []
    const fresh = createFakeStage({
      add: async (_src, options) => {
        acquired.push(options.key)
        return fresh.addSprite(options.key)
      },
    })
    currentDemo = sceneHarness(fresh).demo
    const bucket = [...app.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === '1x1',
    )
    act(() => bucket?.click())
    await settle()
    original.views[0]?.settleRun(new SheetError('stale settle'))
    await settle()

    expect(acquired).toEqual(['trench'])
    expect(app.querySelector('[role="status"]')?.textContent).not.toContain('stale settle')
  })

  it('gates only a target whose startup prefetch is scheduled or in flight', async () => {
    let idle: IdleRequestCallback | null = null
    vi.stubGlobal('requestIdleCallback', (callback: IdleRequestCallback) => {
      idle = callback
      return 1
    })
    const trench = deferred<ReturnType<FakeStageHandle['addSprite']>>()
    const fake = createFakeStage({
      sprites: ['sweater'],
      add: async (_src, options) =>
        options.key === 'trench'
          ? trench.promise
          : options.key === 'jeans'
            ? new SheetError('optional prefetch failed')
            : fake.addSprite(options.key),
    })
    const scene = sceneHarness(fake)
    currentDemo = scene.demo
    const audio = audioHarness()
    mockedCreateAudio.mockReturnValue(audio.handle)
    const app = await renderApp()
    const signal = new AbortController().signal
    act(() => currentEvents?.onReady?.(scene.built, { generation: 1, signal }))
    await settle()

    const sample = app.querySelector<HTMLSelectElement>('select[aria-label="sample"]')
    const trenchOption = sample?.querySelector<HTMLOptionElement>('option[value="trench"]')
    const swap = buttonNamed(app, 'Swap')
    expect(sample).not.toBeNull()
    expect(trenchOption?.disabled).toBe(true)
    expect(swap?.disabled).toBe(true)
    if (sample === null || swap === null) return

    act(() => change(sample, 'trench'))
    act(() => swap.click())
    expect(audio.beginSequence).not.toHaveBeenCalled()
    expect(fake.calls.filter((call) => call.method === 'view.swapTo')).toHaveLength(0)

    act(() => {
      idle?.({ didTimeout: false, timeRemaining: () => 50 })
    })
    await settle()
    expect(swap.disabled).toBe(true)
    expect(sample.querySelector<HTMLOptionElement>('option[value="jeans"]')?.disabled).toBe(false)
    trench.resolve(fake.addSprite('trench'))
    await settle()

    expect(trenchOption?.disabled).toBe(false)
    expect(swap.disabled).toBe(false)
    act(() => swap.click())
    expect(audio.beginSequence).toHaveBeenCalledTimes(1)
    expect(
      fake.calls.filter(
        (call) =>
          call.method === 'add' &&
          (call.args[1] as { readonly key?: string } | undefined)?.key === 'trench',
      ),
    ).toHaveLength(1)
  })

  it('does not let an old stage completion release a new stage prefetch gate', async () => {
    const idle: IdleRequestCallback[] = []
    vi.stubGlobal('requestIdleCallback', (callback: IdleRequestCallback) => {
      idle.push(callback)
      return idle.length
    })
    const oldTrench = deferred<ReturnType<FakeStageHandle['addSprite']>>()
    const newTrench = deferred<ReturnType<FakeStageHandle['addSprite']>>()
    const oldFake = createFakeStage({
      sprites: ['sweater'],
      add: async (_src, options) =>
        options.key === 'trench' ? oldTrench.promise : oldFake.addSprite(options.key),
    })
    const oldScene = sceneHarness(oldFake)
    currentDemo = oldScene.demo
    mockedCreateAudio.mockReturnValue(audioHarness().handle)
    const app = await renderApp()
    const oldEvents = currentEvents
    const oldSignal = new AbortController().signal
    act(() => oldEvents?.onReady?.(oldScene.built, { generation: 1, signal: oldSignal }))

    const newFake = createFakeStage({
      sprites: ['sweater'],
      add: async (_src, options) =>
        options.key === 'trench' ? newTrench.promise : newFake.addSprite(options.key),
    })
    const newScene = sceneHarness(newFake)
    currentDemo = newScene.demo
    await renderApp()
    const newSignal = new AbortController().signal
    act(() => currentEvents?.onReady?.(newScene.built, { generation: 2, signal: newSignal }))
    act(() => {
      for (const callback of idle) {
        callback({ didTimeout: false, timeRemaining: () => 50 })
      }
    })
    await settle()

    oldTrench.resolve(oldFake.addSprite('trench'))
    await settle()
    expect(buttonNamed(app, 'Swap')?.disabled).toBe(true)

    newTrench.resolve(newFake.addSprite('trench'))
    await settle()
    expect(buttonNamed(app, 'Swap')?.disabled).toBe(false)
  })
})
