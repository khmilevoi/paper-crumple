import { ABORTED, assertSingleCore, GlError } from '@paper-crumple/core'
import { createSceneController } from '@paper-crumple/core/bindings'
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
  lost: boolean
  warnings: readonly Error[]
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
  const lost = core.lost || (stage !== null && stage.lost)
  const counters: SceneCounters = {
    warnings: stage?.warnings ?? core.warnings,
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

/**
 * The positional form (§3.5). It mirrors `useMemo`, so `react-hooks/exhaustive-deps` configured
 * with `additionalHooks: '(usePaperScene)'` checks the dependency list against what `create`
 * actually reads — which the options bag cannot offer, because the list is a property value.
 */
export function usePaperScene<M = undefined>(
  create: SceneOptions<M>['create'],
  deps: readonly unknown[],
  options?: Omit<SceneOptions<M>, 'create' | 'deps'>,
): Scene<M>
/**
 * The canonical form. Declared last on purpose: `Parameters<T>` and `ReturnType<T>` read the last
 * overload, and this is the one the public type tests pin.
 */
export function usePaperScene<M = undefined>(o: SceneOptions<M>): Scene<M>
export function usePaperScene<M = undefined>(
  a: SceneOptions<M> | SceneOptions<M>['create'],
  b?: readonly unknown[],
  c?: Omit<SceneOptions<M>, 'create' | 'deps'>,
): Scene<M> {
  // Normalised once, at the top: everything below this line sees the options bag and nothing
  // knows which shape the caller used. `b` is non-optional in the positional overload, so the
  // `?? []` is unreachable through either public signature and exists only to type the fallback.
  const o: SceneOptions<M> = typeof a === 'function' ? { ...c, create: a, deps: b ?? [] } : a

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
  const dispatchFailed = useEvent(
    (error: Error, info: { lost: boolean; generation: number }): void => {
      o.onFailed?.(error, info)
    },
  )

  const [core] = useState<SceneCore<M>>(() => ({
    status: 'building',
    build: null,
    error: null,
    lost: false,
    warnings: NO_WARNINGS,
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
    let active = true
    let build: SceneBuild<M> | null = null
    let landed = false
    let reportedFailure = false
    const reportFailure = (error: Error, lost: boolean): void => {
      if (reportedFailure) return
      reportedFailure = true
      dispatchFailed(error, { lost, generation: core.generation })
    }

    // Metadata belongs to React; the shared controller owns the raw stage lifetime.
    const lifetime = createSceneController<BlitStage>(async (signal, onError) => {
      const duplicate = duplicateCore()
      if (duplicate !== undefined) return duplicate
      const built = await create(signal, onError)
      if (built === ABORTED || built instanceof Error) return built
      build = 'stage' in built ? built : { stage: built, meta: undefined as M }
      return build.stage
    })

    // eslint-disable-next-line react-hooks/immutability -- This stable mutable record is published through store.bump().
    core.status = 'building'
    core.build = null
    core.error = null
    core.lost = false
    core.warnings = NO_WARNINGS
    store.bump()

    const offLifecycle = lifetime.subscribe(() => {
      if (!active) return
      if (lifetime.status === 'ready' && lifetime.stage !== null && build !== null) {
        landed = true
        core.build = build
        core.status = 'ready'
        core.error = null
        core.generation += 1
        store.bump()
        dispatchReady(build, { generation: core.generation, signal: lifetime.signal })
        return
      }
      if (lifetime.status === 'failed' || lifetime.status === 'disposed') {
        // An already-lost returned stage still landed and receives React's build generation.
        if (!landed && build !== null && lifetime.lost) {
          landed = true
          core.generation += 1
        }
        core.warnings = build?.stage.warnings ?? core.warnings
        core.lost = lifetime.lost
        core.build = null
        build = null
        if (lifetime.status === 'failed' || landed) {
          core.status = 'failed'
          core.error = lifetime.error ?? new GlError('this stage is disposed; build a new one')
        }
        store.bump()
        // The error channel reports loss with the actual raw cause.
        if (core.error !== null && !core.lost) reportFailure(core.error, false)
      }
    })
    const offError = lifetime.onError((event) => {
      if (!active) return
      if (lifetime.lost) core.error = lifetime.error
      dispatchError(event)
      store.bump()
      if (lifetime.lost) reportFailure(core.error ?? LOST_WITHOUT_CAUSE, true)
    })

    void lifetime.ensure().then(() => {
      // An already-lost factory result emits no new raw event after we attach.
      if (active && lifetime.status === 'failed' && lifetime.lost) {
        reportFailure(lifetime.error ?? LOST_WITHOUT_CAUSE, true)
      }
    })

    return () => {
      active = false
      offLifecycle()
      offError()
      lifetime.dispose()
      build = null
    }
    // Rebuild only for declared deps; dispatchers and backing records are stable.
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

    const declared = knobs ?? NO_KNOBS

    let wrote = false
    for (const [key, value] of Object.entries(declared)) {
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

    // §3.4: a key the consumer stopped declaring goes back to the stage's own default. Before
    // `stage.defaults` the hook could not know one — `stage.knobs` carries slot-local keys with no
    // path — so a consumer's reset had to walk the descriptors itself. The keys are snapshotted
    // because the map is written inside the loop.
    for (const key of [...applied.values.keys()]) {
      if (Object.hasOwn(declared, key)) continue
      applied.values.delete(key)
      // Silently skipped when the stage declares no default under this spelling: `stage.defaults`
      // is keyed by the registry's own paths, and a shared knob is written back through its bare
      // shared key, so not every key a consumer may legally write appears here. An own-property
      // test rather than an `undefined` check, matching the write loop above: a consumer key of
      // `toString` or `constructor` resolves through the prototype chain to an `Object.prototype`
      // member, which is not `undefined`, and the stage would be handed a function to store.
      if (!Object.hasOwn(live.defaults, key)) continue
      const fallback = live.defaults[key]
      // Silent on refusal too: `onError` and `onKnobRefused` report what the consumer wrote, and
      // removing a key is not a write.
      if (live.set({ [key]: fallback } as never) !== undefined) continue
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
      const live = core.status === 'ready' ? (core.build?.stage ?? null) : null
      // Not an error and it does not queue: an empty report with `completed: false` is what a
      // broadcast over zero eligible views reports (§4.1).
      if (live === null) return emptyReport()
      return live.play(from, to, options)
    },
  )

  const stop = useEvent((options?: { all?: boolean }): void => {
    const live = core.status === 'ready' ? (core.build?.stage ?? null) : null
    live?.stop(options)
  })

  // `snapshot` changes identity only on a bump, so the Scene does too (§2.1).
  return useMemo<Scene<M>>(() => ({ ...snapshot, play, stop }), [snapshot, play, stop])
}
