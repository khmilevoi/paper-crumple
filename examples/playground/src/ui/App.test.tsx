// @vitest-environment jsdom
import { ABORTED, SheetError } from '@paper-crumple/core'
import { bakedMotion } from '@paper-crumple/motion'
import type { Pack } from '@paper-crumple/motion'
import pack1x1 from '@paper-crumple/motion/packs/1x1'
import { paperSheet } from '@paper-crumple/paper'
import type { Scene } from '@paper-crumple/react'
import { createFakeStage, readyScene } from '@paper-crumple/react/testing'
import type { FakeStageHandle } from '@paper-crumple/react/testing'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AudioHandle, AudioSnapshot } from '../audio'
import { createAudio } from '../audio'
import type { BuiltStage } from '../config'
import type { DemoScene } from '../scene'
import { useDemoScene } from '../scene'

import { App } from './App'

vi.mock('../audio', async () => {
  const actual = await vi.importActual<typeof import('../audio')>('../audio')
  return { ...actual, createAudio: vi.fn() }
})

vi.mock('../scene', async () => {
  const actual = await vi.importActual<typeof import('../scene')>('../scene')
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
  readonly demo: DemoScene
  readonly stop: ReturnType<typeof vi.fn>
}

let root: ReturnType<typeof createRoot> | null = null
let container: HTMLDivElement | null = null
let currentDemo: DemoScene | null = null

afterEach(() => {
  if (root !== null) {
    act(() => root?.unmount())
  }
  container?.remove()
  root = null
  container = null
  currentDemo = null
  vi.clearAllMocks()
})

beforeEach(() => {
  mockedUseDemoScene.mockImplementation(() => {
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
    stop,
    demo: {
      scene,
      knobs: {},
      setKnob: vi.fn(),
      resetKnobs: vi.fn(),
    },
  }
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
})
