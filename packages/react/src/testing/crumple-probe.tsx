import type { BlitStage, SpriteSource } from '@paper-crumple/core'
import { act, createElement, type ReactNode } from 'react'
import type { Crumple } from '../crumple.js'
import type { CrumpleOptions } from '../crumple-types.js'
import type { Scene } from '../scene-types.js'
import { useCrumple } from '../use-crumple.js'
import { flush, render, type Harness } from './render.js'

/** A `Scene` literal, so a crumple test needs no `usePaperScene` and no factory. */
export function readyScene(
  stage: BlitStage,
  o?: { generation?: number; knobEpoch?: number },
): Scene {
  return {
    status: 'ready',
    stage,
    error: null,
    warnings: [],
    lost: false,
    generation: o?.generation ?? 1,
    knobEpoch: o?.knobEpoch ?? 0,
    play: async () => ({ started: [], skipped: [], failed: [], completed: false }),
    stop: () => {},
  }
}

export function buildingScene(): Scene {
  return {
    status: 'building',
    stage: null,
    error: null,
    warnings: [],
    lost: false,
    generation: 0,
    knobEpoch: 0,
    play: async () => ({ started: [], skipped: [], failed: [], completed: false }),
    stop: () => {},
  }
}

/** One instance, not one per render: a fresh identity per render would be a different test. */
const BUILDING: Scene = buildingScene()

export type ProbeOptions = CrumpleOptions<SpriteSource>

export interface ProbeInput {
  /** A `Scene` · `null` for a scene that is still building · `'context'` for no `scene` option at
   *  all, which sends the hook to `useScene()`. Defaults to `'context'`. */
  readonly scene?: Scene | null | 'context'
  readonly options?: ProbeOptions
  readonly strict?: boolean
}

export interface CrumpleProbe {
  readonly current: Crumple
  /** Re-render with the scene and/or the options replaced. Omitted fields keep their last value. */
  rerender(next?: ProbeInput): Promise<void>
  /** Call an instance method inside `act`, so the store bump it causes is committed. */
  run(fn: () => void): Promise<void>
  unmount(): Promise<void>
}

export async function renderCrumple(
  options: ProbeOptions,
  input?: ProbeInput,
): Promise<CrumpleProbe> {
  let current: ProbeOptions = options
  let scene: Scene | null | 'context' =
    input !== undefined && 'scene' in input && input.scene !== undefined ? input.scene : 'context'
  const box: { value: Crumple | null } = { value: null }

  const Probe = () => {
    const resolved: ProbeOptions =
      scene === 'context' ? current : { ...current, scene: scene ?? BUILDING }
    const crumple = useCrumple(resolved)
    box.value = crumple
    return createElement('canvas', { ref: crumple.ref })
  }

  const ui = (): ReactNode => createElement(Probe)
  const harness: Harness = await render(ui(), { strict: input?.strict ?? false })
  await flush()

  return {
    get current(): Crumple {
      // The probe has rendered at least once before any read, so `value` is set. The fallback
      // keeps the type honest without a non-null assertion and without a throw.
      return box.value ?? ({} as Crumple)
    },
    async rerender(next?: ProbeInput): Promise<void> {
      if (next?.options !== undefined) current = next.options
      if (next !== undefined && 'scene' in next) scene = next.scene ?? null
      await harness.rerender(ui())
      await flush()
    },
    async run(fn: () => void): Promise<void> {
      await act(async () => {
        fn()
      })
      await flush()
    },
    async unmount(): Promise<void> {
      await harness.unmount()
    },
  }
}
