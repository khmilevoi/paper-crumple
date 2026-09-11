import { ABORTED, isAborted, type Aborted } from './abort.js'
import { attempt } from './attempt.js'
import {
  createChangeBatch,
  createChanges,
  type ChangeSource,
  type ChangePublisher,
} from './changes.js'
import { createIngestLane, type IngestClass, type IngestSlot } from './ingest-lane.js'
import { blitPlan, managedBackingStore } from './blit.js'
import {
  planStagePlay,
  stagePlayReport,
  type ChainOutcome,
  type StagePlayCandidate,
  type StagePlayReport,
} from './collisions.js'
import { batchBySortKey } from './draw-batch.js'
import { resolvePose } from './dwell.js'
import { createErrorPolicy, type ErrorPolicy } from './error-policy.js'
import { createEventBus, type EventBus } from './emitter.js'
import {
  AssetError,
  GlError,
  KnobError,
  SheetError,
  SourceExpiredError,
  ViewError,
} from './errors.js'
import type { KnobDescriptor } from './forward.js'
import { createFrontLru, type FrontLru, type FrontLruUsage } from './front-lru.js'
import type { Size } from './geometry.js'
import { createGlContext, type CoreGlContext } from './gl-context.js'
import { createScratchPools, type ScratchPools } from './gl-pools.js'
import type { DrawTarget, GlCaps } from './gl.js'
import type { EventName, Events, StageEvent } from './events.js'
import { atOrAbove, INVALIDATION_ORDER, SPRITE_SCOPE, VIEW_SCOPE } from './invalidation.js'
import {
  createKnobRegistry,
  resolveKnobValues,
  type KnobPrimitive,
  type KnobRegistry,
  type KnobValues,
} from './knob-registry.js'
import type { KnobPatch, KnobSetter } from './knob-patch.js'
import type { Invalidates, Knobs } from './knobs.js'
import { presetForImageId } from './preset.js'
import type { PoseRef } from './pose.js'
import { createRebuildQueue } from './rebuild-queue.js'
import type { AddError, PlayResult, ReadyError, SetResult, SwapResult } from './results.js'
import { createRun, settledRun, type Run, type RunOwner } from './run.js'
import {
  createRunController,
  type CrumpleTarget,
  type PlayOptions,
  type RunController,
  type RunHost,
  type StagePlayOptions,
} from './runner.js'
import { FRONT_LONG_SIDE_CAP, frontCapFor, sdfResFor, sizeForDisplay } from './resolution.js'
import {
  normalizeSource,
  type NormalizedSource,
  type PinFor,
  type SourceEnv,
  type SpriteSource,
} from './source.js'
import type { SheetFront } from './sheet.js'
import type { Sprite, SpriteRecord } from './sprite.js'
import {
  createOwnedSurface,
  hostInjected,
  type SurfaceEnv,
  type SurfaceHost,
} from './stage-surface.js'
import type {
  BlitTarget,
  DirectTarget,
  HostedTarget,
  StageOptions,
  Surface,
  ViewTarget,
} from './stage-types.js'
import { systemTimers, type Timers } from './stepper.js'
import { transition, type ViewState } from './view-state.js'
import type { SwapOptions, SwapToOptions, View } from './view.js'

/**
 * D4 — the widest slot type. `KnobPatch`, `ViewKnobPatch` and `SpriteKnobPatch` are parameterised
 * on the two slots' **descriptor tuples**, and nothing in the surface P2 shipped carries one, so
 * they are instantiated here at `readonly KnobDescriptor[]`. At that instantiation the patch
 * degrades to an index-signature bag and **P3's runtime registry is the enforcement**:
 * `registry.normalise()` returns a `KnobError` for an unknown, ambiguous or out-of-range key.
 * A later widening re-instantiates these three names and rewrites nothing.
 */
type AnySlot = readonly KnobDescriptor[]

/** D7 — §4.2's `mount` writes `fit?: Fit` and no section declares it. Derived, never restated. */
export type Fit = NonNullable<BlitTarget['fit']>

/** `stage.add`'s options bag. `PinFor<S>` is what makes `pin: true` required for a bare bitmap. */
export type AddOptions<S extends SpriteSource> = {
  key: string
  signal?: AbortSignal
  exact?: boolean
} & PinFor<S>

/** Everything not specific to a surface mode (amendment 8). */
export interface StageCommon {
  readonly changes: ChangeSource
  /** Terminal flag, already true during the final lifecycle notification. */
  readonly disposed: boolean
  /** Accepted overrides at this scope, keyed by the registry's namespaced paths. */
  readonly appliedKnobs: Readonly<Knobs>
  // --- degradation, capabilities and the two channels (§4.0, §4.6, amendment 14, amendment 16) ---
  /** Degradation is a value, not a rejection: a paper tile that failed to fetch leaves a usable
   *  stage that renders without grain. */
  readonly warnings: readonly Error[]
  /** Re-exported from `GlContext.caps`: a consumer choosing `maxSize` or `exact: true` needs
   *  `maxTextureSize` **before** the `add()` that would fail on it. */
  readonly caps: GlCaps
  /** `readonly KnobDescriptor[]` at runtime, so a JS consumer gets ranges, kinds and labels from
   *  the same descriptors that generate the types (§10.6). */
  readonly knobs: readonly KnobDescriptor[]
  /** Every descriptor's default under its own **namespaced** path — the same frozen object the
   *  registry builds once at mount, handed out by identity so a consumer can use it as an effect
   *  dependency (§3.4). `knobs` carries slot-local keys with no path, so a consumer holding a knob
   *  key had no way to ask what its default was; this is that answer. These are the registry's own
   *  paths, and they are not all the spelling `set()` takes: a **shared** knob — core's own
   *  (`core.paperColor`), or any slot descriptor that declares `binds` — is written back through
   *  the bare shared key (`paperColor`), which is what writes every bound descriptor at once.
   *  Every other path (`sheet.grain`) is written back exactly as it is keyed here. */
  readonly defaults: KnobValues
  /** The synchronous form of the `lost` event: a `useEffect` that runs after the event has
   *  already fired has no other way to ask (amendment 16). */
  readonly lost: boolean
  /** §4.5's list, in registration order — the same one `stage.play()` already snapshots. */
  readonly views: readonly View[]

  on<E extends EventName>(event: E, fn: (e: StageEvent<E>) => void): () => void
  once<E extends EventName>(event: E, fn: (e: StageEvent<E>) => void): () => void

  // --- sprites (§4.1, amendments 9, 10, 17) ---
  add<S extends SpriteSource>(src: S, o: AddOptions<S>): Promise<Sprite | AddError | Aborted>
  addAll<S extends SpriteSource>(
    entries: ReadonlyArray<{ src: S } & AddOptions<S>>,
    o?: { signal?: AbortSignal },
  ): Promise<Array<Sprite | AddError> | Aborted>
  /** A missing key is not a failure, so this is not an `Error` union under any reading and
   *  nothing about it should be narrowed (amendment 17). */
  get(key: string): Sprite | undefined
  replace<S extends SpriteSource>(
    key: string,
    src: S,
    o?: { signal?: AbortSignal; exact?: boolean },
  ): Promise<Sprite | AddError | Aborted>
  prepare(key: string, o?: { signal?: AbortSignal }): Promise<Sprite | AddError | Aborted>
  /** `detach: true` disposes the views the stage now knows about through `mount`; without it the
   *  behaviour, `SheetError` while attached included, is unchanged (amendment 17). */
  remove(key: string, o?: { detach?: true }): InstanceType<typeof SheetError> | undefined

  // --- composition (§4.2, amendment 11) ---
  mount(
    item: {
      key: string
      src: SpriteSource
      canvas: HTMLCanvasElement
      fit?: Fit
      tag?: string
      pin?: true
    },
    o?: { signal?: AbortSignal },
  ): Promise<View | AddError | InstanceType<typeof ViewError> | Aborted>

  // --- broadcast playback (§4.4) ---
  play(from: PoseRef, to: PoseRef, o?: StagePlayOptions): Promise<StagePlayReport<View>>
  /** Stops only stage-owned runs; `{ all: true }` stops everything, so a broadcast stop cannot
   *  silently kill a user-initiated garment swap. */
  stop(o?: { all?: boolean }): void

  // --- GL discipline, budget and knobs (§7.3, §8.8, §6.8) ---
  /** One save/restore around a batch of draws. Passes `fn`'s return value through; a nested
   *  `batch` is a no-op rather than a double save; **optional** — a bare `show()` outside a batch
   *  still saves and restores. Renamed from `stage.frame` because `frame` means a stored geometry
   *  frame everywhere else in the design (§7.3). */
  batch<T>(fn: () => T): T
  budget(o: { bytes?: number }): void
  usage(): FrontLruUsage & { readonly handles: number; readonly attached: number }
  pin(key: string): void
  unpin(key: string): void
  set: KnobSetter<KnobPatch<AnySlot, AnySlot>>

  /** Idempotent (§4.6). After it, every method returns a `GlError`; `show(null)` and `remove()`
   *  are no-ops, because React runs cleanups child-first. */
  dispose(): void
}

export interface BlitStage extends StageCommon {
  view(t: BlitTarget): View | InstanceType<typeof ViewError>
  resize(w: number, h: number): InstanceType<typeof GlError> | undefined
  readonly surface: Surface
}

export interface DirectStage extends StageCommon {
  view(t: DirectTarget): View | InstanceType<typeof ViewError>
  resize(w: number, h: number): InstanceType<typeof GlError> | undefined
  /** Not `HTMLCanvasElement | OffscreenCanvas`: a `direct` surface is by definition the element
   *  the consumer appends, so the `as HTMLCanvasElement` cast disappears from consumer code. */
  readonly surface: Omit<Surface, 'canvas'> & { readonly canvas: HTMLCanvasElement }
}

export interface HostedStage extends StageCommon {
  /**
   * D2. The static parameter is `HostedTarget` and nothing else. The **runtime** guard on a
   * `{ rect }` target — reachable from JavaScript, from a `ViewTarget`-typed variable and from a
   * cast — returns a `ViewError` naming `surface.presentable`, which is the result of grading the
   * *granted* attributes (§4.0.2) and is not statically knowable. `resize` is absent by design.
   */
  view(t: HostedTarget): View | InstanceType<typeof ViewError>
  readonly surface: Surface
}

/**
 * Everything the stage reaches for that a level-1 test must be able to replace. It is **not** part
 * of `StageOptions` and is not exported from the barrel: `StageOptions` is P2's and closed, and a
 * consumer-visible injection point for the DOM is not something §4 asks for.
 */
export interface StageEnv {
  readonly surface?: SurfaceEnv
  readonly makeContext?: (gl: WebGL2RenderingContext) => CoreGlContext
  readonly timers?: Timers
  /** Read once at mount, so a test does not need a `window`. */
  readonly dpr?: number
  readonly log?: (error: Error) => void
  readonly sourceEnv?: SourceEnv
  /** Subscribes to `webglcontextlost` on the stage's **own** surface, and returns an unsubscribe. */
  readonly onContextLost?: (fn: () => void) => () => void
}

type AnyStageOptions = StageOptions & {
  present?: 'blit' | 'direct'
  gl?: WebGL2RenderingContext
}

/**
 * The stage's own event payload map, per `emitter.ts`'s documented convention: the stage's bus
 * adds `view` to every payload, where a view's own bus does not.
 */
type StageEventPayloads = { [E in EventName]: StageEvent<E> }

function readDpr(env: StageEnv): number {
  if (env.dpr !== undefined) return env.dpr
  const dpr = attempt(() => globalThis.devicePixelRatio)
  return dpr instanceof Error || typeof dpr !== 'number' || !(dpr > 0) ? 1 : dpr
}

function defaultOnContextLost(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  fn: () => void,
): () => void {
  // The stage listens on its **own** surface, so the listener can neither outlive the stage nor
  // collide with one the consumer installed (§4.6).
  const target = canvas as unknown as {
    addEventListener?: (t: string, f: () => void) => void
    removeEventListener?: (t: string, f: () => void) => void
  }
  if (typeof target.addEventListener !== 'function') return () => {}
  target.addEventListener('webglcontextlost', fn)
  return () => target.removeEventListener?.('webglcontextlost', fn)
}

/**
 * `StageCommon` plus the two members every owned-surface mode adds — the actual shape
 * `buildStage` returns. `createStage` reports this rather than bare `StageCommon` because its
 * result is narrowed on `instanceof Error` / `isAborted`, never re-cast, and `stage.surface` /
 * `stage.resize` must survive that narrowing undiminished.
 */
type BuiltStage = StageCommon & {
  readonly surface: Surface
  resize(w: number, h: number): InstanceType<typeof GlError> | undefined
  /** The union of the three modes' `view()` — `createStage`'s return type is mode-agnostic, and
   *  the runtime narrows on which member of `ViewTarget` it was actually handed. */
  view(t: ViewTarget): View | InstanceType<typeof ViewError>
}

export async function createStage(
  o: AnyStageOptions,
  env: StageEnv = {},
): Promise<BuiltStage | ReadyError | Aborted> {
  // A helper rather than a repeated `o.signal?.aborted === true`: the signal can flip live,
  // between two checks, from code this function calls — a `readonly` property TypeScript has no
  // visible write to narrows as if it never changes, which a function call defeats.
  const signalAborted = (): boolean => o.signal?.aborted === true

  // Nothing is built for a signal that has already fired: the cheapest possible answer to
  // StrictMode's first, immediately-cancelled effect.
  if (signalAborted()) return ABORTED

  const bus = createEventBus<StageEventPayloads>()
  const policy = createErrorPolicy({ bus, log: env.log })
  // Wired first, and not after the surface exists: a listener attached after the factory resolves
  // cannot observe an error raised inside it, which is the whole reason `onError` is an option.
  if (o.onError !== undefined) bus.on('error', o.onError)

  const dpr = readDpr(env)
  // `Math.ceil(Math.max(0, o.artworkCssPx * dpr) || 0)` below silently reads a zero, negative or
  // non-finite `artworkCssPx` as `0` texels, so every `add()` afterwards would fail with a
  // `SheetError` naming `SourceOptions.artworkLongSide` — an internal channel the consumer never
  // set, for a mistake in an option they did set. Refuse it here instead, by its own name.
  if (o.artworkCssPx !== undefined && (!Number.isFinite(o.artworkCssPx) || o.artworkCssPx <= 0)) {
    return policy.returned(
      new GlError(
        `paperStage: artworkCssPx must be a finite, positive number, got ${o.artworkCssPx}`,
      ),
      null,
    )
  }
  // §7.4 / §8.6: the front cap, which is also the owned surface's side. `artworkCssPx` states the
  // ARTWORK's display footprint and the sheet's reserve says how much front that needs; `cssPx`
  // states the PAPER's, so the front is the footprint itself.
  const artworkLongSide =
    o.artworkCssPx !== undefined ? Math.ceil(Math.max(0, o.artworkCssPx * dpr) || 0) : undefined
  const maxSize =
    o.maxSize ??
    (artworkLongSide !== undefined
      ? frontCapFor({ artworkLongSide, overscan: o.sheet.overscan, cap: FRONT_LONG_SIDE_CAP })
      : sizeForDisplay({ cssPx: o.cssPx ?? 0, dpr, cap: FRONT_LONG_SIDE_CAP }))

  const host =
    o.gl !== undefined
      ? hostInjected(o.gl)
      : createOwnedSurface({
          present: o.present ?? 'blit',
          maxSize,
          env: env.surface,
        })
  if (host instanceof Error) return policy.returned(host, null)

  const teardown: Array<() => void> = [() => host.dispose()]
  const unwind = (): void => {
    while (teardown.length > 0) teardown.pop()?.()
  }
  const abortNow = (): Aborted => {
    unwind()
    return ABORTED
  }
  if (signalAborted()) return abortNow()

  const ctx = env.makeContext?.(host.gl) ?? createGlContext(host.gl, { owned: host.surface.owned })
  teardown.push(() => ctx.dispose())

  const sheetMounted = o.sheet.mount(ctx)
  if (sheetMounted !== undefined) {
    unwind()
    return policy.returned(sheetMounted, null)
  }
  teardown.push(() => o.sheet.dispose())

  const motionMounted = o.motion.mount(ctx)
  if (motionMounted !== undefined) {
    unwind()
    return policy.returned(motionMounted, null)
  }
  teardown.push(() => o.motion.dispose())
  if (signalAborted()) return abortNow()

  const registry = attempt(() =>
    createKnobRegistry({ sheet: o.sheet.knobs, motion: o.motion.knobs }),
  )
  if (registry instanceof Error) {
    unwind()
    return policy.returned(
      KnobError.is(registry) ? registry : new KnobError(registry.message),
      null,
    )
  }

  const timers = env.timers ?? systemTimers
  const artwork = { w: maxSize, h: maxSize }
  const pools = createScratchPools({
    gl: ctx,
    artwork,
    sdfRes: sdfResFor(maxSize),
    timers,
  })
  teardown.push(() => pools.dispose())

  // Created before the LRU so `release` below can read it: §8.8 makes the LRU the stage's, and
  // `budget` must be right before the first add().
  const sprites = new Map<string, SpriteRecord>()
  const semanticBatch = createChangeBatch()
  const changes = createChanges(semanticBatch)
  /** Keys whose `add()` is in flight. A live key is refused whether or not it has finished. */
  const reserved = new Set<string>()

  const lru = createFrontLru({
    bytes: o.budget ?? Number.POSITIVE_INFINITY,
    release: (key) => {
      const record = sprites.get(key)
      if (record?.front == null) return
      // Eviction drops a **front** and leaves the sprite rebuildable (§4.3). `remove()` is what
      // destroys the sprite, its hull entry and its key.
      o.sheet.releaseFront(record.front)
      record.front = null
      record.changes.emit('resources')
      changes.emit('resources')
    },
  })

  const warnings: Error[] = host.warnings.map((w) => new GlError(w))
  let lost = false
  let disposed = false

  const stage = buildStage({
    o,
    env,
    host,
    ctx,
    registry,
    pools,
    lru,
    sprites,
    reserved,
    bus,
    policy,
    timers,
    dpr,
    artworkLongSide,
    warnings,
    semanticBatch,
    changes,
    isLost: () => lost,
    isDisposed: () => disposed,
    markLost: () => {
      lost = true
    },
    markDisposed: () => {
      disposed = true
    },
    teardown,
  })

  const unsubscribe = (
    env.onContextLost ?? ((fn) => defaultOnContextLost(host.surface.canvas, fn))
  )(() => {
    if (lost || disposed) return
    semanticBatch.batch(() => {
      lost = true
      changes.emit('lifecycle')
      changes.emit('resources')
      // Its own channel (amendment 16): this is the single failure whose documented response is
      // "dispose and rebuild everything" rather than "log it", and recognising it by sifting
      // GlErrors out of the general error stream means matching on a message. §4.6's `error`
      // emission stays and the channel is additive to it.
      bus.emit('lost', { view: null } as never)
      policy.orphan(
        new GlError('the WebGL2 context was lost; dispose this stage and build a new one'),
        null,
      )
    })
  })
  teardown.push(unsubscribe)

  if (signalAborted()) {
    stage.dispose()
    return ABORTED
  }
  return stage
}

interface StageParts {
  semanticBatch: ReturnType<typeof createChangeBatch>
  changes: ChangePublisher
  o: AnyStageOptions
  env: StageEnv
  host: SurfaceHost
  ctx: CoreGlContext
  registry: KnobRegistry
  pools: ScratchPools
  lru: FrontLru
  sprites: Map<string, SpriteRecord>
  /** Keys whose `add()` is in flight. A live key is refused whether or not it has finished. */
  reserved: Set<string>
  bus: EventBus<StageEventPayloads>
  policy: ErrorPolicy
  timers: Timers
  dpr: number
  /** `SourceOptions.artworkLongSide` for every `source()` call this stage makes — `undefined`
   *  unless the stage was built with `artworkCssPx`. */
  artworkLongSide: number | undefined
  warnings: Error[]
  isLost: () => boolean
  isDisposed: () => boolean
  markLost: () => void
  markDisposed: () => void
  teardown: Array<() => void>
}

/** The stage-side face of a view. Never handed to a consumer; `View` is the public one. */
interface ViewInternals {
  readonly changes: ChangePublisher
  owner(): RunOwner | null
  playAs(owner: RunOwner, from: PoseRef, to: PoseRef, o?: PlayOptions): Run<PlayResult>
  stopAs(owner: RunOwner, all: boolean): void
  readonly spriteKey: string | null
}

const INTERNALS = new WeakMap<View, ViewInternals>()
function internals(v: View): ViewInternals {
  return (
    INTERNALS.get(v) ?? {
      changes: createChanges(),
      owner: () => null,
      playAs: () => settledRun(undefined),
      stopAs: () => {},
      spriteKey: null,
    }
  )
}

/** What `acquire` or `resupply` handed back, narrowed to the bitmap: the lane job's input (§8.10). */
type Obtained = Exclude<
  | Awaited<ReturnType<NormalizedSource['acquire']>>
  | Awaited<ReturnType<NonNullable<NormalizedSource['resupply']>>>,
  Error | Aborted
>

function buildStage(p: StageParts): BuiltStage {
  let batching = false
  const views: View[] = []
  let swapCounter = 0

  /**
   * §8.5's re-source path, in flight, keyed by sprite. The pool keeps ONE artwork slot and every
   * `source()` takes it, so a `build()` on any sprite but the last one sourced answers
   * `SourceExpiredError` — the "artwork slot was taken by another sprite" row of §8.5's table,
   * whose recovery is the supplier, `source()` again, then the rebuild. Only the stage can walk
   * it: a slot never sees the supplier. One entry per key, so a slider dragged while the decode
   * is out lands exactly one rebuild, at the knob values current when it lands.
   */
  const resourcing = new Map<string, Promise<Error | undefined>>()
  /**
   * §8.10 — the ingest lane. Every `source()` this stage makes runs inside one of its jobs, so at
   * most one sprite is between `source()` and `build()` at any time: `source()` suspends after it
   * has taken the artwork slot (its abort check points, §10.5), and two in flight would displace
   * each other and neither's `build()` would ever find its own artwork — a stage-level `set()`
   * over a grid would loop, and thirty `add()`s in one turn answered twenty-nine `SheetError`s.
   * A job's class is inferred here, never passed in by a consumer.
   */
  const lane = createIngestLane({ timers: p.timers })
  /**
   * The promise each `add()` returned, by key, so `holdTarget` can promote the add a `crumpleTo`
   * is parked on (§4.5's `hold` is the natural promotion signal, §8.10). The entry is deleted at
   * settle (`addAs`), so it lives exactly as long as the add is pending and a settled promise
   * promotes nothing; weak besides, so a promise a consumer dropped costs nothing.
   */
  const pendingAdds = new WeakMap<Promise<unknown>, string>()

  // The queue lives with the rebuild it drives: `rebuildKey` needs the views, for the redraw a
  // re-source ends in, and the views are this function's.
  const rebuildQueue = createRebuildQueue({ timers: p.timers, rebuild: rebuildKey })

  /** The queue's callback — no caller on the stack, so a failure is an orphan (§10.6). */
  function rebuildKey(key: string): void {
    const record = p.sprites.get(key)
    if (record === undefined) return
    const failed = rebuildFront(record)
    if (failed !== undefined) p.policy.orphan(failed, null)
  }

  /**
   * Rebuild one front from a resident handle. Synchronous when the artwork is in the slot — the
   * drag row of §8.5's table, ~1–2 ms and no source touched. When `build()` answers
   * `SourceExpiredError` — the artwork slot taken by another sprite (§8.5), or a hull-tier knob
   * moved off the value the handle's hull was traced at (§6.3) — the re-source row is scheduled
   * instead and `undefined` is returned: the view keeps drawing the front it has (§8.8) until the
   * new one lands, and nothing has failed yet — if the re-source does fail, `resourceFront`
   * reports that. Any other `BuildError` is the caller's to route; a §8.6 knob dragged past the
   * frozen reserve is one ("re-add required"), and no rebuild can re-add.
   */
  function rebuildFront(record: SpriteRecord): AddError | undefined {
    return p.semanticBatch.batch(() => rebuildFrontNow(record))
  }

  function frontChanged(record: SpriteRecord): void {
    record.changes.emit('resources')
    record.changes.emit('geometry')
    p.changes.emit('resources')
    for (const v of viewsShowing(record.key)) {
      const changes = internals(v).changes
      changes.emit('geometry')
      changes.emit('content')
    }
  }

  function rebuildFrontNow(record: SpriteRecord): AddError | undefined {
    // A re-source in flight for this key builds at the knob values current when it lands, so
    // there is nothing to do now: sixty set() calls inside one decode are one rebuild.
    if (resourcing.has(record.key)) return undefined
    // §6.6's ladder at build time: core defaults -> slot defaults -> stage -> sprite. No view
    // layer — a front is shared by every view showing the sprite, and a view owns draw class
    // only (amendment 20). The sprite's layer alone would drop every stage-level value.
    const front = p.o.sheet.build(
      record.handle,
      record.fit.frontSize,
      sheetKnobsFor(record) as never,
    )
    if (SourceExpiredError.is(front)) {
      void resourceFront(record)
      return undefined
    }
    if (front instanceof Error) return front
    if (record.front !== null) p.o.sheet.releaseFront(record.front)
    record.front = front
    p.lru.insert({ key: record.key, bytes: front.bytes, reclaimable: record.source.reclaimable })
    frontChanged(record)
    return undefined
  }

  /**
   * Schedule the re-source for one sprite, or join the one already in flight. The failure, if
   * any, is orphaned exactly once, by the run that produced it — the rebuild that started it had
   * no caller on the stack, and a `prepare()` that joins later reads `record.front` to decide
   * what it returns.
   */
  function resourceFront(record: SpriteRecord): Promise<Error | undefined> {
    const key = record.key
    const inFlight = resourcing.get(key)
    if (inFlight !== undefined) return inFlight
    // Serialised by the lane (§8.10), not by a promise chain: the supplier runs now, and the
    // `source()` that follows it waits its turn behind whatever the lane holds. Nothing in
    // `resource` rejects — every step returns its failure — but the supplier is a boundary a
    // consumer injects, and a promise stored in `resourcing` that could reject would strand the
    // key for the stage's life (`rebuildFront` deferring to it, `prepare` rejecting), so a
    // rejection is folded into the failure it should have been.
    const run: Promise<Error | undefined> = resource(record).then(
      (failed) => failed,
      (cause: unknown) =>
        new AssetError(
          `the re-source of '${key}' rejected instead of returning its failure (§10.8)`,
          { cause },
        ),
    )
    resourcing.set(key, run)
    void run.then((failed) => {
      if (resourcing.get(key) === run) resourcing.delete(key)
      if (failed !== undefined) p.policy.orphan(failed, null)
    })
    return run
  }

  /**
   * §8.5's re-source, for one sprite: the supplier — §8.5.1's re-supplier where one was derived,
   * the arm's own `acquire` otherwise, so a borrowed bitmap that is still open re-sources too —
   * then `source()`, then the rebuild. The record's fit and clip stay: the supplier returns the
   * image the key was registered with (§8.5.1), so the rect it yields is the rect they were
   * built over. Resolves to the failure rather than emitting it; `resourceFront` routes it.
   */
  async function resource(record: SpriteRecord): Promise<Error | undefined> {
    const key = record.key
    const live = (): boolean => p.sprites.get(key) === record && dead() === undefined
    if (!live()) return undefined
    // I/O first, outside the lane (§8.10): no slot is touched until `source()`.
    const got =
      record.source.resupply !== undefined
        ? await record.source.resupply({ key })
        : await record.source.acquire()
    // No signal is passed, so ABORTED cannot come back; narrowed because the type says it can.
    // A promotion `prepare()` left for the job is consumed by the enqueue below; on the paths
    // that never reach it, it is dropped rather than remembered for a job that never comes.
    if (isAborted(got) || got instanceof Error) {
      lane.forget(key)
      return isAborted(got) ? undefined : got
    }
    if (!live()) {
      lane.forget(key)
      if (got.owned) attempt(() => got.bitmap.close())
      return undefined
    }
    const ticket = lane.enqueue<Error | undefined>({
      key,
      // A sprite a view is showing goes ahead of background work; `prepare()` promotes the rest.
      cls: viewsShowing(key).size > 0 ? 'visible' : 'background',
      // §8.5.4 — dropped before it ran: the bitmap the stage obtained is closed here.
      discard: () => {
        if (got.owned) attempt(() => got.bitmap.close())
      },
      run: (slot) => resourceIngest(record, got, slot),
    })
    const settled = await ticket.done
    // The lane's signal is fired only by `dispose()`, and a disposed stage has nothing to report.
    return isAborted(settled) ? undefined : settled
  }

  /**
   * The lane job of a re-source (§8.10): `source()` at the sprite's current values, one
   * checkpoint, then the rebuild. The lane's signal goes into `source()` and is re-read after the
   * checkpoint, so a stage disposed mid-job hands the late handle straight back.
   */
  async function resourceIngest(
    record: SpriteRecord,
    got: Obtained,
    slot: IngestSlot,
  ): Promise<Error | undefined | Aborted> {
    const key = record.key
    const live = (): boolean => p.sprites.get(key) === record && dead() === undefined
    const handle = await p.o.sheet.source(got.bitmap, {
      maxSize: p.host.surface.width,
      artworkLongSide: p.artworkLongSide,
      exact: record.exact,
      signal: slot.signal,
      // §6.3 — the hull is traced at the sprite's current values, hull tier included. A knob that
      // moves again while this decode is out shows up as drift on the rebuild below, which
      // schedules the next re-source rather than losing the move.
      knobs: sheetKnobsFor(record),
    })
    // §8.5.4 — the stage closes every bitmap it obtained and never closes one it was given.
    if (got.owned) attempt(() => got.bitmap.close())
    if (isAborted(handle)) return ABORTED
    if (handle instanceof Error) return handle
    await slot.checkpoint()
    if (!live() || slot.signal.aborted) {
      // Removed, replaced or disposed while the decode was out: the handle that arrived late is
      // nobody's, so it goes straight back.
      p.o.sheet.release(handle)
      return undefined
    }
    // amendment 10 — a `200` on the conditional re-supply: the bytes moved under a key that
    // promised they would not. The fresh handle traced its own hull, so the new artwork cannot
    // inherit the old torn edge; the warning is what remains to be said.
    return p.semanticBatch.batch(() => {
      if ('freshness' in got && got.freshness === 'changed') warnReplaced(key)
      const previous = record.handle
      record.handle = handle
      // This run is over before the rebuild, so a build that finds the slot taken again — an
      // `add()` that landed inside the same window — schedules its own re-source instead of
      // being swallowed by this one's in-flight entry.
      resourcing.delete(key)
      const failed = rebuildFront(record)
      // The previous handle goes back only now, with the new one in hand and built from: a
      // released handle cannot be built from, and the view was drawing from this record the
      // whole time the decode was out.
      p.o.sheet.release(previous)
      if (failed !== undefined) return failed
      // Whatever the queue still held for this key just landed, at the current values.
      rebuildQueue.forget(key)
      // §8.8 — an idle view redraws now; a running one picks the new front up at its next step.
      // Snapshotted for the same reason `invalidateSpriteAt` snapshots: a re-show under a refresh
      // appends to the live set, and the loop would follow it round.
      for (const v of [...viewsShowing(key)]) if (v.state === 'idle') v.refresh()
      return undefined
    })
  }

  // §10.6's policy is P9's, applied to `stage.play`'s report: a mid-run draw failure reaches the
  // stage through `RunHost.reportError`, never through the run's settled value (P4 settles a run
  // to `undefined` on a dropped frame, on purpose — see `runner.test.ts`'s "still settles the run
  // to undefined" and "§10.6 policy is P9's" cases). This is additional bookkeeping on top of the
  // existing `p.policy.orphan` emission below — it never changes whether or how an error emits.
  /** One entry per view with a `stage.play` chain in flight. The record's identity is the
   * broadcast's token: a superseding broadcast replaces the entry, and the superseded chain's
   * cleanup deletes only if the entry is still its own, so one broadcast can never tear down
   * another's tracking. */
  const playBroadcasts = new Map<View, { error?: Error }>()

  // §6.2's ground truth: every value under its namespaced path. `stage.set` writes this layer,
  // which sits between the registry's defaults and every sprite's own layer (§6.6, §6.8).
  const stageLayer: Record<string, KnobPrimitive> = {}
  /**
   * # C1 — the knob-bag cache
   *
   * §6.6's ladder was re-walked **per draw per view**: four `Object.entries` merges into a fresh
   * ~55-key object plus a projection, for values that move only inside `set()`. The profile put it
   * at ~70 % of a scheduler tick over 64 views, at ~1 MB of garbage per tick.
   *
   * Each of the three writable layers now carries a version counter, bumped by every patch that
   * lands on it — the stage layer's here, a sprite layer's in its `KnobCache` entry, a view
   * layer's in the view's own closure. The resolved values and the two projections are cached
   * against the versions they were built at, so a draw whose layers have not moved pays three
   * integer compares. The bags handed to a slot are **frozen**: they are now shared between draws,
   * and a slot that wrote into one would corrupt every later draw rather than only its own.
   *
   * The values are identical to what the un-cached ladder produced — the cache changes when the
   * merge runs, never what it merges — and `stage-knobs.test.ts` pins that against a from-scratch
   * resolution after a patch at each of the three scopes.
   */
  let stageVersion = 0
  /** `defaults -> stage`, and its two projections: rebuilt only when the stage layer moves. */
  let baseValues: KnobValues = {}
  let baseVersion = -1
  let baseSheetBag: Knobs | null = null
  let baseMotionBag: Knobs | null = null

  function baseKnobs(): KnobValues {
    if (baseVersion !== stageVersion) {
      baseValues = resolveKnobValues([p.registry.defaults(), stageLayer])
      baseSheetBag = null
      baseMotionBag = null
      baseVersion = stageVersion
    }
    return baseValues
  }

  // The two projectors are asked for once, here, rather than per draw: `projector(slot)` memoises
  // the closure now, but naming it once also says that the slot list cannot change under a stage.
  const projectSheet = p.registry.projector('sheet')
  const projectMotion = p.registry.projector('motion')

  /**
   * The bags for a sprite and a view that both carry an EMPTY layer — a grid's ordinary state,
   * where §6.6's ladder ends at the stage and every sprite and view resolves to the same values.
   * One projection for the whole stage instead of one per view per draw.
   */
  function baseSheet(): Knobs {
    baseKnobs()
    if (baseSheetBag === null) baseSheetBag = Object.freeze(projectSheet(baseValues))
    return baseSheetBag
  }

  function baseMotion(): Knobs {
    baseKnobs()
    if (baseMotionBag === null) baseMotionBag = Object.freeze(projectMotion(baseValues))
    return baseMotionBag
  }

  /** One entry per sprite record: its layer's version, and what was resolved at that version. */
  interface KnobCache {
    /** Bumped by every patch `sprite.set` lands on `record.knobs`. */
    version: number
    /** Whether that layer is still empty, so the ladder up to the sprite IS the stage's. */
    empty: boolean
    /** The (stage, sprite) versions `values` was built at; `-1` while nothing is cached. */
    atStage: number
    atSprite: number
    /** `defaults -> stage -> sprite` — the build ladder, and the draw ladder's first three rungs. */
    values: KnobValues | null
    /** The sheet slot's frozen bag over `values`. */
    sheet: Knobs | null
  }
  const knobCaches = new WeakMap<SpriteRecord, KnobCache>()

  function cacheFor(record: SpriteRecord): KnobCache {
    const found = knobCaches.get(record)
    if (found !== undefined) return found
    const fresh: KnobCache = {
      version: 0,
      empty: true,
      atStage: -1,
      atSprite: -1,
      values: null,
      sheet: null,
    }
    knobCaches.set(record, fresh)
    return fresh
  }

  /** core defaults -> slot defaults -> stage -> sprite (§6.6), cached against the two versions. */
  function spriteValues(record: SpriteRecord): KnobValues {
    const cache = cacheFor(record)
    if (cache.empty) return baseKnobs()
    if (
      cache.values === null ||
      cache.atStage !== stageVersion ||
      cache.atSprite !== cache.version
    ) {
      cache.values = resolveKnobValues([baseKnobs(), record.knobs])
      cache.sheet = null
      cache.atStage = stageVersion
      cache.atSprite = cache.version
    }
    return cache.values
  }

  /**
   * The sheet slot's bag for `source()` and `build()`: no view layer, because a front is shared
   * by every view showing the sprite and a view owns draw class only (amendment 20).
   */
  function sheetKnobsFor(record: SpriteRecord): Knobs {
    const values = spriteValues(record)
    if (values === baseValues) return baseSheet()
    const cache = cacheFor(record)
    if (cache.sheet === null) cache.sheet = Object.freeze(projectSheet(values))
    return cache.sheet
  }

  /**
   * core defaults -> slot defaults -> stage -> sprite -> view (§6.6). The returned object is the
   * cached one and is never written to by a caller — `delta()` and the projectors only read it.
   */
  function knobsFor(record: SpriteRecord | null, viewLayer: KnobValues): KnobValues {
    const upToSprite = record === null ? baseKnobs() : spriteValues(record)
    // An empty view layer is the common case — only `view.set` ever fills one — and merging it
    // would copy the whole ladder for nothing.
    if (Object.keys(viewLayer).length === 0) return upToSprite
    return resolveKnobValues([upToSprite, viewLayer])
  }

  function applyPatch(
    patch: Readonly<Record<string, unknown>>,
    scope: readonly Invalidates[],
    layer: Record<string, KnobPrimitive>,
  ): SetResult {
    const normalised = p.registry.normalise(patch, scope)
    if (normalised instanceof Error) return p.policy.returned(normalised, null) as SetResult
    Object.assign(layer, normalised)
    return undefined
  }

  function delta(before: KnobValues, after: KnobValues): KnobValues {
    const out: Record<string, KnobPrimitive> = {}
    for (const [path, value] of Object.entries(after)) {
      if (before[path] !== value) out[path] = value
    }
    return out
  }

  /**
   * C1 — the views showing each sprite, by key. Every per-sprite fan-out used to scan **all** the
   * stage's views (`invalidateSprite` twice over, the re-source's redraw, `remove({ detach })`),
   * so a `stage.set` over a 64-tile grid walked 64 × 64 views for 64 redraws. Maintained wherever
   * a view's record changes — `show`, a swap's `adopt`, `dispose` — which is the only place it
   * can be maintained: nothing else moves a view between sprites.
   */
  const viewsBySprite = new Map<string, Set<View>>()
  const NO_VIEWS: ReadonlySet<View> = new Set()

  function viewsShowing(key: string): ReadonlySet<View> {
    return viewsBySprite.get(key) ?? NO_VIEWS
  }

  function indexShow(v: View, key: string): void {
    const shown = viewsBySprite.get(key)
    if (shown === undefined) viewsBySprite.set(key, new Set([v]))
    else shown.add(v)
  }

  function indexHide(v: View, key: string): void {
    const shown = viewsBySprite.get(key)
    if (shown === undefined) return
    shown.delete(v)
    if (shown.size === 0) viewsBySprite.delete(key)
  }

  function invalidateSprite(record: SpriteRecord, changed: KnobValues): void {
    const level = p.registry.invalidationOf(changed)
    if (level !== undefined) invalidateSpriteAt(record, level)
  }

  /** `invalidateSprite` with the level already computed — a stage-level patch has one level for
   *  every sprite it touches, and computing it per sprite was pure repetition. */
  function invalidateSpriteAt(record: SpriteRecord, level: Invalidates): void {
    // A snapshot, never the live set: a `show()` under one of these refreshes — a consumer's
    // `on('error')` or orphan handler (§10.6) re-showing the view onto the same sprite — moves
    // that view to the end of the set (`attachRecord`), and a live `Set` iterator visits entries
    // appended during iteration, so the fan-out would revisit it and never run out.
    // The snapshot also refreshes a view a handler hid or moved mid-fan-out; that is safe because
    // `paint` returns early when the view has no record, matching the walk in `remove`.
    const shown = [...viewsShowing(record.key)]
    if (!atOrAbove(level, 'front')) {
      // Draw class is sprite-scoped too: every view showing this sprite repaints.
      for (const v of shown) v.refresh()
      return
    }
    // §8.8 demand 3 — a front-class set() on a sprite with attachCount > 0. On a running view it
    // marks dirty and the rebuild lands at the top of the next step, at most one dwell later; on
    // an idle view the rebuild and a redraw happen synchronously inside set().
    rebuildQueue.mark(record.key)
    for (const v of shown) {
      if (v.state !== 'idle' && v.state !== 'disposed') return
    }
    rebuildQueue.drain({ demand: 'front-set', mandatory: record.key })
    for (const v of shown) v.refresh()
  }

  function invalidate(changed: KnobValues): void {
    const level = p.registry.invalidationOf(changed)
    if (level === undefined) return
    for (const record of p.sprites.values()) invalidateSpriteAt(record, level)
  }

  // §8.8 — the byte budget, tracked separately from `p.lru`'s internal one so the warning below
  // can compare against it without the LRU exposing its private `budget` number.
  let budgetedBytes = p.o.budget ?? Number.POSITIVE_INFINITY
  let unreclaimableWarned = false

  function checkUnreclaimable(): void {
    if (unreclaimableWarned) return
    const u = p.lru.usage()
    if (u.unreclaimable <= budgetedBytes) return
    unreclaimableWarned = true
    const count = [...p.sprites.values()].filter((r) => !r.source.reclaimable).length
    // The budget bounds the reclaimable set; it cannot bound a set the application has forbidden
    // the library to free, and saying so is more honest than silently overshooting.
    p.warnings.push(
      new AssetError(
        `unreclaimable front bytes (${String(u.unreclaimable)}) exceed the byte budget ` +
          `(${String(budgetedBytes)}): ${String(count)} sprite(s) were added with no source a ` +
          're-supplier could be derived from, so the LRU may not evict them',
      ),
    )
    p.changes.emit('lifecycle')
  }

  const dead = (): InstanceType<typeof GlError> | undefined =>
    p.isDisposed() || p.isLost()
      ? new GlError('this stage is disposed or its context was lost; build a new one')
      : undefined

  /** §4.1's "never a silent overwrite" applied to elements. */
  const claimed = new Set<HTMLCanvasElement>()

  /**
   * How a view's `DrawTarget` is derived for each draw, given the front it is about to draw. A
   * `{ framebuffer }` or `{ rect }` view's target is fixed for the view's life; a blit view's
   * follows the front, which is why this is a rule and not a value.
   */
  type TargetRule = (front: Size) => DrawTarget

  function resolveTarget(t: ViewTarget): TargetRule | InstanceType<typeof ViewError> {
    if ('framebuffer' in t) {
      const fixed: DrawTarget = {
        framebuffer: t.framebuffer,
        viewport: t.viewport,
        dest: t.rect ?? t.viewport,
      }
      return () => fixed
    }
    if ('rect' in t) {
      // D2 — the one target check that stays at runtime, because `presentable` is the result of
      // grading the **granted** attributes (§4.0.2) and is not statically knowable.
      if (!p.host.surface.presentable) {
        return new ViewError(
          'a { rect } view targets the default framebuffer, and this context was not granted the ' +
            'attributes that permit it (surface.presentable === false). Use a { framebuffer } view.',
        )
      }
      const box = { x: 0, y: 0, w: p.host.surface.width, h: p.host.surface.height }
      const fixed: DrawTarget = { framebuffer: null, viewport: box, dest: t.rect }
      return () => fixed
    }
    // A blit view draws at the surface's **origin**, one view at a time, and is copied out. Its
    // `dest` is the front's own box there — `(0, 0, w, h)` in GL coordinates, the very window
    // `blitPlan()` reads back as `(0, surface.h - h, w, h)` in the 2D canvas's top-left ones — so
    // "what is drawn" and "what is copied" name one rectangle. It is derived per draw rather than
    // fixed here because no front exists when `view()` runs, and `swapTo` / `crumpleTo` replace it
    // later with one of another aspect. The whole-surface `dest` this used to return broke that
    // invariant for every non-square front: motion scales the front into `dest` with one uniform
    // factor and centres it (`packages/motion/src/source.ts`), so the sheet landed in the middle of
    // the square surface while the blit copied the front-sized corner — a shifted, cropped slice.
    // `viewport` stays the whole surface, as it is for a `{ rect }` view: motion places the sheet
    // relative to `viewport`'s origin, so the box is what carries the geometry, and one shape of
    // target across both default-framebuffer views is one fewer thing to keep in step.
    return (front) => ({
      framebuffer: null,
      viewport: { x: 0, y: 0, w: p.host.surface.width, h: p.host.surface.height },
      dest: { x: 0, y: 0, w: front.w, h: front.h },
    })
  }

  /** `knobs` is the caller's cached motion bag — §6.6 resolved to the view, frozen and reused for
   *  as long as none of the three layers moves (`motionKnobsFor`). */
  function drawInto(
    record: SpriteRecord,
    targetFor: TargetRule,
    pose: number,
    knobs: Knobs,
  ): Error | undefined {
    const front = record.front
    if (front === null) return new GlError('the front is not resident; prepare() it first')
    const target = targetFor({ w: front.width, h: front.height })
    const frame = record.clip.keyFrames[pose] ?? 0
    return p.ctx.scope((s) => {
      s.bindTarget(target)
      const gl = p.ctx.gl
      // §4.0.2 — an injected context may carry a stencil buffer the stage never asked for.
      // P6's capture/restore already covers STENCIL_TEST and the stencil mask; disabling it for
      // the duration of the stage's draws is this plan's.
      attempt(() => gl.disable(gl.STENCIL_TEST))
      // §7.3 — never clear the default framebuffer. The replacement is a scissored clear over the
      // view's **own rect** — fixed for the view's life for a `{ rect }` or `{ framebuffer }`
      // view, the current front's box for a blit view (`resolveTarget`) — so there is no
      // union-of-rectangles problem and no fringe left by a smaller successor: what a blit view
      // leaves on the surface outside a later, smaller box is never copied out, because
      // `blitPlan().src` is exactly that box. `clear()` is absent from `DrawScope` entirely, so a
      // slot cannot clear at all.
      s.enable('SCISSOR_TEST', true)
      attempt(() => gl.scissor(target.dest.x, target.dest.y, target.dest.w, target.dest.h))
      attempt(() => gl.clearColor(0, 0, 0, 0))
      attempt(() => gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT))
      s.enable('SCISSOR_TEST', false)
      const drawn = p.o.motion.draw({
        clip: record.clip,
        fit: record.fit,
        frame,
        front,
        out: target,
        // §6.6's resolution order, applied at draw time: core defaults -> slot defaults -> stage
        // -> sprite -> view, the view winning at draw class.
        knobs: knobs as never,
      })
      return drawn instanceof Error ? drawn : undefined
    })
  }

  function blitOut(t: BlitTarget, record: SpriteRecord): Error | undefined {
    const front = record.front
    if (front === null) return undefined
    const dest2d = attempt(() => t.canvas.getContext('2d'))
    if (dest2d instanceof Error || dest2d === null) {
      return new ViewError('the destination canvas does not provide a 2D context')
    }
    if ((t.size ?? 'managed') === 'managed') {
      const rect = attempt(() => t.canvas.getBoundingClientRect())
      if (!(rect instanceof Error)) {
        const next = managedBackingStore({
          cssSize: { w: rect.width, h: rect.height },
          dpr: p.dpr,
          front: { w: front.width, h: front.height },
          current: { w: t.canvas.width, h: t.canvas.height },
        })
        if (next !== null) {
          t.canvas.width = next.w
          t.canvas.height = next.h
        }
      }
    }
    const plan = blitPlan({
      surface: { w: p.host.surface.width, h: p.host.surface.height },
      front: { w: front.width, h: front.height },
      dest: { w: t.canvas.width, h: t.canvas.height },
      fit: t.fit ?? 'stretch',
    })
    // The clear comes first, and it is a live bug fix: §4.3's scissored clear covers the GL
    // surface only, so without this a swapTo from a wide sprite to a narrow one leaves the
    // previous sprite's edges around the new one.
    for (const bar of plan.clear) {
      attempt(() => dest2d.clearRect(bar.x, bar.y, bar.w, bar.h))
    }
    if (plan.dest.w === 0 || plan.dest.h === 0) return undefined
    const copied = attempt(() =>
      dest2d.drawImage(
        p.host.surface.canvas as CanvasImageSource,
        plan.src.x,
        plan.src.y,
        plan.src.w,
        plan.src.h,
        plan.dest.x,
        plan.dest.y,
        plan.dest.w,
        plan.dest.h,
      ),
    )
    return copied instanceof Error ? new GlError('the blit failed', { cause: copied }) : undefined
  }

  function createViewObject(t: ViewTarget, targetFor: TargetRule): View {
    const changes = createChanges(p.semanticBatch)
    // §7.1 — a view's own listeners run first, in registration order; the stage re-emits
    // synchronously after the last returns, with `view` filled in. The bus's `relay` is the one
    // hook that runs after the last listener regardless of when that listener was registered; a
    // plain `bus.on` here would run *before* every handler the consumer attaches later. A view's
    // bus only ever carries `start`, `step` and `end` — `RunHost.emit` is typed to those three,
    // and an error takes §10.6's route through the policy straight onto the stage's bus — which
    // is why the other two names have no entry. One entry per name rather than one generic
    // widening, because `p.bus.emit(event, …)` with a generic `event` asks TypeScript to prove
    // the payload against every member at once; indexing a mapped record with the same key is
    // the shape it does correlate.
    const relayToStage: { [E in EventName]?: (e: Events[E]) => void } = {
      start: (e) => p.bus.emit('start', { ...e, view }),
      step: (e) => p.bus.emit('step', { ...e, view }),
      end: (e) => p.bus.emit('end', { ...e, view }),
    }
    const bus = createEventBus({ relay: (event, e) => relayToStage[event]?.(e) })
    let state: ViewState = 'idle'
    let pose = 0
    let record: SpriteRecord | null = null
    /** §6.6 — the view's own draw-class layer. Written by `view.set` alone. */
    let viewLayer: KnobValues = {}
    /** Bumped by every patch `view.set` lands on `viewLayer` — the third of C1's three versions. */
    let viewVersion = 0
    /** The motion bag this view last projected, and the three versions it was projected at. */
    let motionCache: {
      record: SpriteRecord
      stage: number
      sprite: number
      view: number
      bag: Knobs
    } | null = null

    /**
     * §6.6 projected for the motion slot, for THIS view: the whole ladder, the view winning at
     * draw class. Rebuilt only when one of the three layers has moved since the last draw.
     */
    function motionKnobsFor(r: SpriteRecord): Knobs {
      const cache = cacheFor(r)
      const hit = motionCache
      if (
        hit !== null &&
        hit.record === r &&
        hit.stage === stageVersion &&
        hit.sprite === cache.version &&
        hit.view === viewVersion
      ) {
        return hit.bag
      }
      const values = knobsFor(r, viewLayer)
      // Every view of a stage whose sprites and views carry no layer of their own projects the
      // same bag; `baseMotion()` is that bag, made once per `stage.set` rather than once per view.
      const bag = values === baseValues ? baseMotion() : Object.freeze(projectMotion(values))
      motionCache = {
        record: r,
        stage: stageVersion,
        sprite: cache.version,
        view: viewVersion,
        bag,
      }
      return bag
    }

    /**
     * The one place a view changes which sprite it shows — `show`, a swap's `adopt` and
     * `dispose` all go through it — so the attach accounting (§4.5) and C1's view index cannot
     * drift apart.
     */
    function attachRecord(next: SpriteRecord | null): void {
      if (record === next) return
      const previous = record
      if (record !== null) {
        record.attachCount -= 1
        p.lru.detach(record.key)
        indexHide(view, record.key)
      }
      record = next
      if (record !== null) {
        record.attachCount += 1
        p.lru.attach(record.key)
        indexShow(view, record.key)
      }
      previous?.changes.emit('resources')
      next?.changes.emit('resources')
      changes.emit('content')
      changes.emit('geometry')
    }

    const paint = (next: number): void => {
      if (record === null) return
      // §8.8 — until a rebuild lands the view draws the last front it drew successfully, at the
      // new pose: never a blank frame, never a skipped step.
      if (record.front === null || rebuildQueue.dirty(record.key)) {
        rebuildQueue.drain({ demand: 'show', mandatory: record.key })
      }
      pose = next
      const drawn = drawInto(record, targetFor, next, motionKnobsFor(record))
      if (drawn !== undefined) {
        // No caller on the stack for a step, and `refresh` / `draw` return `void` by design, so
        // every dropped frame is an orphan (§10.6).
        p.policy.orphan(drawn, view)
        return
      }
      if ('canvas' in t) {
        const copied = blitOut(t, record)
        if (copied !== undefined) p.policy.orphan(copied, view)
      }
    }

    /** The `RunHost.render` path: draws one pose and returns the failure instead of orphaning it,
     *  so the controller can report it through `reportError` at the right moment (§7.1). */
    function paintOnce(r: SpriteRecord, next: number): Error | undefined {
      // §8.8 demand 2 — the top of a step callback whose next render needs a dirty or
      // non-resident front. One mandatory item, whatever it costs, plus whatever fits in 4 ms.
      if (r.front === null || rebuildQueue.dirty(r.key)) {
        rebuildQueue.drain({ demand: 'step', mandatory: r.key })
      }
      const drawn = drawInto(r, targetFor, next, motionKnobsFor(r))
      if (drawn !== undefined) return drawn
      return 'canvas' in t ? blitOut(t, r) : undefined
    }

    // The controller is re-created whenever the schedule behind the view changes, because
    // `RunControllerConfig.poseCount` must equal the dwell table's length or 'ball' and the swap's
    // ball index name different poses. `MotionClip.keyFrames.length` is where the count lives
    // and `MotionClip.dwells` is the table — absent, the runner's own `DWELL_MS`.
    let controller: RunController<SpriteRecord> | null = null
    let poseCount = 1
    let poseDwells: readonly number[] | undefined = undefined

    const host: RunHost = {
      emit: (event, payload) => bus.emit(event, payload as never),
      // §10.6's policy is P9's: the runner hands over an error and this decides `observed`, adds
      // `view` and emits it. A returned ABORTED never reaches here — cancellation is not failure.
      reportError: (error) => {
        // Only a **stage-owned** run may write into the broadcast's record. A view-owned run
        // supersedes a live broadcast (`decideCollision('view', 'stage')` is `'supersede'`)
        // without creating a record of its own, and crediting the superseded broadcast with that
        // run's error would report the view as `failed` for something another run did, rather
        // than as `incomplete`. The orphan emission stays unconditional (§10.6).
        const entry = controller?.owner === 'stage' ? playBroadcasts.get(view) : undefined
        if (entry !== undefined) entry.error = error
        p.policy.orphan(error, view)
      },
      render: (next) => {
        pose = next
        return record === null ? undefined : paintOnce(record, next)
      },
      frameFor: (next) => record?.clip.keyFrames[next] ?? 0,
      setState: (next) => {
        if (state === next) return
        state = next
        changes.emit('state')
      },
      batch: p.semanticBatch.batch,
      timers: p.timers,
    }

    function controllerFor(): RunController<SpriteRecord> {
      const count = record?.clip.keyFrames.length ?? 1
      const dwells = record?.clip.dwells
      const stale = controller
      if (stale !== null && count === poseCount && dwells === poseDwells) return stale
      if (stale !== null) {
        // Ends any live run with `completed: false` — and announces `'disposed'`, which is the
        // *controller's* state and not the view's. The view outlives its controllers, so it is
        // `idle` once this returns; were the announcement left standing, a `play()` the new
        // controller then refuses (a `PoseError` on a stale `view.pose`, say) would never
        // overwrite it, and the view would refuse every later call as if it had been disposed.
        stale.dispose()
        // The `end` that dispose emitted is allowed to call `play()`. That call re-enters here,
        // installs a controller keyed to this same clip and starts its run on it; a second
        // controller would orphan that run, so the installed one is returned instead.
        const installed = controller
        if (installed !== null && installed !== stale) return installed
        // A handler on that `end` may instead have disposed the view itself, which takes it out of
        // `views`. A disposed controller refuses every call, which is what the view now owes.
        if (!views.includes(view)) return stale
        state = 'idle'
      }
      poseCount = count
      poseDwells = dwells
      controller = createRunController<SpriteRecord>(host, {
        poseCount: count,
        ...(dwells === undefined ? {} : { dwells }),
      })
      return controller
    }

    /** Turn a `Sprite | Promise<…>` into the runner's `CrumpleTarget<SpriteRecord>`. */
    function toCrumpleTarget(
      target: Sprite | Promise<Sprite | Error | Aborted>,
    ): CrumpleTarget<SpriteRecord> {
      if (!(target instanceof Promise)) {
        return (findRecord(target) ??
          new SheetError('that sprite is not registered on this stage')) as never
      }
      return target.then((settled) =>
        settled instanceof Error || isAborted(settled)
          ? (settled as never)
          : ((findRecord(settled) ??
              new SheetError('that sprite is not registered on this stage')) as never),
      )
    }

    /** Holds the pending target's front against eviction; returns the release. */
    function holdTarget(target: Sprite | Promise<Sprite | Error | Aborted>): () => void {
      let key: string | null = null
      let released = false
      const take = (s: Sprite): void => {
        // A target that settles **after** the release has fired must not take a hold: the
        // release is the only thing that could ever undo it, and it has already run.
        if (released) return
        key = s.key
        p.lru.hold(key)
      }
      if (!(target instanceof Promise)) take(target)
      else {
        // §8.10 — the add this run is parked on goes to the head of the lane. The §4.5 hold on
        // the LRU below is untouched; the lane reads the same signal from the ingest side.
        const pendingKey = pendingAdds.get(target)
        if (pendingKey !== undefined) lane.promote(pendingKey, 'held')
        void target.then((s) => {
          if (!(s instanceof Error) && !isAborted(s)) take(s)
        })
      }
      // Idempotent: it is called from `adopt` and from the run's completion, and the run always
      // completes.
      return () => {
        released = true
        if (key !== null) p.lru.releaseHold(key)
        key = null
      }
    }

    /** `crumpleTo` on an empty view: there is nothing to crumple, so it is a `show()`. */
    function adoptImmediately(target: Sprite | Promise<Sprite | Error | Aborted>): Run<SwapResult> {
      if (!(target instanceof Promise)) {
        view.show(target)
        return settledRun(undefined)
      }
      const handle = createRun<SwapResult>(() => {})
      void target.then((settled) => {
        if (settled instanceof Error || isAborted(settled)) handle.settle(settled as never)
        else {
          view.show(settled)
          handle.settle(undefined)
        }
      })
      return handle.run
    }

    function playMethod(from: PoseRef, to: PoseRef, o?: PlayOptions): Run<PlayResult> {
      if (p.isDisposed() || state === 'disposed') return settledRun(ABORTED)
      const run = controllerFor().play(from, to, { ...o, owner: 'view' })
      return run
    }

    function crumpleToMethod(
      target: Sprite | Promise<Sprite | Error | Aborted>,
      o?: SwapOptions,
    ): Run<SwapResult> {
      if (p.isDisposed() || state === 'disposed') return settledRun(ABORTED)
      // `crumpleTo()` on an empty view degenerates to `show()`: there is no previous content to
      // crumple.
      if (record === null) {
        const run = adoptImmediately(target)
        return run
      }
      // §4.5 — a sprite is attached if it is shown by a non-disposed view **or** is the pending
      // target of a live crumpleTo. Without the second half, a view parked at the ball for two
      // seconds could have its incoming sprite evicted before the swap. `hold` is the LRU's name
      // for exactly that.
      const held = holdTarget(target)
      const run = controllerFor().crumple(pose, toCrumpleTarget(target), {
        ...o,
        owner: 'view',
        // Called once, at the ball, **between the pose-5 render and the pose-4 render** — which
        // is where the sprite, fit and bucket are exchanged, and what makes a bucket change
        // across a swap invisible rather than merely well hidden.
        adopt: (next) => {
          attachRecord(next)
          held()
          if (next.front === null) {
            // §8.8 demand 5 — settlement while the view is rising or parked. The park is free
            // time and the ideal moment to build the incoming front.
            rebuildQueue.drain({ demand: 'target-settled', mandatory: next.key })
          }
          return undefined
        },
      })
      // `adopt` fires at the ball, and every path that ends the run before it — `view.stop()`, a
      // superseding run, `view.dispose()` — would otherwise leave the hold above in place
      // forever, and a held front is unevictable (§4.5). The release is idempotent, so the normal
      // path (adopt at the ball, then the run settles) still releases exactly once.
      void run.done.then(held)
      return run
    }

    /**
     * amendment 11 — `add` + `crumpleTo(pending)`. **Not `async`, and `start` is emitted
     * synchronously before it returns**, exactly as `crumpleTo` is: the composition must not be
     * the place where the iOS-audio guarantee is quietly lost.
     *
     * The key is derived from the source so a consumer swapping a URL in does not have to mint
     * one — but that derivation carries a monotonic counter, so the same picture folds
     * differently on every swap. A consumer who wants a stable key passes `o.key` (§5.3): the
     * `add()` below runs under it, and a key already resident is adopted above without an `add()`
     * at all.
     */
    function swapToMethod(src: SpriteSource, o?: SwapToOptions): Run<SwapResult> {
      if (p.isDisposed() || state === 'disposed') return settledRun(ABORTED)
      // §5.3 — a key that is already resident is a CACHE HIT, not a failure. `add()` refuses a
      // live key (the hull cache is keyed on (sprite key, sdfRes, hull knobs) and the bitmap is
      // not in that key), so without this the commonest sequence in the library — A -> B -> A —
      // fails on its third step. Adopting instead costs no fetch and no byte budget, and `src` is
      // never read. It must sit ABOVE the mint so a cache hit does not bump `swapCounter`, and
      // above the abort gate below, which exists only to abort an `add()` there is none of here.
      // `p.reserved` is deliberately not consulted: a key whose add is still in flight is still
      // refused, and joining that add is the consumer's job.
      const resident = o?.key !== undefined ? p.sprites.get(o.key) : undefined
      if (resident !== undefined) return view.crumpleTo(resident.sprite, o)
      // §5.3 — the caller's key when there is one, so the fold preset (`presetForImageId(key)` at
      // fit time) is stable per picture. The counter is only bumped on the minted path: a
      // caller-supplied key must not perturb the numbering of the swaps that do mint.
      const key = o?.key ?? `swap:${presetForImageId(String(src))}:${String(swapCounter++)}`
      // §8.10 — a superseded, stopped or disposed swap aborts the `add()` it started, so a
      // second `swapTo` on the same view does not pay for an ingest nobody will show. The gate
      // is the consumer's signal plus the run's own settlement; the superseded run still settles
      // `ABORTED` after the new `start` (§7.1 — the runner is untouched), and an aborted `add()`
      // frees its key (§10.5).
      const gate = new AbortController()
      const consumer = o?.signal
      const onAbort = (): void => {
        gate.abort(consumer?.reason)
      }
      consumer?.addEventListener('abort', onAbort, { once: true })
      if (consumer?.aborted === true) gate.abort(consumer.reason)
      // `add()` is started here and its promise is passed straight through — the loading
      // indicator form of §4.2, with no second mechanism.
      const pending = add(src, { key, signal: gate.signal } as never)
      const run = view.crumpleTo(pending as never, o)
      void run.done.then((settled) => {
        consumer?.removeEventListener('abort', onAbort)
        if (isAborted(settled)) gate.abort()
      })
      return run
    }

    function stopMethod(): void {
      if (p.isDisposed() || state === 'disposed') return
      controller?.stop({ owner: 'view' })
    }

    const view: View = {
      changes,
      get appliedKnobs() {
        return Object.freeze({ ...viewLayer })
      },
      get pose() {
        return pose
      },
      get state() {
        return state
      },
      get sprite() {
        return record?.sprite ?? null
      },
      get run() {
        return controller?.run ?? null
      },
      tag: t.tag,
      get idealSize() {
        return record?.fit.frontSize ?? { w: 0, h: 0 }
      },
      // Where the artwork lands in the box this view draws into. The placement rule is the motion
      // slot's (`packages/motion/src/source.ts`): the sheet window is centred on the PAPER's box
      // (`front.rect`) and the front is scaled into `dest` by one uniform factor — the same rule
      // `resolveTarget` already relies on to make a blit view's dest the front's own box. The
      // artwork sits at `front.artwork` in the front, so its distance from the paper's centre,
      // scaled by that factor, is its distance from the box's centre. Box pixels, top-left
      // origin, y down: the front is y-down and the sheet shader shows it unflipped, so a front
      // row offset is a screen row offset. `null` without a resident front — nothing is drawn
      // then, so there is nothing to frame.
      get frame() {
        const front = record?.front ?? null
        if (front === null) return null
        const { dest } = targetFor({ w: front.width, h: front.height })
        const k = Math.min(dest.w / front.width, dest.h / front.height)
        const paperCx = front.rect.x + front.rect.w / 2
        const paperCy = front.rect.y + front.rect.h / 2
        return {
          box: { w: dest.w, h: dest.h },
          artwork: {
            x: dest.w / 2 + (front.artwork.x - paperCx) * k,
            y: dest.h / 2 + (front.artwork.y - paperCy) * k,
            w: front.artwork.w * k,
            h: front.artwork.h * k,
          },
        }
      },

      show(sprite) {
        if (p.isDisposed()) return undefined // React runs cleanups child-first (§4.6)
        const decision = transition(state, 'show')
        if (!decision.legal) {
          return decision.refusal === 'SheetError'
            ? p.policy.returned(
                new SheetError('this view is disposed; every call is refused'),
                view,
              )
            : undefined
        }
        p.semanticBatch.batch(() => {
          if (decision.endsLiveRun) controller?.stop({ all: true })
          if (p.isDisposed() || state === 'disposed' || controller?.live === true) return
          attachRecord(sprite === null ? null : findRecord(sprite))
          state = 'idle'
          pose = 0
          paint(0)
        })
        return undefined
      },

      refresh() {
        if (p.isDisposed() || !transition(state, 'refresh').legal) return
        paint(pose)
      },

      draw(ref) {
        if (p.isDisposed() || !transition(state, 'draw').legal) return
        const resolved = resolvePose(ref, record?.clip.keyFrames.length ?? 1)
        if (resolved instanceof Error) {
          p.policy.orphan(resolved, view)
          return
        }
        paint(resolved)
      },

      play: playMethod,
      crumpleTo: crumpleToMethod,
      swapTo: swapToMethod,
      stop: stopMethod,
      set: ((patch: Readonly<Record<string, unknown>>) => {
        const gone = dead()
        if (gone !== undefined || state === 'disposed')
          return gone ?? new ViewError('this view is disposed')
        return p.semanticBatch.batch(() => {
          const layer: Record<string, KnobPrimitive> = { ...viewLayer }
          const failed = applyPatch(patch, VIEW_SCOPE, layer)
          if (failed !== undefined) return failed
          viewLayer = layer
          viewVersion += 1
          // Draw class: no rebuild, one redraw at the current pose.
          if (state === 'idle') view.refresh()
          changes.emit('settings')
          return undefined
        })
      }) as never,

      on: (event, fn) => bus.on(event, fn as never),
      once: (event, fn) => bus.once(event, fn as never),

      dispose() {
        if (state === 'disposed') return
        p.semanticBatch.batch(() => {
          // §4.6: ends a live run with `completed: false` before the sprite is detached and the
          // bus is cleared — or the `end` `dispose()` owes it would never reach a listener.
          controller?.dispose()
          state = 'disposed'
          attachRecord(null)
          // The last projection holds a `SpriteRecord` and its bag. A disposed view the consumer
          // still holds would otherwise keep both alive for as long as it does.
          motionCache = null
          if ('canvas' in t) claimed.delete(t.canvas)
          bus.clear()
          const at = views.indexOf(view)
          if (at >= 0) views.splice(at, 1)
          changes.emit('lifecycle')
          changes.emit('state')
          p.changes.emit('lifecycle')
          p.changes.emit('resources')
          p.semanticBatch.after(changes.clear)
        })
      },
    }

    INTERNALS.set(view, {
      changes,
      owner: () => controller?.owner ?? null,
      playAs: (owner, from, to, o) => controllerFor().play(from, to, { ...o, owner }),
      stopAs: (owner, all) => controller?.stop({ owner, all }),
      get spriteKey() {
        return record?.key ?? null
      },
    })
    return view
  }

  function findRecord(sprite: Sprite): SpriteRecord | null {
    return p.sprites.get(sprite.key) ?? null
  }

  async function buildSprite(
    key: string,
    source: NormalizedSource,
    opts: { signal?: AbortSignal; exact?: boolean },
    cls: IngestClass,
  ): Promise<SpriteRecord | AddError | Aborted> {
    // I/O first, outside the lane (§8.10): no slot is touched until `source()`.
    const acquired = await source.acquire({ signal: opts.signal })
    if (isAborted(acquired)) return ABORTED
    if (acquired instanceof Error) return acquired
    const ticket = lane.enqueue<SpriteRecord | AddError>({
      key,
      cls,
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
      // §8.5.4 — dropped before it ran: the bitmap the stage obtained is closed here; a borrowed
      // one stays the caller's.
      discard: () => {
        if (acquired.owned) attempt(() => acquired.bitmap.close())
      },
      run: (slot) => ingestSprite(key, source, acquired, opts, slot),
    })
    return ticket.done
  }

  /**
   * The lane job of an `add()` or `replace()` (§8.10): the sheet's `source()`, the motion fit and
   * load, the first `build()`, the record. One checkpoint after `source()` returns and one after
   * `load()` returns; the lane's signal goes into both calls and is re-read after each
   * checkpoint, so a job whose swap was superseded pays for nothing past the phase it is in.
   */
  async function ingestSprite(
    key: string,
    source: NormalizedSource,
    acquired: Obtained,
    opts: { signal?: AbortSignal; exact?: boolean },
    slot: IngestSlot,
  ): Promise<SpriteRecord | AddError | Aborted> {
    // §6.6 — core defaults -> slot defaults -> stage, and no sprite layer yet: the record's own
    // layer below starts EMPTY, the sprite's delta over the stage. Seeded with a copy of the
    // defaults instead, it shadowed every stage-level value for as long as the sprite lived —
    // `stage.set()` of any knob changed nothing a view of an existing sprite drew or built.
    const at = knobsFor(null, {})
    const sheetKnobs = Object.freeze(projectSheet(at))
    const handle = await p.o.sheet.source(acquired.bitmap, {
      maxSize: p.host.surface.width,
      artworkLongSide: p.artworkLongSide,
      exact: opts.exact === true,
      signal: slot.signal,
      // §6.3 — the hull is traced at the stage's current values, hull tier included, and the
      // first front is built at the SAME values below: the two must agree, or `build()` answers
      // `SourceExpiredError` and `add()` has no re-source row to fall back on.
      knobs: sheetKnobs,
    })
    // §8.5.4 — the stage closes every bitmap it obtained and never closes one it was given.
    if (acquired.owned) attempt(() => acquired.bitmap.close())
    if (isAborted(handle)) return ABORTED
    if (handle instanceof Error) return handle
    // §8.10 — the lane's checkpoint between the sheet's phases; a signal that fired during the
    // wait means the handle is nobody's.
    await slot.checkpoint()
    if (slot.signal.aborted) {
      p.o.sheet.release(handle)
      return ABORTED
    }

    // D5 — the key selects the fold preset, and "a grid must not fold in unison" depends on it.
    // `frontRect`, not `rect`: `fit` sizes the front over the box it is given, in that box's own
    // units (§5.3), and the front has to be in front texels — bounded by `maxSize`, the surface's
    // side (§8.6) — for the blit view's `(0, 0, w, h)` box to fit the surface at all. The
    // source-pixel `rect` sized a 640 px source's front at 853 px on a 512 px surface, which the
    // view then drew clipped to its bottom-left corner: a cropped sprite, off the canvas's centre.
    const fit = p.o.motion.fit(handle.frontRect, presetForImageId(key))
    if (fit instanceof Error) {
      p.o.sheet.release(handle)
      return fit
    }

    const clip = await p.o.motion.load(fit, { signal: slot.signal })
    if (isAborted(clip) || clip instanceof Error) {
      p.o.sheet.release(handle)
      return isAborted(clip) ? ABORTED : clip
    }
    await slot.checkpoint()
    if (slot.signal.aborted) {
      p.o.motion.release(clip)
      p.o.sheet.release(handle)
      return ABORTED
    }

    const front = p.o.sheet.build(handle, fit.frontSize, sheetKnobs as never)
    if (front instanceof Error) {
      p.o.motion.release(clip)
      p.o.sheet.release(handle)
      // `BuildError` carries `SourceExpiredError`, which `AddError` (P2's, closed here) does not:
      // `build()`'s scratch-pool expiry has no `add()`-facing equivalent, so it is folded into a
      // `SheetError` rather than widening `AddError` itself.
      return SourceExpiredError.is(front) ? new SheetError(front.message, { cause: front }) : front
    }
    // A set() that landed while the decode was out never saw this sprite — the record is not in
    // `p.sprites` until the caller registers it — so the front above is at the values `source()`
    // traced at, not at the stage's current ones. Marked dirty here (by key: the queue needs no
    // record), so the next demand on it (§8.8: show, step, prepare, a front-class set) rebuilds it
    // — a hull-tier move through the re-source row, anything else in place. Draw-class movement
    // rides along: one redundant rebuild in a window this narrow, against a second bookkeeping
    // path that would have to know the class.
    // `baseKnobs()` hands back the very object `at` holds while the stage layer has not moved, so
    // the common case is one reference compare and no merge at all.
    const now = knobsFor(null, {})
    if (now !== at && Object.keys(delta(at, now)).length > 0) rebuildQueue.mark(key)

    // Boxed rather than a bare `let`: `sprite`'s getters must close over `record`, which does not
    // exist until after `sprite` is built. `record` itself is assigned exactly once, so it stays
    // `const` and only the box's property is written.
    const box: { record?: SpriteRecord } = {}
    const changes = createChanges(p.semanticBatch)
    const sprite: Sprite = {
      changes,
      get resident() {
        return box.record?.front != null
      },
      get appliedKnobs() {
        return Object.freeze({ ...box.record?.knobs })
      },
      key,
      get frontSize() {
        return {
          w: box.record?.front?.width ?? fit.frontSize.w,
          h: box.record?.front?.height ?? fit.frontSize.h,
        }
      },
      get rect() {
        return box.record?.handle.rect ?? handle.rect
      },
      get pinned() {
        return box.record?.pinned ?? false
      },
      get attachCount() {
        return box.record?.attachCount ?? 0
      },
      set: ((patch: Readonly<Record<string, unknown>>) => {
        const gone = dead()
        if (gone !== undefined) return gone
        const current = box.record
        if (current === undefined) return undefined
        if (p.sprites.get(key) !== current) return new SheetError('this sprite was removed')
        return p.semanticBatch.batch(() => {
          const before = { ...current.knobs }
          const layer: Record<string, KnobPrimitive> = { ...current.knobs }
          const failed = applyPatch(patch, SPRITE_SCOPE, layer)
          if (failed !== undefined) return failed
          current.knobs = layer
          const cache = cacheFor(current)
          cache.version += 1
          cache.empty = Object.keys(layer).length === 0
          invalidateSprite(current, delta(before, layer))
          changes.emit('settings')
          return undefined
        })
      }) as never,
    }
    const record: SpriteRecord = {
      changes,
      key,
      sprite,
      source,
      handle,
      fit,
      clip,
      front,
      exact: opts.exact === true,
      pinned: false,
      attachCount: 0,
      knobs: {},
    }
    box.record = record
    return record
  }

  /**
   * §8.10 — `add()` is a background job of the lane; `mount()` adds at `visible`, and a
   * `crumpleTo` parked on the promise promotes it to `held` through `pendingAdds`. Not `async`:
   * the promise a consumer gets back must be the very one `holdTarget` looks up.
   */
  function add(
    src: SpriteSource,
    opts: { key: string; signal?: AbortSignal; exact?: boolean; pin?: true },
  ): Promise<Sprite | AddError | Aborted> {
    return addAs(src, opts, 'background')
  }

  function addAs(
    src: SpriteSource,
    opts: { key: string; signal?: AbortSignal; exact?: boolean; pin?: true },
    cls: IngestClass,
  ): Promise<Sprite | AddError | Aborted> {
    const done = addBody(src, opts, cls)
    pendingAdds.set(done, opts.key)
    // A promotion that landed before the job reached the lane, for a job that never will — the
    // source refused at `acquire` — must not be remembered for the next add under this key.
    // Registered before the consumer's own continuation, so it runs first.
    void done.then(() => {
      // §8.10 — the entry lives exactly as long as the add is pending. A `crumpleTo` handed a
      // settled promise has no job to promote, and the `lane.promote` it would make is
      // remembered for the NEXT job under this key — a fresh add after a `remove()`, a
      // re-source — which then jumps work queued before it, or sits in the lane's memory until
      // `dispose()`. The liveness check is the entry itself rather than `p.sprites.has(key)`: an
      // add that failed has no sprite and would still have promoted.
      pendingAdds.delete(done)
      lane.forget(opts.key)
    })
    return done
  }

  async function addBody(
    src: SpriteSource,
    opts: { key: string; signal?: AbortSignal; exact?: boolean; pin?: true },
    cls: IngestClass,
  ): Promise<Sprite | AddError | Aborted> {
    const gone = dead()
    if (gone !== undefined) return p.policy.returned(gone, null)
    if (opts.signal?.aborted === true) return ABORTED
    if (p.sprites.has(opts.key) || p.reserved.has(opts.key)) {
      return p.policy.returned(
        new SheetError(
          `add() was called with the live key '${opts.key}'. Re-pointing a key is refused rather ` +
            'than silently rebuilt: the hull cache is keyed on (sprite key, sdfRes, hull knobs) ' +
            'and the bitmap is not in that key, so the new sprite would inherit the old hull. ' +
            'Use replace() to re-point a key, or remove() first.',
        ),
        null,
      )
    }

    const source = normalizeSource(src, p.env.sourceEnv)
    if (source instanceof Error) return p.policy.returned(source, null)
    // `PinFor` closes the type-level hole for a source written at the call site; a source widened
    // to the whole union — read out of a data model — reaches this runtime check instead.
    if (!source.reclaimable && opts.pin !== true) {
      return p.policy.returned(
        new AssetError(
          `add('${opts.key}') was given a source no re-supplier can be derived from, so its front ` +
            'can never be evicted and the byte budget cannot bound it. Pass pin: true to sign for ' +
            'that, or pass a URL, a Blob or a supplier function instead.',
        ),
        null,
      )
    }

    p.reserved.add(opts.key)
    const built = await buildSprite(opts.key, source, opts, cls)
    p.reserved.delete(opts.key)
    // An aborted add() frees its key; a failed one frees it too.
    if (isAborted(built)) return ABORTED
    if (built instanceof Error) return p.policy.returned(built, null)
    if (p.isDisposed()) {
      p.o.sheet.releaseFront(built.front as SheetFront)
      p.o.sheet.release(built.handle)
      p.o.motion.release(built.clip)
      return ABORTED
    }

    return p.semanticBatch.batch(() => {
      p.sprites.set(opts.key, built)
      p.lru.insert({
        key: opts.key,
        bytes: built.front?.bytes ?? 0,
        reclaimable: source.reclaimable,
      })
      if (opts.pin === true) {
        built.pinned = true
        p.lru.pin(opts.key)
      }
      p.changes.emit('resources')
      return built.sprite
    })
  }

  async function addAll(
    entries: ReadonlyArray<{
      src: SpriteSource
      key: string
      signal?: AbortSignal
      exact?: boolean
      pin?: true
    }>,
    o?: { signal?: AbortSignal },
  ): Promise<Array<Sprite | AddError> | Aborted> {
    // amendment 2 — abort is **all-or-nothing at the call level**; no element union carries it.
    // Checked once, up front, and once more after the loop: a partially-built batch cannot say
    // who owns what, and this is the shape §10.5's "the return value is the complete account"
    // allows.
    if (o?.signal?.aborted === true) return ABORTED
    const out: Array<Sprite | AddError> = []
    for (const e of entries) {
      const one = await add(e.src, { ...e, signal: o?.signal ?? e.signal })
      if (isAborted(one)) return ABORTED
      out.push(one)
    }
    return out
  }

  /**
   * amendment 10 — P15's staleness check reports a `200` on a conditional re-supply, which means
   * the bytes moved under a key §8.5.1 promised would not move. `replace()` is what that turns
   * into, and the warning is what says so out loud.
   */
  function warnReplaced(key: string): void {
    p.warnings.push(
      new AssetError(
        `the source behind '${key}' changed under a key that promised it would not; the sprite ` +
          'was rebuilt and its hull entry invalidated',
      ),
    )
    p.changes.emit('lifecycle')
  }

  async function prepare(
    key: string,
    o?: { signal?: AbortSignal },
  ): Promise<Sprite | AddError | Aborted> {
    const gone = dead()
    if (gone !== undefined) return p.policy.returned(gone, null)
    if (o?.signal?.aborted === true) return ABORTED
    const record = p.sprites.get(key)
    if (record === undefined) {
      return p.policy.returned(
        new SheetError(`prepare('${key}') has no sprite under that key; add() it first`),
        null,
      )
    }
    // §8.8 demand 4 — `prepare(key)`. A resident front that a front-class `set()` marked dirty
    // is stale, so returning it early would make `prepare` the one demand that never rebuilds.
    // The prepared key is the mandatory item; the rest of the queue rides along in the budget.
    if (record.front !== null) {
      if (rebuildQueue.dirty(key)) rebuildQueue.drain({ demand: 'prepare', mandatory: key })
    } else {
      // The LRU dropped the front, not the sprite.
      const rebuilt = rebuildFront(record)
      if (rebuilt !== undefined) return p.policy.returned(rebuilt, null)
    }
    // §8.5.1 — `prepare` "invokes the supplier, re-runs source() and rebuilds": when the rebuild
    // above found the artwork slot taken, that is what is in flight now, and `prepare` is the
    // one demand that waits for it rather than returning a front it knows is stale or absent.
    const pending = resourcing.get(key)
    if (pending !== undefined) {
      // §8.10 — the one demand that waits goes ahead of background work in the lane.
      lane.promote(key, 'visible')
      const failed = await pending
      if (record.front === null) {
        const message = `prepare('${key}') could not restore the front; the re-source failed`
        return p.policy.returned(
          failed === undefined
            ? new SheetError(message)
            : new SheetError(message, { cause: failed }),
          null,
        )
      }
    }
    return record.sprite
  }

  /**
   * The re-point of a live key (§4.1). Drains the key's re-source, releases the source-derived
   * halves (D3), then rebuilds through the lane (§8.10). While the rebuild is out the key's
   * `resourcing` entry is the replace itself, so a demand on the half-released record joins it
   * instead of building from a released handle (§8.5/§8.8); and a `remove()` inside that window
   * wins — the halves the rebuild produced go back, and nothing lands under the removed key.
   */
  async function replace(
    key: string,
    src: SpriteSource,
    o?: { signal?: AbortSignal; exact?: boolean },
  ): Promise<Sprite | AddError | Aborted> {
    // A helper rather than a repeated `o?.signal?.aborted === true`, for `createStage`'s reason:
    // the drain below waits, the signal can flip live across that wait, and a `readonly` property
    // TypeScript has no visible write to narrows as if it never changes — a call defeats that.
    const signalAborted = (): boolean => o?.signal?.aborted === true
    const gone = dead()
    if (gone !== undefined) return p.policy.returned(gone, null)
    if (signalAborted()) return ABORTED
    const record = p.sprites.get(key)
    if (record === undefined) {
      return p.policy.returned(
        new SheetError(`replace('${key}') has no sprite under that key; add() it instead`),
        null,
      )
    }

    const source = normalizeSource(src, p.env.sourceEnv)
    if (source instanceof Error) return p.policy.returned(source, null)
    if (!source.reclaimable && !record.pinned) {
      return p.policy.returned(
        new AssetError(
          `replace('${key}') was given a source no re-supplier can be derived from; pin the ` +
            'sprite first or pass a URL, a Blob or a supplier function',
        ),
        null,
      )
    }

    // §8.5/§8.8 — drain the re-source of this key before touching anything. A re-source in
    // flight owns `record.handle`, and when it lands it installs its own handle and front on the
    // SAME record: its liveness test is the record's identity (`p.sprites.get(key) === record`)
    // and `replace` never changes that. Release and overwrite underneath it and the pair it
    // installed is left unreleased — the sheet's per-key live-handle count (`paperSheet.release`, the §8.5 row) never reaches zero, so the
    // sheet never busts the hull entry the release exists to bust, and a later `add(key, other)`
    // serves the stale polygon (D3). `paperSheet.release` is idempotent, so the double release
    // the interleave also produces is harmless; the leak is not.
    //
    // Waiting is what `prepare()` already does with this same promise (§8.5.1) — it is stored in
    // `resourcing` precisely because it never rejects — and it costs little here: the lane runs
    // one job at a time (§8.10), so `buildSprite` below would have queued behind that re-source
    // anyway. A loop rather than one await: the rebuild that ends a re-source can find the
    // artwork slot taken again and schedule the next one before the first settles.
    let inFlight = resourcing.get(key)
    while (inFlight !== undefined) {
      await inFlight
      const disposed = dead()
      if (disposed !== undefined) return p.policy.returned(disposed, null)
      // The signal is read only after each awaited re-source settles: an abort during the drain
      // answers ABORTED once the current re-source lands, not at once (the lane runs it to its end).
      if (signalAborted()) return ABORTED
      // Removed — or removed and re-added — while we waited: `remove()` has already handed this
      // record's halves back, so there is nothing left to replace and nothing of ours to release;
      // a re-added key is a different record the caller has not seen.
      if (p.sprites.get(key) !== record) {
        return p.policy.returned(
          new SheetError(
            `replace('${key}'): the sprite under that key was removed while its re-source drained; add() or replace() again`,
          ),
          null,
        )
      }
      inFlight = resourcing.get(key)
    }

    // D3 — the order is the contract. `release(handle)` is where the sheet slot busts the hull
    // entry through the entry point P8 exposes; a re-supplied key whose bytes changed must
    // rebuild the hull rather than serve the cached polygon, which is the whole reason §4.1
    // refuses add() on a live key.
    if (record.front !== null) p.o.sheet.releaseFront(record.front)
    record.front = null
    p.o.sheet.release(record.handle)
    p.o.motion.release(record.clip)

    // §8.5/§8.8/§8.10 — for as long as `buildSprite` runs, this key's entry in `resourcing` is
    // the replace itself. The window is wide — the supplier, the lane's queue, `source()`,
    // `load()`, `build()` — and the record inside it is half-released: the handle above is the
    // slot's again and the front is null. A `prepare(k)`, or a front-class `set()` on a sprite a
    // view shows, reaches `rebuildFront` there, and without the entry that is `build()` on the
    // released handle: either a front built from it that this function then overwrites without
    // a `releaseFront` (a leak), or `SourceExpiredError` and a `resourceFront` that re-sources
    // the OLD `record.source` — promoted to `visible` by `prepare`, ahead of a background
    // replace — so that, landing after the replace, `resourceIngest` releases the new halves
    // and installs the old image under a `replace()` that has already resolved. With the entry
    // `rebuildFront` returns early, `resourceFront` joins this promise and `prepare` waits on it
    // the way it waits on a re-source (§8.5.1) — the mechanism the drain above relies on, from
    // the other side. The promise never rejects (`buildSprite` returns its failures), which is
    // what an entry in `resourcing` requires, and it settles with the failure so a joined
    // `prepare` can name it.
    let settleReplace: (failed: Error | undefined) => void = () => {}
    const replacing = new Promise<Error | undefined>((resolve) => {
      settleReplace = resolve
    })
    resourcing.set(key, replacing)
    p.semanticBatch.batch(() => frontChanged(record))
    const built = await buildSprite(
      key,
      source,
      { signal: o?.signal, exact: record.exact },
      // §8.10 — a sprite a view is showing is rebuilt ahead of background work.
      viewsShowing(key).size > 0 ? 'visible' : 'background',
    )
    if (resourcing.get(key) === replacing) resourcing.delete(key)
    // `remove(k)` — or `remove(k)` and a fresh `add(k)` — inside the window: the record this
    // call drained and released is no longer the one under the key. `remove()` handed the
    // record's halves back already, so nothing of the record's is left to release here, and
    // nothing of the record's may be deleted either — the key may be another record's now.
    const alive = p.sprites.get(key) === record
    if (isAborted(built)) {
      // The D3 release above already handed this record's handle and clip back to the slots, so
      // the record cannot outlive an abort: a later `remove(key)` would release both a second
      // time, and `prepare(key)` would build a front from a released handle.
      if (alive) {
        p.sprites.delete(key)
        p.lru.remove(key)
        rebuildQueue.forget(key)
      }
      if (alive) p.semanticBatch.batch(() => frontChanged(record))
      settleReplace(undefined)
      return ABORTED
    }
    if (built instanceof Error) {
      if (alive) {
        p.sprites.delete(key)
        p.lru.remove(key)
      }
      if (alive) p.semanticBatch.batch(() => frontChanged(record))
      settleReplace(built)
      return p.policy.returned(built, null)
    }
    if (!alive) {
      // The halves the job built are nobody's: back to their slots, and the LRU never learns a
      // removed key.
      if (built.front !== null) p.o.sheet.releaseFront(built.front)
      p.o.sheet.release(built.handle)
      p.o.motion.release(built.clip)
      const removed = new SheetError(
        `replace('${key}'): the sprite under that key was removed while its replacement was built; add() or replace() again`,
      )
      settleReplace(removed)
      return p.policy.returned(removed, null)
    }

    // The key, the pins and the attachments survive, so a reference the application holds does
    // too. Only the source-derived halves are replaced.
    return p.semanticBatch.batch(() => {
      record.source = built.source
      record.handle = built.handle
      record.fit = built.fit
      record.clip = built.clip
      record.front = built.front
      p.lru.insert({ key, bytes: record.front?.bytes ?? 0, reclaimable: source.reclaimable })
      if (record.pinned) p.lru.pin(key)
      for (let i = 0; i < record.attachCount; i += 1) p.lru.attach(key)
      warnReplaced(key)
      frontChanged(record)
      settleReplace(undefined)
      return record.sprite
    })
  }

  function remove(key: string, o?: { detach?: true }): InstanceType<typeof SheetError> | undefined {
    return p.semanticBatch.batch(() => removeNow(key, o))
  }

  function removeNow(
    key: string,
    o?: { detach?: true },
  ): InstanceType<typeof SheetError> | undefined {
    if (p.isDisposed()) return undefined // React runs cleanups child-first (§4.6)
    const record = p.sprites.get(key)
    if (record === undefined) return undefined

    // amendment 17 — `detach: true` disposes the views the stage now knows about through
    // `mount`, so the caller no longer has to find them. It changes **who performs the
    // disposal** and never the rule that an attached sprite is not freed.
    if (o?.detach === true) {
      // Copied: `dispose()` takes the view out of the index this iterates.
      for (const v of [...viewsShowing(key)]) v.dispose()
    }
    if (record.attachCount > 0) {
      return p.policy.returned(
        new SheetError(
          `remove('${key}') was called while the sprite is attached to ` +
            `${String(record.attachCount)} view(s). Dispose them first, or pass { detach: true } ` +
            'and the stage will.',
        ),
        null,
      )
    }

    // Eviction drops a front and leaves the sprite rebuildable; `remove()` destroys the sprite,
    // its hull entry and its key (§4.3).
    if (record.front !== null) p.o.sheet.releaseFront(record.front)
    p.o.sheet.release(record.handle)
    p.o.motion.release(record.clip)
    p.sprites.delete(key)
    p.lru.remove(key)
    rebuildQueue.forget(key)
    record.front = null
    record.changes.emit('resources')
    p.changes.emit('resources')
    p.semanticBatch.after(record.changes.clear)
    return undefined
  }

  /**
   * amendment 11 — `add` + `view` + `show('flat')`. It adds no mechanism.
   *
   * **`mountAll` was designed and rejected, and the rejection is recorded because it is the
   * obvious next step.** Its return type cannot be made honest: `Array<View | AddError> |
   * Aborted` omits the `ViewError` that `mount` can produce, and a whole-batch `Aborted`
   * (amendment 2) cannot say who owns the sprites and views already built when the signal
   * fired — either answer contradicts §10.5's "stop spending, keep what is already paid for" or
   * contradicts "the return value is the complete account". The index-correlated array also
   * discards the keys, which the consumer immediately rebuilds into a `Map`. A `for` loop over
   * `mount` is four lines and leaves the abort policy where the caller can see it.
   */
  async function mountMethod(
    item: {
      key: string
      src: SpriteSource
      canvas: HTMLCanvasElement
      fit?: Fit
      tag?: string
      pin?: true
    },
    o?: { signal?: AbortSignal },
  ): Promise<View | AddError | InstanceType<typeof ViewError> | Aborted> {
    const gone = dead()
    if (gone !== undefined) return p.policy.returned(new ViewError(gone.message), null)
    if (o?.signal?.aborted === true) return ABORTED

    // §8.10 — a mounted sprite is about to be shown: `visible`, ahead of background adds.
    const sprite = await addAs(
      item.src,
      {
        key: item.key,
        signal: o?.signal,
        ...(item.pin === true ? { pin: true as const } : {}),
      } as never,
      'visible',
    )
    if (isAborted(sprite) || sprite instanceof Error) return sprite

    const created = stage.view({
      canvas: item.canvas,
      ...(item.fit === undefined ? {} : { fit: item.fit }),
      ...(item.tag === undefined ? {} : { tag: item.tag }),
    })
    if (created instanceof Error) {
      // A sprite nobody can reach is not "already paid for": remove it rather than leak a key
      // the consumer never learned about.
      remove(item.key)
      return p.policy.returned(created, null)
    }
    created.show(sprite)
    return created
  }

  async function stagePlayMethod(
    from: PoseRef,
    to: PoseRef,
    o?: StagePlayOptions,
  ): Promise<StagePlayReport<View>> {
    // §4.4 — it never returns an Error and never rejects. There is nothing to narrow, so the
    // error policy is not on this path at all; a per-view failure is a `failed` entry.
    if (p.isDisposed() || p.isLost()) {
      return { started: [], skipped: [], failed: [], completed: false }
    }
    // Snapshotted **synchronously**, in registration order, so the eligible set is fixed at the
    // call and the resolution condition is decidable.
    const candidates: Array<StagePlayCandidate<View>> = views.map((v) => {
      const inner = internals(v)
      return {
        view: v,
        tag: v.tag,
        hasSprite: v.sprite !== null,
        disposed: v.state === 'disposed',
        liveOwner: inner.owner(),
      }
    })
    const eligibility = planStagePlay(candidates)

    // §7.1 — the stage emits its own `start` synchronously before the first setTimeout, even
    // when `stagger > 0` delays the individual views'.
    p.bus.emit('start', {
      from: 0,
      to: 0,
      duration: o?.duration,
      view: null,
    } as never)

    const stagger = Math.max(0, o?.stagger ?? 0)
    const ordered = batchBySortKey(eligibility.start, (c) => {
      const key = internals(c.view).spriteKey
      return key === null ? '' : (p.sprites.get(key)?.fit.sortKey ?? '')
    })
    // `ordered` exists to order the *starts* (draw batching); `stagePlayReport` indexes its
    // outcomes against `eligibility.start`'s registration order, so each chain remembers its own
    // index into `eligibility.start` and the outcomes are written back to that index rather than
    // to its position in `ordered`.
    const startIndex = new Map(eligibility.start.map((c, i) => [c.view, i]))
    const chains = ordered.map(
      (c, i) =>
        new Promise<{ index: number; outcome: ChainOutcome }>((resolve) => {
          const index = startIndex.get(c.view) ?? i
          const begin = (): void => {
            if (o?.signal?.aborted === true) {
              return resolve({ index, outcome: { kind: 'cancelled' } })
            }
            const mine: { error?: Error } = {}
            playBroadcasts.set(c.view, mine)
            const run = internals(c.view).playAs('stage', from, to, o)
            void run.done.then((settled) => {
              if (playBroadcasts.get(c.view) === mine) playBroadcasts.delete(c.view)
              if (mine.error !== undefined) {
                resolve({ index, outcome: { kind: 'failed', error: mine.error } })
              } else if (isAborted(settled)) {
                resolve({ index, outcome: { kind: 'incomplete' } })
              } else if (settled instanceof Error) {
                resolve({ index, outcome: { kind: 'failed', error: settled } })
              } else {
                resolve({ index, outcome: { kind: 'completed' } })
              }
            })
          }
          if (i === 0 || stagger === 0) begin()
          else p.timers.setTimeoutFn(begin, i * stagger)
        }),
    )
    const settledChains = await Promise.all(chains)
    const outcomes: ChainOutcome[] = new Array(eligibility.start.length)
    for (const { index, outcome } of settledChains) outcomes[index] = outcome
    return stagePlayReport(eligibility, outcomes)
  }

  function stageStopMethod(o?: { all?: boolean }): void {
    // The same scope principle applied to cancellation, so that a broadcast stop cannot
    // silently kill a user-initiated garment swap.
    for (const v of views) internals(v).stopAs('stage', o?.all === true)
  }

  const stage = {
    changes: p.changes,
    get disposed() {
      return p.isDisposed()
    },
    get appliedKnobs() {
      return Object.freeze({ ...stageLayer })
    },
    warnings: p.warnings,
    caps: p.ctx.caps,
    knobs: p.registry.descriptors,
    defaults: p.registry.defaults(),
    get lost() {
      return p.isLost()
    },
    get views(): readonly View[] {
      return views
    },
    get surface() {
      return p.host.surface
    },
    resize: (w: number, h: number) => {
      const gone = dead()
      if (gone !== undefined) return gone
      const beforeW = p.host.surface.width
      const beforeH = p.host.surface.height
      const failed = p.host.resize(w, h)
      if (
        failed === undefined &&
        (beforeW !== p.host.surface.width || beforeH !== p.host.surface.height)
      ) {
        p.changes.emit('resources')
      }
      return failed
    },
    on: <E extends EventName>(event: E, fn: (e: StageEvent<E>) => void) => p.bus.on(event, fn),
    once: <E extends EventName>(event: E, fn: (e: StageEvent<E>) => void) => p.bus.once(event, fn),

    // §7.3. Passes `fn`'s return value through; a nested `batch` is a no-op rather than a double
    // save; **optional** — a bare `show()` outside a batch still saves and restores.
    batch<T>(fn: () => T): T {
      if (batching) return fn()
      batching = true
      // `fn` is the consumer's, so it may throw; the flag has to come back down either way or
      // every later `batch` takes the nested no-op path and draws outside any scope.
      try {
        return p.semanticBatch.batch(() => p.ctx.scope(() => fn()))
      } finally {
        batching = false
      }
    },

    budget: (o: { bytes?: number }) => {
      p.semanticBatch.batch(() => {
        if (o.bytes !== undefined) {
          budgetedBytes = o.bytes
          p.lru.setBudget(o.bytes)
          checkUnreclaimable()
        }
      })
    },
    usage: () => ({
      ...p.lru.usage(),
      // §8.8 — handle metadata and the hull cache are unbudgeted and never evicted; the pools are
      // whole-stage and do not scale with sprite count. `bytes` is fronts + handles + pools, and
      // the accounting closes exactly: `p.lru.usage().bytes` is the front tier alone, each
      // record's `SheetHandle.bytes` is the slot's own declared accounting (§5.2), and the two
      // scratch pools report their live bytes themselves.
      bytes:
        p.lru.usage().bytes +
        [...p.sprites.values()].reduce((sum, r) => sum + r.handle.bytes, 0) +
        p.pools.poolA.bytes() +
        p.pools.poolB.bytes(),
      handles: p.sprites.size,
      attached: [...p.sprites.values()].filter((r) => r.attachCount > 0).length,
    }),
    pin: (key: string) => {
      const record = p.sprites.get(key)
      if (record === undefined || record.pinned || p.isDisposed()) return
      p.semanticBatch.batch(() => {
        record.pinned = true
        p.lru.pin(key)
        record.changes.emit('resources')
        p.changes.emit('resources')
      })
    },
    unpin: (key: string) => {
      const record = p.sprites.get(key)
      if (record === undefined || !record.pinned || p.isDisposed()) return
      p.semanticBatch.batch(() => {
        record.pinned = false
        p.lru.unpin(key)
        record.changes.emit('resources')
        p.changes.emit('resources')
      })
    },

    add: add as never,
    addAll: addAll as never,
    get: (key: string) => p.sprites.get(key)?.sprite,
    replace: replace as never,
    prepare: prepare as never,
    remove: remove as never,
    view(t: ViewTarget) {
      const gone = dead()
      if (gone !== undefined) return p.policy.returned(new ViewError(gone.message), null)
      if ('canvas' in t) {
        if (claimed.has(t.canvas)) {
          return p.policy.returned(
            new ViewError(
              'that element already has a live view. Two views blitting into one canvas is a ' +
                'flicker with no error attached to it, so the second is refused. Dispose the ' +
                'first; React runs a cleanup before the second effect, so StrictMode does not ' +
                'trip this.',
            ),
            null,
          )
        }
        const probe = attempt(() => t.canvas.getContext('2d'))
        if (probe instanceof Error || probe === null) {
          return p.policy.returned(
            new ViewError(
              'that element does not provide a 2D context, which usually means it already ' +
                'carries a WebGL one. The stage never asks a consumer element for a WebGL context.',
            ),
            null,
          )
        }
        claimed.add(t.canvas)
      }
      const targetFor = resolveTarget(t)
      if (targetFor instanceof Error) return p.policy.returned(targetFor, null)
      const created = createViewObject(t, targetFor)
      views.push(created)
      p.changes.batch(() => {
        p.changes.emit('lifecycle')
        p.changes.emit('resources')
      })
      return created
    },
    play: stagePlayMethod,
    stop: stageStopMethod,
    mount: mountMethod as never,
    set: ((patch: Readonly<Record<string, unknown>>) => {
      const gone = dead()
      if (gone !== undefined) return gone
      return p.semanticBatch.batch(() => {
        const before = { ...stageLayer }
        const failed = applyPatch(patch, INVALIDATION_ORDER, stageLayer)
        if (failed !== undefined) return failed
        stageVersion += 1
        invalidate(delta(before, stageLayer))
        p.changes.emit('settings')
        return undefined
      })
    }) as never,

    dispose() {
      if (p.isDisposed()) return
      p.semanticBatch.batch(() => {
        p.markDisposed()
        // Views first — §4.6's teardown order — then the slots, then the context, then the surface.
        for (const v of [...views]) (v as unknown as { dispose(): void }).dispose()
        views.length = 0
        // §8.10 — queued ingests settle ABORTED and close what they own; the running one is told.
        lane.dispose()
        p.lru.clear()
        p.bus.clear()
        while (p.teardown.length > 0) p.teardown.pop()?.()
        for (const record of p.sprites.values()) {
          record.front = null
          record.changes.emit('resources')
          p.semanticBatch.after(record.changes.clear)
        }
        p.sprites.clear()
        p.changes.emit('lifecycle')
        p.changes.emit('resources')
        p.semanticBatch.after(p.changes.clear)
      })
    },
  }

  return stage as never
}

export function paperStage(
  o: StageOptions & { present: 'blit' },
): Promise<BlitStage | ReadyError | Aborted>
export function paperStage(
  o: StageOptions & { present: 'direct' },
): Promise<DirectStage | ReadyError | Aborted>
export function paperStage(
  o: StageOptions & { gl: WebGL2RenderingContext },
): Promise<HostedStage | ReadyError | Aborted>
export function paperStage(
  o: AnyStageOptions,
): Promise<BlitStage | DirectStage | HostedStage | ReadyError | Aborted> {
  return createStage(o) as Promise<BlitStage | DirectStage | HostedStage | ReadyError | Aborted>
}
