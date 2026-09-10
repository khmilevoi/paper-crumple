import { useCallback, useState } from 'react'
import * as pc from '@paper-crumple/core'
import { usePaperScene } from '@paper-crumple/react'
import type { CreateStage, Scene } from '@paper-crumple/react'

import type { BuiltStage, DemoConfig } from './config'
import { buildStage } from './config'

export interface DemoSceneEvents {
  readonly onReady?: (built: BuiltStage, info: { generation: number; signal: AbortSignal }) => void
  readonly onFailed?: (error: Error, info: { lost: boolean; generation: number }) => void
}

export interface DemoScene {
  readonly scene: Scene<BuiltStage>
  readonly knobs: pc.Knobs
  readonly setKnob: (key: string, value: pc.Knobs[string]) => void
  readonly resetKnobs: () => void
}

export function useDemoScene(
  config: DemoConfig,
  observed: (where: string, error: Error) => void,
  initialKnobs: pc.Knobs,
  events: DemoSceneEvents = {},
): DemoScene {
  const [knobs, setKnobs] = useState<pc.Knobs>(() => initialKnobs)

  const scene = usePaperScene<BuiltStage>(
    async (signal, onError): ReturnType<CreateStage<BuiltStage>> => {
      const made = await buildStage(config, onError, signal)
      if (made === pc.ABORTED || made instanceof Error) return made
      return { stage: made.stage, meta: made }
    },
    [config],
    {
      knobs,
      onError(e) {
        if (!e.observed) observed('stage error event', e.error)
      },
      onReady(build, info) {
        events.onReady?.(build.meta, info)
      },
      onFailed: events.onFailed,
    },
  )

  const setKnob = useCallback((key: string, value: pc.Knobs[string]): void => {
    setKnobs((prev) => ({ ...prev, [key]: value }))
  }, [])

  const resetKnobs = useCallback((): void => {
    setKnobs({})
  }, [])

  return { scene, knobs, setKnob, resetKnobs }
}
