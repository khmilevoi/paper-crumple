import { useCallback, useMemo, useState } from 'react'
import * as pc from '@paper-crumple/core'
import { usePaperScene } from '@paper-crumple/react'
import type { KnobValue, Scene } from '@paper-crumple/react'

import type { BuiltStage, DemoConfig } from './config'
import { buildStage } from './config'
import type { KnobValues } from './knobs'
import { collectDescriptors, defaultValue } from './knobs'

/** The build seam. Production passes nothing and gets `buildStage`; the tests pass a fake, which
 *  is the only way to exercise this hook without a WebGL2 context. */
export type BuildStage = (
  config: DemoConfig,
  onError: (e: pc.StageEvent<'error'>) => void,
  signal: AbortSignal,
) => Promise<BuiltStage | Error | pc.Aborted>

export interface DemoScene {
  readonly scene: Scene
  readonly built: BuiltStage | null
  readonly knobs: KnobValues
  readonly setKnob: (key: string, value: KnobValue) => void
  readonly resetKnobs: () => void
  readonly seedKnobs: (values: KnobValues) => void
}

/**
 * Every descriptor the live stage declares, at its own default.
 *
 * `usePaperScene` diffs the `knobs` object against what it has already applied and writes only the
 * keys PRESENT in it (react spec §4.3). A key dropped from the object is never written back,
 * because the binding has no idea what its default is — so a reset is not `{}`, it is every
 * default, spelled out. `useStage.resetKnobs` wrote them one at a time for the same reason.
 */
export function defaultKnobValues(built: BuiltStage | null): KnobValues {
  if (built === null) return {}
  const out: Record<string, KnobValue> = {}
  for (const e of collectDescriptors(built)) out[e.key] = defaultValue(e.k)
  return out
}

/**
 * The playground's half of the scene: `usePaperScene` for the lifecycle, plus the two things the
 * binding's `Scene` deliberately does not carry.
 *
 * **The `BuiltStage` sidecar.** `SceneOptions.create` hands the binding a `pc.BlitStage` and
 * nothing else, but the panel needs the slot objects (`sheet.knobs`, `motion.packs()`,
 * `motion.setPoses`), the build timing and `artworkCssPx`. `create` is the consumer's own closure,
 * so it keeps them in state on the way past. The `signal.aborted` check before the write is what
 * stops a superseded build from clobbering the winner's sidecar.
 *
 * **`deps` is `[config]` and nothing else.** A rebuild is decided by `deps` alone (§4.1), and the
 * only thing `create` reads is `config`. In particular the SAMPLE is not in here: under `useStage`
 * a different sample rebuilt the stage, because `mountHero` mounted it; under `useCrumple` the
 * sprite is the crumple's business and a sample change is a swap, not a rebuild.
 */
export function useDemoScene(
  config: DemoConfig,
  observed: (where: string, error: Error) => void,
  build: BuildStage = buildStage,
): DemoScene {
  const [built, setBuilt] = useState<BuiltStage | null>(null)
  const [knobs, setKnobs] = useState<KnobValues>({})

  const create = useCallback(
    async (
      signal: AbortSignal,
      onError: (e: pc.StageEvent<'error'>) => void,
    ): Promise<pc.BlitStage | Error | pc.Aborted> => {
      setBuilt(null)
      // Both parameters go into the factory call. `onError` is the PRE-MOUNT error channel and is
      // the only reach the binding has into the window before the surface exists (§4.1); it stops
      // forwarding the moment `create` resolves, so nothing arrives twice.
      const made = await build(config, onError, signal)
      if (made === pc.ABORTED) return pc.ABORTED
      if (made instanceof Error) return made
      if (signal.aborted) return pc.ABORTED
      setBuilt(made)
      return made.stage
    },
    [build, config],
  )

  const onError = useCallback(
    (e: pc.StageEvent<'error'>): void => {
      // §7's orphan channel: `observed: true` means the error is, or will be, a return value
      // someone can narrow, so reporting it here as well double-counts it.
      if (!e.observed) observed('stage error event', e.error)
    },
    [observed],
  )

  const scene = usePaperScene({ create, deps: [config], knobs, onError })

  const setKnob = useCallback((key: string, value: KnobValue): void => {
    setKnobs((prev) => ({ ...prev, [key]: value }))
  }, [])

  const resetKnobs = useCallback((): void => {
    setKnobs(defaultKnobValues(built))
  }, [built])

  const seedKnobs = useCallback((values: KnobValues): void => {
    setKnobs(values)
  }, [])

  return useMemo(
    () => ({ scene, built, knobs, setKnob, resetKnobs, seedKnobs }),
    [built, knobs, resetKnobs, scene, seedKnobs, setKnob],
  )
}
