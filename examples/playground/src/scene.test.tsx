// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type * as pc from '@paper-crumple/core'

import type { BuiltStage } from './config'
import { DEFAULT_CONFIG } from './config'
import type { DemoScene } from './scene'
import { defaultKnobValues, useDemoScene } from './scene'

/**
 * The smallest object `usePaperScene` actually touches: it reads `warnings` and `lost`, attaches
 * `on('error')`, calls `set` once per changed knob, and calls `dispose()` on cleanup. Everything
 * else on `BlitStage` is unreachable from this test, so the object is cast rather than stubbed —
 * a fuller fake would only be a second, worse copy of the package's own.
 */
function fakeStage(sets: [string, unknown][]): pc.BlitStage {
  return {
    warnings: [] as readonly Error[],
    lost: false,
    on: () => () => {},
    dispose: () => {},
    set: (patch: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(patch)) sets.push([k, v])
      return undefined
    },
  } as unknown as pc.BlitStage
}

function fakeBuilt(stage: pc.BlitStage): BuiltStage {
  return {
    stage,
    sheet: { knobs: [{ key: 'edgeWidth', kind: 'number', default: 12, min: 0, max: 40 }] },
    motion: { knobs: [] },
    buildMs: 1,
    artworkCssPx: 360,
  } as unknown as BuiltStage
}

const teardown: (() => void)[] = []
afterEach(() => {
  for (const fn of teardown.splice(0)) fn()
})

/**
 * Renders a hook and hands back a holder whose `value` is its last return.
 *
 * `value` is nullable and no helper throws on it: nothing in this repository throws, test helpers
 * included, so each test asserts non-null and returns early instead.
 */
function renderHook(run: () => DemoScene): { value: DemoScene | null } {
  const holder: { value: DemoScene | null } = { value: null }
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

/** One flush of the microtask queue the build resolves on. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

describe('defaultKnobValues', () => {
  it('is empty for a scene that has not built yet', () => {
    expect(defaultKnobValues(null)).toEqual({})
  })

  it('names every descriptor at its own default, keyed the way stage.set wants', () => {
    expect(defaultKnobValues(fakeBuilt(fakeStage([])))).toEqual({ 'sheet.edgeWidth': 12 })
  })
})

describe('useDemoScene', () => {
  it('reaches ready and exposes the built sidecar the Scene does not carry', async () => {
    const built = fakeBuilt(fakeStage([]))
    // Hoisted out of the render callback: a fresh function identity every render would make
    // `create` a new value every render, which is exactly the trap §4.1 warns about.
    const build = (): Promise<BuiltStage> => Promise.resolve(built)
    const observed = (): void => {}
    const probe = renderHook(() => useDemoScene(DEFAULT_CONFIG, observed, build))
    await settle()

    expect(probe.value).not.toBeNull()
    if (probe.value === null) return
    expect(probe.value.scene.status).toBe('ready')
    expect(probe.value.built).toBe(built)
  })

  it('writes a knob through the scene, one stage.set call per changed key', async () => {
    const sets: [string, unknown][] = []
    const built = fakeBuilt(fakeStage(sets))
    const build = (): Promise<BuiltStage> => Promise.resolve(built)
    const observed = (): void => {}
    const probe = renderHook(() => useDemoScene(DEFAULT_CONFIG, observed, build))
    await settle()
    if (probe.value === null) {
      expect(probe.value).not.toBeNull()
      return
    }
    const { setKnob } = probe.value
    act(() => {
      setKnob('sheet.edgeWidth', 20)
    })

    expect(sets).toEqual([['sheet.edgeWidth', 20]])
    expect(probe.value.knobs['sheet.edgeWidth']).toBe(20)
  })

  it('reports a build failure as scene.error and never throws', async () => {
    const seen: [string, Error][] = []
    const build = (): Promise<Error> => Promise.resolve(new Error('no webgl2 here'))
    const observed = (where: string, error: Error): void => {
      seen.push([where, error])
    }
    const probe = renderHook(() => useDemoScene(DEFAULT_CONFIG, observed, build))
    await settle()

    expect(probe.value).not.toBeNull()
    if (probe.value === null) return
    expect(probe.value.scene.status).toBe('failed')
    expect(probe.value.scene.error?.message).toBe('no webgl2 here')
    expect(probe.value.built).toBeNull()
    // A failed build is a return value, not an orphan error event, so §7's `!observed` filter
    // means nothing reaches the playground's own reporter.
    expect(seen).toEqual([])
  })

  it('resets by writing every default explicitly, because omission resets nothing', async () => {
    const sets: [string, unknown][] = []
    const built = fakeBuilt(fakeStage(sets))
    const build = (): Promise<BuiltStage> => Promise.resolve(built)
    const observed = (): void => {}
    const probe = renderHook(() => useDemoScene(DEFAULT_CONFIG, observed, build))
    await settle()
    if (probe.value === null) {
      expect(probe.value).not.toBeNull()
      return
    }
    const { setKnob } = probe.value
    act(() => {
      setKnob('sheet.edgeWidth', 20)
    })
    if (probe.value === null) return
    const { resetKnobs } = probe.value
    act(() => {
      resetKnobs()
    })

    expect(sets).toEqual([
      ['sheet.edgeWidth', 20],
      ['sheet.edgeWidth', 12],
    ])
  })

  it('seeds knobs with injected values through the scene', async () => {
    const sets: [string, unknown][] = []
    const built = fakeBuilt(fakeStage(sets))
    const build = (): Promise<BuiltStage> => Promise.resolve(built)
    const observed = (): void => {}
    const probe = renderHook(() => useDemoScene(DEFAULT_CONFIG, observed, build))
    await settle()
    if (probe.value === null) {
      expect(probe.value).not.toBeNull()
      return
    }
    const { seedKnobs } = probe.value
    act(() => {
      seedKnobs({ 'sheet.edgeWidth': 25 })
    })

    expect(sets).toEqual([['sheet.edgeWidth', 25]])
    expect(probe.value.knobs['sheet.edgeWidth']).toBe(25)
  })
})
