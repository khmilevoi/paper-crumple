// @vitest-environment jsdom
import { createFakeStage } from '@paper-crumple/react/testing'
import { percentWidthReserve } from '@paper-crumple/core/unstable'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildStage, configForInitialKnobs, DEFAULT_CONFIG, type BuiltStage } from './config'
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

  it('buys enough factory reserve for persisted percent edge knobs before the first add', async () => {
    const fake = createFakeStage({
      defaults: { 'sheet.edgeWidth': 5.9, 'sheet.edgeVariance': 0.53 },
    })
    mockedBuild.mockResolvedValue(builtFrom(fake.stage))
    const config = { ...DEFAULT_CONFIG, edgeWidthUnit: 'percent' as const, overscanHeadroom: 0.3 }
    renderHook(() =>
      useDemoScene(config, () => {}, {
        'sheet.edgeWidth': 15,
        'sheet.edgeVariance': 0.57,
        'sheet.deckleTex': 0.4,
      }),
    )
    await settle()

    const builtConfig = mockedBuild.mock.calls[0]?.[0]
    expect(builtConfig).toBeDefined()
    if (builtConfig === undefined) return
    const reserved = percentWidthReserve({
      pct: 0.059,
      aspect: 1,
      variance: 0.53,
      finishTerms: 0,
      headroom: builtConfig.overscanHeadroom,
    }).radius
    const needed = percentWidthReserve({
      pct: 0.15,
      aspect: 1,
      variance: 0.57,
      finishTerms: 0,
      headroom: config.overscanHeadroom,
    }).radius
    expect(reserved).toBeGreaterThanOrEqual(needed)
    expect(builtConfig.overscanHeadroom).toBeGreaterThan(config.overscanHeadroom)
    expect(fake.calls).toContainEqual({ method: 'set', args: [{ 'sheet.edgeWidth': 15 }] })
    expect(fake.calls).toContainEqual({ method: 'set', args: [{ 'sheet.edgeVariance': 0.57 }] })
    expect(fake.calls).not.toContainEqual({ method: 'set', args: [{ 'sheet.deckleTex': 0.4 }] })
  })

  it('covers the portrait endpoint when persisted paper finish terms exceed their defaults', () => {
    const config = {
      ...DEFAULT_CONFIG,
      edgeFinish: 'paper' as const,
      edgeWidthUnit: 'percent' as const,
      overscanHeadroom: 0.3,
    }
    const builtConfig = configForInitialKnobs(config, {
      'sheet.edgeWidth': 5.9,
      'sheet.edgeVariance': 0.53,
      'sheet.fiberLen': 12,
      'sheet.deckleWidth': 40,
    })
    for (const aspect of [0, 1]) {
      const reserved = percentWidthReserve({
        pct: 0.059,
        aspect,
        variance: 0.53,
        finishTerms: 23,
        headroom: builtConfig.overscanHeadroom,
      }).radius
      const needed = percentWidthReserve({
        pct: 0.059,
        aspect,
        variance: 0.53,
        finishTerms: 88,
        headroom: config.overscanHeadroom,
      }).radius
      expect(reserved, `aspect ${String(aspect)}`).toBeGreaterThanOrEqual(needed)
    }
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
