// @vitest-environment jsdom
import { createFakeStage } from '@paper-crumple/react/testing'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildStage, DEFAULT_CONFIG, type BuiltStage } from './config'
import { useDemoScene } from './scene'

vi.mock('./config', async () => {
  const actual = await vi.importActual<typeof import('./config')>('./config')
  return { ...actual, buildStage: vi.fn() }
})

const mockedBuild = vi.mocked(buildStage)

function builtFrom(stage: ReturnType<typeof createFakeStage>['stage']): BuiltStage {
  return {
    stage,
    sheet: { knobs: [] },
    motion: { knobs: [], packs: () => [], setPoses: () => undefined },
    buildMs: 1,
    artworkCssPx: 360,
  } as unknown as BuiltStage
}

const teardown: (() => void)[] = []
afterEach(() => {
  for (const fn of teardown.splice(0)) fn()
})

function renderHook(run: () => ReturnType<typeof useDemoScene>): {
  value: ReturnType<typeof useDemoScene> | null
} {
  const holder: { value: ReturnType<typeof useDemoScene> | null } = { value: null }
  function Probe(): null {
    holder.value = run()
    return null
  }
  const root = createRoot(document.createElement('div'))
  act(() => {
    root.render(<Probe />)
  })
  teardown.push(() => {
    act(() => {
      root.unmount()
    })
  })
  return holder
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

describe('useDemoScene', () => {
  beforeEach(() => mockedBuild.mockReset())

  it('lands the full build in scene.meta and applies lazy initial knobs', async () => {
    const fake = createFakeStage({ defaults: { 'sheet.edgeWidth': 12 } })
    const built = builtFrom(fake.stage)
    mockedBuild.mockResolvedValue(built)
    const onReady = vi.fn()
    const probe = renderHook(() =>
      useDemoScene(DEFAULT_CONFIG, () => {}, { 'sheet.edgeWidth': 25 }, { onReady }),
    )
    await settle()
    await settle()
    expect(probe.value?.scene.status).toBe('ready')
    expect(probe.value?.scene.meta).toBe(built)
    expect(onReady).toHaveBeenCalledWith(
      built,
      expect.objectContaining({ generation: 1, signal: expect.any(AbortSignal) }),
    )
    expect(fake.calls).toContainEqual({ method: 'set', args: [{ 'sheet.edgeWidth': 25 }] })
  })

  it('resets by omitting the controlled keys so stage.defaults restores them', async () => {
    const fake = createFakeStage({ defaults: { 'sheet.edgeWidth': 12 } })
    mockedBuild.mockResolvedValue(builtFrom(fake.stage))
    const probe = renderHook(() => useDemoScene(DEFAULT_CONFIG, () => {}, {}))
    await settle()
    act(() => probe.value?.setKnob('sheet.edgeWidth', 20))
    act(() => probe.value?.resetKnobs())
    expect(probe.value?.knobs).toEqual({})
    expect(fake.calls.filter((call) => call.method === 'set').at(-1)?.args[0]).toEqual({
      'sheet.edgeWidth': 12,
    })
  })

  it('forwards a build failure through onFailed without a built sidecar', async () => {
    const error = new Error('no webgl2 here')
    mockedBuild.mockResolvedValue(error)
    const onReady = vi.fn()
    const onFailed = vi.fn()
    const probe = renderHook(() =>
      useDemoScene(DEFAULT_CONFIG, () => {}, {}, { onReady, onFailed }),
    )
    await settle()
    expect(probe.value?.scene).toMatchObject({ status: 'failed', error, meta: null })
    expect(onReady).not.toHaveBeenCalled()
    expect(onFailed).toHaveBeenCalledWith(error, { lost: false, generation: 0 })
  })
})
