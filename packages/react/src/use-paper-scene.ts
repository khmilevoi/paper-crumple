import { ABORTED, assertSingleCore, GlError } from '@paper-crumple/core'
import type {
  BlitStage,
  Knobs,
  PoseRef,
  StageEvent,
  StagePlayOptions,
  StagePlayReport,
  View,
} from '@paper-crumple/core'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { createVersionedStore } from './store.js'
import { useEvent } from './use-event.js'
import type {
  Scene,
  SceneBuild,
  SceneCounters,
  SceneOptions,
  SceneSnapshot,
  SceneStatus,
} from './scene-types.js'

/** The mutable record the snapshot is read out of. One per hook instance, never replaced. */
interface SceneCore<M> {
  status: SceneStatus
  /**
   * The landed build, stage and metadata together (§3.2). One field rather than two, so `meta`
   * is cleared with `stage` by construction: there is no state in which a stale `meta` can
   * outlive the stage it described.
   */
  build: SceneBuild<M> | null
  error: Error | null
  generation: number
  knobEpoch: number
}

const NO_WARNINGS: readonly Error[] = Object.freeze([])

const NO_KNOBS: Knobs = Object.freeze({})

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
function readScene<M>(core: SceneCore<M>): SceneSnapshot<M> {
  const stage = core.build?.stage ?? null
  const lost = stage !== null && stage.lost
  const counters: SceneCounters = {
    warnings: stage?.warnings ?? NO_WARNINGS,
    lost,
    generation: core.generation,
    knobEpoch: core.knobEpoch,
  }
  // A lost context is a failure whatever `core.status` says: `dead()` makes every stage method
  // return an error after a loss, so a scene reporting `ready` would be handing consumers a
  // stage on which nothing works.
  if (lost || core.status === 'failed') {
    return {
      ...counters,
      status: 'failed',
      stage: null,
      meta: null,
      error: core.error ?? LOST_WITHOUT_CAUSE,
    }
  }
  if (core.status === 'ready' && core.build !== null) {
    return {
      ...counters,
      status: 'ready',
      stage: core.build.stage,
      meta: core.build.meta,
      error: null,
    }
  }
  return { ...counters, status: 'building', stage: null, meta: null, error: null }
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

export function usePaperScene<M = undefined>(o: SceneOptions<M>): Scene<M> {
  const create = useEvent(o.create)
  /** One dispatcher fed from two places, and the binding keeps it single (§7). */
  const dispatchError = useEvent((e: StageEvent<'error'>): void => {
    o.onError?.(e)
  })
  const dispatchKnobRefused = useEvent((key: string, value: Knobs[string], error: Error): void => {
    o.onKnobRefused?.(key, value, error)
  })
  const dispatchReady = useEvent(
    (build: SceneBuild<M>, info: { generation: number; signal: AbortSignal }): void => {
      o.onReady?.(build, info)
    },
  )

  const [core] = useState<SceneCore<M>>(() => ({
    status: 'building',
    build: null,
    error: null,
    generation: 0,
    knobEpoch: 0,
  }))
  const [store] = useState(() => createVersionedStore<SceneSnapshot<M>>(() => readScene(core)))
  const [applied] = useState<{ values: Map<string, Knobs[string]>; generation: number }>(() => ({
    values: new Map(),
    generation: 0,
  }))

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
    core.build = null
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
      let settled: SceneBuild<M> | BlitStage | typeof ABORTED | Error
      try {
        settled = await create(controller.signal, preMount)
      } catch (cause) {
        resolved = true
        // A thrown `create` degrades into the same `failed` state an Error return produces
        // (§7): nothing this package returns rejects. A throw after cleanup must not publish,
        // exactly as a late-landing stage must not.
        if (controller.signal.aborted) return
        core.status = 'failed'
        core.error = cause instanceof Error ? cause : new Error(String(cause))
        store.bump()
        return
      }
      resolved = true
      // Reassigned into a `const` so the closures below — `built.on('error', …)` in particular —
      // narrow it the way they did before the `try` forced `settled` to be a `let`.
      const built = settled

      if (controller.signal.aborted) {
        // A `create` that ignores its signal still must not leak: §1's self-cleanup covers the
        // factory's own checkpoints, not a stage that resolved after this effect was torn down.
        // Unwrap first: a `SceneBuild` has no `dispose`, its `stage` does.
        if (built !== ABORTED && !(built instanceof Error)) {
          ;('stage' in built ? built.stage : built).dispose()
        }
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

      // §3.2: a bare `BlitStage` is the `M = undefined` shape. `stage` is a required property of
      // `SceneBuild` and no stage declares one, so it is the discriminant. The cast is the one in
      // this file and it is load-bearing: `M`'s default is `undefined`, and a consumer who
      // declares a non-`undefined` `M` and then returns a bare stage has asked for `meta` to be a
      // lie.
      const build: SceneBuild<M> = 'stage' in built ? built : { stage: built, meta: undefined as M }

      landed = build.stage
      offs.push(
        build.stage.on('error', (e) => {
          // The loss GlError is orphaned with `view: null` and arrives immediately after the
          // `lost` event, in the same synchronous stack. Latch it as the scene's cause; anything
          // later must not overwrite it.
          if (build.stage.lost && core.error === null) core.error = e.error
          dispatchError(e)
          // Bump on every error, not only on a loss: `stage.warnings` grows at runtime and this
          // is the only moment it can have (§5.5).
          store.bump()
        }),
      )
      offs.push(
        build.stage.on('lost', () => {
          // `readScene` derives `status` and `lost` from `stage.lost`, so the listener's whole
          // job is to give it a reason to run.
          store.bump()
        }),
      )
      core.build = build
      core.status = 'ready'
      core.error = null
      core.generation += 1
      store.bump()
      // §3.1: after the bump, so the consumer's callback and the snapshot agree, and §5.5's "the
      // store is the source" stays true — both channels fire from this one site. A build that
      // landed already lost is a failure, not a readiness.
      if (store.getSnapshot().status === 'ready') {
        dispatchReady(build, { generation: core.generation, signal: controller.signal })
      }
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
    // `core` and `store` are created once by useState and never replaced, and `dispatchError` and
    // `dispatchReady` are useEvent-stable too, so none of them belongs in the dependency list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, o.deps)

  const knobs = o.knobs
  useEffect(() => {
    const live = snapshot.status === 'ready' ? snapshot.stage : null
    if (live === null) return

    // A rebuild is not a reset (§4.1): the knobs the consumer moved are re-applied to the new
    // stage. `carried` is narrower than `rebuilt` on purpose — the first landed build is a
    // rebuild by generation but carries nothing, so its writes are live writes and a refusal on
    // one of them is reported. Only a genuine carry-forward onto a replacement stage is silent.
    const rebuilt = applied.generation !== snapshot.generation
    // Which keys are being carried forward onto a replacement stage, captured before the map is
    // cleared. Per key, not per pass: a key added in the same render that changed `deps` is a
    // live write, and §4.3 reports a refusal on a live write — only a genuine carry-forward is
    // silent.
    const carried = rebuilt ? new Set(applied.values.keys()) : new Set<string>()
    if (rebuilt) {
      applied.values.clear()
      // eslint-disable-next-line react-hooks/immutability -- `applied` is an intentionally mutable record held once per hook instance and never replaced; it tracks what has already reached the stage and is never handed to a consumer.
      applied.generation = snapshot.generation
    }

    let wrote = false
    for (const [key, value] of Object.entries(knobs ?? NO_KNOBS)) {
      if (applied.values.has(key) && Object.is(applied.values.get(key), value)) continue
      // Recorded before the write, so a refused key is attempted once rather than on every
      // render until the consumer changes it.
      applied.values.set(key, value)
      // One `stage.set` call per changed key, never one call carrying the whole diff: `normalise`
      // returns on the first invalid key and `applyPatch` only reaches `Object.assign` for a
      // wholly valid patch, so a single batched call applies none of it when any key is bad.
      const refused = live.set({ [key]: value } as never)
      if (refused !== undefined) {
        // §0.3: `observed: false`. `observed` means "is, or will be, a return value someone can
        // narrow", and §7 tells consumers to filter on it. The only someone who could narrow this
        // return value is this hook, and it does not hand it back — so dispatching it observed
        // filtered the one report of the refusal away and made a refused slider a silent no-op.
        if (!carried.has(key)) {
          dispatchError({ error: refused, observed: false, view: null })
          dispatchKnobRefused(key, value, refused)
        }
        continue
      }
      wrote = true
    }

    if (!wrote) return
    // A second counter alongside `generation`: a knob write is not a build and must not
    // masquerade as one. One bump per batch — each crumple joins its own `prepare` off it (§4.3).
    // eslint-disable-next-line react-hooks/immutability -- `core` is an intentionally mutable record held once per hook instance and never replaced; `store.bump()` publishes each write (§5.5).
    core.knobEpoch += 1
    store.bump()
  }, [
    applied,
    core,
    dispatchError,
    dispatchKnobRefused,
    knobs,
    snapshot.generation,
    snapshot.stage,
    snapshot.status,
    store,
  ])

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
  return useMemo<Scene<M>>(() => ({ ...snapshot, play, stop }), [snapshot, play, stop])
}
