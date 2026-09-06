import { ABORTED, assertSingleCore, GlError } from '@paper-crumple/core'
import type {
  BlitStage,
  PoseRef,
  StageEvent,
  StagePlayOptions,
  StagePlayReport,
  View,
} from '@paper-crumple/core'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { createVersionedStore } from './store.js'
import { useEvent } from './use-event.js'
import type { Scene, SceneOptions, SceneSnapshot, SceneStatus } from './scene-types.js'

/** The mutable record the snapshot is read out of. One per hook instance, never replaced. */
interface SceneCore {
  status: SceneStatus
  stage: BlitStage | null
  error: Error | null
  generation: number
  knobEpoch: number
}

const NO_WARNINGS: readonly Error[] = Object.freeze([])

/**
 * Carried when the context is lost before any `error` event has named a cause. `dead()` makes
 * every stage method return an error after a loss, so a scene reporting `ready` would be handing
 * consumers a stage on which nothing works.
 */
const LOST_WITHOUT_CAUSE: Error = new GlError(
  'the WebGL2 context was lost; dispose this stage and build a new one',
)

function emptyReport(): StagePlayReport<View> {
  return { started: [], skipped: [], failed: [], completed: false }
}

/**
 * `stage.warnings` grows at runtime and `stage.lost` is the synchronous form of the `lost` event,
 * so both are read here — on every bump — rather than mirrored once at build time (§5.5).
 */
function readScene(core: SceneCore): SceneSnapshot {
  const lost = core.stage !== null && core.stage.lost
  const failed = lost || core.status === 'failed'
  return {
    status: failed ? 'failed' : core.status,
    stage: failed ? null : core.stage,
    error: failed ? (core.error ?? LOST_WITHOUT_CAUSE) : null,
    warnings: core.stage?.warnings ?? NO_WARNINGS,
    lost,
    generation: core.generation,
    knobEpoch: core.knobEpoch,
  }
}

/**
 * §3: the gate runs in development only. `globalThis.process` is read through a cast rather than
 * as a bare `process` identifier so the package needs no `@types/node`; the cost is that a
 * bundler's `process.env.NODE_ENV` define does not statically strip the call, and the check — one
 * property read and one identity comparison — stays. An environment with no `process` at all is
 * treated as development, which is the usual library convention.
 */
function duplicateCore(): Error | undefined {
  const env = (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process?.env
  if (env?.NODE_ENV === 'production') return undefined
  return assertSingleCore()
}

export function usePaperScene(o: SceneOptions): Scene {
  const create = useEvent(o.create)
  /** One dispatcher fed from two places, and the binding keeps it single (§7). */
  const dispatchError = useEvent((e: StageEvent<'error'>): void => {
    o.onError?.(e)
  })

  const [core] = useState<SceneCore>(() => ({
    status: 'building',
    stage: null,
    error: null,
    generation: 0,
    knobEpoch: 0,
  }))
  const [store] = useState(() => createVersionedStore<SceneSnapshot>(() => readScene(core)))

  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot)

  useEffect(() => {
    const controller = new AbortController()
    const offs: Array<() => void> = []
    let landed: BlitStage | null = null
    let resolved = false

    /**
     * Handed down so the consumer can spread it into `paperStage`'s own `onError`, which core
     * registers on the bus permanently. It therefore forwards only while the scene is still
     * building; `stage.on('error')` takes over the moment `create` resolves, and nobody sees an
     * error twice (§7).
     */
    const preMount = (e: StageEvent<'error'>): void => {
      if (resolved || controller.signal.aborted) return
      dispatchError(e)
    }

    // eslint-disable-next-line react-hooks/immutability -- `core` is an intentionally mutable record held once per hook instance and never replaced; `store.bump()` publishes each write (§5.5).
    core.status = 'building'
    core.stage = null
    core.error = null
    store.bump()

    // Before `create`, and a returned CoreDuplicateError fails the scene outright: this is a
    // startup failure, not a once-per-session console warning (§3).
    const duplicate = duplicateCore()
    if (duplicate !== undefined) {
      core.status = 'failed'
      core.error = duplicate
      store.bump()
      return () => {
        controller.abort()
      }
    }

    void (async () => {
      const built = await create(controller.signal, preMount)
      resolved = true

      if (controller.signal.aborted) {
        // A `create` that ignores its signal still must not leak: §1's self-cleanup covers the
        // factory's own checkpoints, not a stage that resolved after this effect was torn down.
        if (built !== ABORTED && !(built instanceof Error)) built.dispose()
        return
      }
      // "React changed its mind" is not a condition a component renders (§7).
      if (built === ABORTED) return

      if (built instanceof Error) {
        core.status = 'failed'
        core.error = built
        store.bump()
        return
      }

      landed = built
      offs.push(
        built.on('error', (e) => {
          // The loss GlError is orphaned with `view: null` and arrives immediately after the
          // `lost` event, in the same synchronous stack. Latch it as the scene's cause; anything
          // later must not overwrite it.
          if (built.lost && core.error === null) core.error = e.error
          dispatchError(e)
          // Bump on every error, not only on a loss: `stage.warnings` grows at runtime and this
          // is the only moment it can have (§5.5).
          store.bump()
        }),
      )
      offs.push(
        built.on('lost', () => {
          // `readScene` derives `status` and `lost` from `stage.lost`, so the listener's whole
          // job is to give it a reason to run.
          store.bump()
        }),
      )
      core.stage = built
      core.status = 'ready'
      core.error = null
      core.generation += 1
      store.bump()
    })()

    return () => {
      // Both halves, always: abort the in-flight build AND dispose the landed one. §1's
      // constraint covers only the loser of a double-invocation; a stage superseded by a `deps`
      // change is nobody else's to release, and reading §1 as "cleanup is handled" leaks one
      // WebGL2 context per rebuild against the ~16 the ceiling allows.
      controller.abort()
      for (const off of offs) off()
      landed?.dispose()
    }
    // §4.1: a rebuild is decided by `deps` and by nothing else. `create` is useEvent-stable, and
    // `core` and `store` are created once by useState and never replaced, and `dispatchError` is
    // useEvent-stable too, so none of them belongs in the dependency list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, o.deps)

  const play = useEvent(
    async (
      from: PoseRef,
      to: PoseRef,
      options?: StagePlayOptions,
    ): Promise<StagePlayReport<View>> => {
      const live = snapshot.status === 'ready' ? snapshot.stage : null
      // Not an error and it does not queue: an empty report with `completed: false` is what a
      // broadcast over zero eligible views reports (§4.1).
      if (live === null) return emptyReport()
      return live.play(from, to, options)
    },
  )

  const stop = useEvent((options?: { all?: boolean }): void => {
    const live = snapshot.status === 'ready' ? snapshot.stage : null
    live?.stop(options)
  })

  // `snapshot` changes identity only on a bump, so the Scene does too (§2.1).
  return useMemo<Scene>(() => ({ ...snapshot, play, stop }), [snapshot, play, stop])
}
