import { ABORTED, isAborted, type Aborted } from './abort.js'
import { attempt } from './attempt.js'
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
import { createGlContext, type CoreGlContext } from './gl-context.js'
import { createScratchPools, type ScratchPools } from './gl-pools.js'
import type { DrawTarget, GlCaps } from './gl.js'
import type { EventName, StageEvent } from './events.js'
import { createKnobRegistry, type KnobRegistry } from './knob-registry.js'
import type { KnobPatch, KnobSetter } from './knob-patch.js'
import { presetForImageId } from './preset.js'
import type { PoseRef } from './pose.js'
import { createRebuildQueue, type RebuildQueue } from './rebuild-queue.js'
import type { AddError, PlayResult, ReadyError, SwapResult } from './results.js'
import { createRun, settledRun, type Run, type RunOwner } from './run.js'
import {
  createRunController,
  type CrumpleTarget,
  type PlayOptions,
  type RunController,
  type RunHost,
  type StagePlayOptions,
} from './runner.js'
import { sdfResFor, sizeForDisplay } from './resolution.js'
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
import type { SwapOptions, View } from './view.js'

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
  budget(o: { bytes?: number; artworkSlots?: number }): void
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

/** §4.0's cap on `cssPx`, stated once. */
const CSS_PX_CAP = 512

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
  const maxSize = o.maxSize ?? sizeForDisplay({ cssPx: o.cssPx ?? 0, dpr, cap: CSS_PX_CAP })

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

  const ctx = env.makeContext?.(host.gl) ?? createGlContext(host.gl)
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
    },
  })

  const rebuildQueue = createRebuildQueue({
    timers,
    rebuild: (key) => {
      const record = sprites.get(key)
      if (record === undefined) return
      const front = o.sheet.build(
        record.handle,
        record.fit.frontSize,
        registry.projector('sheet')(record.knobs) as never,
      )
      if (front instanceof Error) {
        policy.orphan(front, null)
        return
      }
      if (record.front !== null) o.sheet.releaseFront(record.front)
      record.front = front
      lru.insert({ key, bytes: front.bytes, reclaimable: record.source.reclaimable })
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
    rebuildQueue,
    sprites,
    reserved,
    bus,
    policy,
    timers,
    dpr,
    warnings,
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
    if (lost) return
    lost = true
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
  teardown.push(unsubscribe)

  if (signalAborted()) {
    stage.dispose()
    return ABORTED
  }
  return stage
}

interface StageParts {
  o: AnyStageOptions
  env: StageEnv
  host: SurfaceHost
  ctx: CoreGlContext
  registry: KnobRegistry
  pools: ScratchPools
  lru: FrontLru
  rebuildQueue: RebuildQueue
  sprites: Map<string, SpriteRecord>
  /** Keys whose `add()` is in flight. A live key is refused whether or not it has finished. */
  reserved: Set<string>
  bus: EventBus<StageEventPayloads>
  policy: ErrorPolicy
  timers: Timers
  dpr: number
  warnings: Error[]
  isLost: () => boolean
  isDisposed: () => boolean
  markLost: () => void
  markDisposed: () => void
  teardown: Array<() => void>
}

/** The stage-side face of a view. Never handed to a consumer; `View` is the public one. */
interface ViewInternals {
  owner(): RunOwner | null
  playAs(owner: RunOwner, from: PoseRef, to: PoseRef, o?: PlayOptions): Run<PlayResult>
  stopAs(owner: RunOwner, all: boolean): void
  readonly spriteKey: string | null
}

const INTERNALS = new WeakMap<View, ViewInternals>()
function internals(v: View): ViewInternals {
  return (
    INTERNALS.get(v) ?? {
      owner: () => null,
      playAs: () => settledRun(undefined),
      stopAs: () => {},
      spriteKey: null,
    }
  )
}

function buildStage(p: StageParts): BuiltStage {
  let batching = false
  const views: View[] = []
  let swapCounter = 0

  // §10.6's policy is P9's, applied to `stage.play`'s report: a mid-run draw failure reaches the
  // stage through `RunHost.reportError`, never through the run's settled value (P4 settles a run
  // to `undefined` on a dropped frame, on purpose — see `runner.test.ts`'s "still settles the run
  // to undefined" and "§10.6 policy is P9's" cases). `playBroadcastViews` marks which views have a
  // `stage.play` chain in flight; `playBroadcastErrors` is what `reportError` writes into for one
  // of them, read back once that view's run settles. This is additional bookkeeping on top of the
  // existing `p.policy.orphan` emission below — it never changes whether or how an error emits.
  const playBroadcastViews = new Set<View>()
  const playBroadcastErrors = new Map<View, Error>()

  const dead = (): InstanceType<typeof GlError> | undefined =>
    p.isDisposed() || p.isLost()
      ? new GlError('this stage is disposed or its context was lost; build a new one')
      : undefined

  /** §4.1's "never a silent overwrite" applied to elements. */
  const claimed = new Set<HTMLCanvasElement>()

  function resolveTarget(t: ViewTarget): DrawTarget | InstanceType<typeof ViewError> {
    if ('framebuffer' in t) {
      return { framebuffer: t.framebuffer, viewport: t.viewport, dest: t.rect ?? t.viewport }
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
      return { framebuffer: null, viewport: box, dest: t.rect }
    }
    // A blit view draws at the surface's **origin**, one view at a time, and is copied out.
    const box = { x: 0, y: 0, w: p.host.surface.width, h: p.host.surface.height }
    return { framebuffer: null, viewport: box, dest: box }
  }

  function drawInto(record: SpriteRecord, target: DrawTarget, pose: number): Error | undefined {
    const front = record.front
    if (front === null) return new GlError('the front is not resident; prepare() it first')
    const frame = record.clip.keyFrames[pose] ?? 0
    return p.ctx.scope((s) => {
      s.bindTarget(target)
      const gl = p.ctx.gl
      // §4.0.2 — an injected context may carry a stencil buffer the stage never asked for.
      // P6's capture/restore already covers STENCIL_TEST and the stencil mask; disabling it for
      // the duration of the stage's draws is this plan's.
      attempt(() => gl.disable(gl.STENCIL_TEST))
      // §7.3 — never clear the default framebuffer. The replacement is a scissored clear over the
      // view's **own rect**, fixed for the view's life, so there is no union-of-rectangles problem
      // and no fringe left by a smaller successor. `clear()` is absent from `DrawScope` entirely,
      // so a slot cannot clear at all.
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
        knobs: p.registry.projector('motion')(record.knobs) as never,
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

  function createViewObject(t: ViewTarget, target: DrawTarget): View {
    const bus = createEventBus()
    let state: ViewState = 'idle'
    let pose = 0
    let record: SpriteRecord | null = null

    const paint = (next: number): void => {
      if (record === null) return
      // §8.8 — until a rebuild lands the view draws the last front it drew successfully, at the
      // new pose: never a blank frame, never a skipped step.
      if (record.front === null || p.rebuildQueue.dirty(record.key)) {
        p.rebuildQueue.drain({ demand: 'show', mandatory: record.key })
      }
      pose = next
      const drawn = drawInto(record, target, next)
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
      if (r.front === null || p.rebuildQueue.dirty(r.key)) {
        p.rebuildQueue.drain({ demand: 'step', mandatory: r.key })
      }
      const drawn = drawInto(r, target, next)
      if (drawn !== undefined) return drawn
      return 'canvas' in t ? blitOut(t, r) : undefined
    }

    // The controller is re-created whenever the pack behind the view changes, because
    // `RunControllerConfig.poseCount` must equal the schedule's length or 'ball' and the swap's
    // ball index name different poses. `MotionClip.keyFrames.length` is where that number lives.
    let controller: RunController<SpriteRecord> | null = null
    let poseCount = 1
    let currentRun: Run<PlayResult | SwapResult> | null = null

    const host: RunHost = {
      emit: (event, payload) => bus.emit(event, payload as never),
      // §10.6's policy is P9's: the runner hands over an error and this decides `observed`, adds
      // `view` and emits it. A returned ABORTED never reaches here — cancellation is not failure.
      reportError: (error) => {
        if (playBroadcastViews.has(view)) playBroadcastErrors.set(view, error)
        p.policy.orphan(error, view)
      },
      render: (next) => {
        pose = next
        return record === null ? undefined : paintOnce(record, next)
      },
      frameFor: (next) => record?.clip.keyFrames[next] ?? 0,
      setState: (next) => {
        state = next
      },
      timers: p.timers,
    }

    function controllerFor(): RunController<SpriteRecord> {
      const count = record?.clip.keyFrames.length ?? 1
      if (controller === null || count !== poseCount) {
        controller?.dispose()
        poseCount = count
        controller = createRunController<SpriteRecord>(host, { poseCount: count })
      }
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
      const take = (s: Sprite): void => {
        key = s.key
        p.lru.hold(key)
      }
      if (!(target instanceof Promise)) take(target)
      else {
        void target.then((s) => {
          if (!(s instanceof Error) && !isAborted(s)) take(s)
        })
      }
      return () => {
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
      currentRun = run
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
        currentRun = run
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
          if (record !== null) {
            record.attachCount -= 1
            p.lru.detach(record.key)
          }
          record = next
          record.attachCount += 1
          p.lru.attach(record.key)
          held()
          if (record.front === null) {
            // §8.8 demand 5 — settlement while the view is rising or parked. The park is free
            // time and the ideal moment to build the incoming front.
            p.rebuildQueue.drain({ demand: 'target-settled', mandatory: record.key })
          }
          return undefined
        },
      })
      currentRun = run
      return run
    }

    /**
     * amendment 11 — `add` + `crumpleTo(pending)`. **Not `async`, and `start` is emitted
     * synchronously before it returns**, exactly as `crumpleTo` is: the composition must not be
     * the place where the iOS-audio guarantee is quietly lost.
     *
     * The key is derived from the source so a consumer swapping a URL in does not have to mint
     * one; a consumer who wants a stable key calls `add()` and `crumpleTo()` themselves.
     */
    function swapToMethod(src: SpriteSource, o?: SwapOptions): Run<SwapResult> {
      if (p.isDisposed() || state === 'disposed') return settledRun(ABORTED)
      const key = `swap:${presetForImageId(String(src))}:${String(swapCounter++)}`
      // `add()` is started here and its promise is passed straight through — the loading
      // indicator form of §4.2, with no second mechanism.
      const pending = add(src, { key, signal: o?.signal } as never)
      return view.crumpleTo(pending as never, o)
    }

    function stopMethod(): void {
      if (p.isDisposed() || state === 'disposed') return
      controller?.stop({ owner: 'view' })
    }

    const view: View = {
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
        return controller?.live === true ? currentRun : null
      },
      tag: t.tag,
      get idealSize() {
        return record?.fit.frontSize ?? { w: 0, h: 0 }
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
        if (record !== null) {
          record.attachCount -= 1
          p.lru.detach(record.key)
        }
        record = sprite === null ? null : findRecord(sprite)
        if (record !== null) {
          record.attachCount += 1
          p.lru.attach(record.key)
        }
        state = 'idle'
        paint(0)
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
      set: (() => undefined) as never, // Task 16

      on: (event, fn) => bus.on(event, fn as never),
      once: (event, fn) => bus.once(event, fn as never),

      dispose() {
        if (state === 'disposed') return
        // §4.6: ends a live run with `completed: false` before the sprite is detached and the
        // bus is cleared — or the `end` `dispose()` owes it would never reach a listener.
        controller?.dispose()
        state = 'disposed'
        if (record !== null) {
          record.attachCount -= 1
          p.lru.detach(record.key)
          record = null
        }
        if ('canvas' in t) claimed.delete(t.canvas)
        bus.clear()
        const at = views.indexOf(view)
        if (at >= 0) views.splice(at, 1)
      },
    }

    // §7.1 — a view's own listeners run first, in registration order; the stage re-emits
    // synchronously after the last returns, with `view` filled in.
    bus.on('start', (e) => p.bus.emit('start', { ...e, view }))
    bus.on('step', (e) => p.bus.emit('step', { ...e, view }))
    bus.on('end', (e) => p.bus.emit('end', { ...e, view }))
    // `currentRun` is cleared once the run that produced it has actually ended, which is what
    // lets `view.run` report `null` at exactly the moment §4.5 says the view returns to `idle`.
    bus.on('end', () => {
      currentRun = null
    })

    INTERNALS.set(view, {
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
  ): Promise<SpriteRecord | AddError | Aborted> {
    const acquired = await source.acquire({ signal: opts.signal })
    if (isAborted(acquired)) return ABORTED
    if (acquired instanceof Error) return acquired

    const handle = await p.o.sheet.source(acquired.bitmap, {
      maxSize: p.host.surface.width,
      exact: opts.exact === true,
      signal: opts.signal,
    })
    // §8.5.4 — the stage closes every bitmap it obtained and never closes one it was given.
    if (acquired.owned) attempt(() => acquired.bitmap.close())
    if (isAborted(handle)) return ABORTED
    if (handle instanceof Error) return handle

    // D5 — the key selects the fold preset, and "a grid must not fold in unison" depends on it.
    const fit = p.o.motion.fit(handle.rect, presetForImageId(key))
    if (fit instanceof Error) {
      p.o.sheet.release(handle)
      return fit
    }

    const clip = await p.o.motion.load(fit, { signal: opts.signal })
    if (isAborted(clip) || clip instanceof Error) {
      p.o.sheet.release(handle)
      return isAborted(clip) ? ABORTED : clip
    }

    const knobs = p.registry.defaults()
    const front = p.o.sheet.build(
      handle,
      fit.frontSize,
      p.registry.projector('sheet')(knobs) as never,
    )
    if (front instanceof Error) {
      p.o.motion.release(clip)
      p.o.sheet.release(handle)
      // `BuildError` carries `SourceExpiredError`, which `AddError` (P2's, closed here) does not:
      // `build()`'s scratch-pool expiry has no `add()`-facing equivalent, so it is folded into a
      // `SheetError` rather than widening `AddError` itself.
      return SourceExpiredError.is(front) ? new SheetError(front.message, { cause: front }) : front
    }

    // Boxed rather than a bare `let`: `sprite`'s getters must close over `record`, which does not
    // exist until after `sprite` is built. `record` itself is assigned exactly once, so it stays
    // `const` and only the box's property is written.
    const box: { record?: SpriteRecord } = {}
    const sprite: Sprite = {
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
      set: (() => undefined) as never, // Task 16
    }
    const record: SpriteRecord = {
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
      knobs,
    }
    box.record = record
    return record
  }

  async function add(
    src: SpriteSource,
    opts: { key: string; signal?: AbortSignal; exact?: boolean; pin?: true },
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
    const built = await buildSprite(opts.key, source, opts)
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
    return built.sprite
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

  /** Rebuild one front from a resident handle. The LRU dropped the front, not the sprite. */
  function rebuildFront(record: SpriteRecord): AddError | undefined {
    const front = p.o.sheet.build(
      record.handle,
      record.fit.frontSize,
      p.registry.projector('sheet')(record.knobs) as never,
    )
    if (front instanceof Error) {
      // `BuildError` carries `SourceExpiredError`, which `AddError` does not — folded into a
      // `SheetError` exactly as `buildSprite` does above.
      return SourceExpiredError.is(front) ? new SheetError(front.message, { cause: front }) : front
    }
    record.front = front
    p.lru.insert({ key: record.key, bytes: front.bytes, reclaimable: record.source.reclaimable })
    return undefined
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
    if (record.front !== null) return record.sprite
    const rebuilt = rebuildFront(record)
    if (rebuilt !== undefined) return p.policy.returned(rebuilt, null)
    return record.sprite
  }

  async function replace(
    key: string,
    src: SpriteSource,
    o?: { signal?: AbortSignal; exact?: boolean },
  ): Promise<Sprite | AddError | Aborted> {
    const gone = dead()
    if (gone !== undefined) return p.policy.returned(gone, null)
    if (o?.signal?.aborted === true) return ABORTED
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

    // D3 — the order is the contract. `release(handle)` is where the sheet slot busts the hull
    // entry through the entry point P8 exposes; a re-supplied key whose bytes changed must
    // rebuild the hull rather than serve the cached polygon, which is the whole reason §4.1
    // refuses add() on a live key.
    if (record.front !== null) p.o.sheet.releaseFront(record.front)
    record.front = null
    p.o.sheet.release(record.handle)
    p.o.motion.release(record.clip)

    const built = await buildSprite(key, source, { signal: o?.signal, exact: record.exact })
    if (isAborted(built)) return ABORTED
    if (built instanceof Error) {
      p.sprites.delete(key)
      p.lru.remove(key)
      return p.policy.returned(built, null)
    }

    // The key, the pins and the attachments survive, so a reference the application holds does
    // too. Only the source-derived halves are replaced.
    record.source = built.source
    record.handle = built.handle
    record.fit = built.fit
    record.clip = built.clip
    record.front = built.front
    p.lru.insert({ key, bytes: record.front?.bytes ?? 0, reclaimable: source.reclaimable })
    if (record.pinned) p.lru.pin(key)
    for (let i = 0; i < record.attachCount; i += 1) p.lru.attach(key)
    warnReplaced(key)
    return record.sprite
  }

  function remove(key: string, o?: { detach?: true }): InstanceType<typeof SheetError> | undefined {
    if (p.isDisposed()) return undefined // React runs cleanups child-first (§4.6)
    const record = p.sprites.get(key)
    if (record === undefined) return undefined

    // amendment 17 — `detach: true` disposes the views the stage now knows about through
    // `mount`, so the caller no longer has to find them. It changes **who performs the
    // disposal** and never the rule that an attached sprite is not freed.
    if (o?.detach === true) {
      for (const v of [...views]) {
        if (internals(v).spriteKey === key) v.dispose()
      }
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
    p.rebuildQueue.forget(key)
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

    const sprite = await add(item.src, {
      key: item.key,
      signal: o?.signal,
      ...(item.pin === true ? { pin: true as const } : {}),
    } as never)
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
    const chains = ordered.map(
      (c, i) =>
        new Promise<ChainOutcome>((resolve) => {
          const begin = (): void => {
            if (o?.signal?.aborted === true) return resolve({ kind: 'cancelled' })
            playBroadcastViews.add(c.view)
            playBroadcastErrors.delete(c.view)
            const run = internals(c.view).playAs('stage', from, to, o)
            void run.done.then((settled) => {
              playBroadcastViews.delete(c.view)
              const reported = playBroadcastErrors.get(c.view)
              playBroadcastErrors.delete(c.view)
              if (reported !== undefined) resolve({ kind: 'failed', error: reported })
              else if (isAborted(settled)) resolve({ kind: 'incomplete' })
              else if (settled instanceof Error) resolve({ kind: 'failed', error: settled })
              else resolve({ kind: 'completed' })
            })
          }
          if (i === 0 || stagger === 0) begin()
          else p.timers.setTimeoutFn(begin, i * stagger)
        }),
    )
    return stagePlayReport(eligibility, await Promise.all(chains))
  }

  function stageStopMethod(o?: { all?: boolean }): void {
    // The same scope principle applied to cancellation, so that a broadcast stop cannot
    // silently kill a user-initiated garment swap.
    for (const v of views) internals(v).stopAs('stage', o?.all === true)
  }

  const stage = {
    warnings: p.warnings,
    caps: p.ctx.caps,
    knobs: p.registry.descriptors,
    get lost() {
      return p.isLost()
    },
    get views(): readonly View[] {
      return views
    },
    get surface() {
      return p.host.surface
    },
    resize: (w: number, h: number) => p.host.resize(w, h),
    on: <E extends EventName>(event: E, fn: (e: StageEvent<E>) => void) => p.bus.on(event, fn),
    once: <E extends EventName>(event: E, fn: (e: StageEvent<E>) => void) => p.bus.once(event, fn),

    // §7.3. Passes `fn`'s return value through; a nested `batch` is a no-op rather than a double
    // save; **optional** — a bare `show()` outside a batch still saves and restores.
    batch<T>(fn: () => T): T {
      if (batching) return fn()
      batching = true
      const out = p.ctx.scope(() => fn())
      batching = false
      return out
    },

    budget: (o: { bytes?: number; artworkSlots?: number }) => {
      if (o.bytes !== undefined) p.lru.setBudget(o.bytes)
    },
    usage: () => ({ ...p.lru.usage(), handles: 0, attached: 0 }), // Task 16 fills handles/attached
    pin: (key: string) => {
      const record = p.sprites.get(key)
      if (record === undefined) return
      record.pinned = true
      p.lru.pin(key)
    },
    unpin: (key: string) => {
      const record = p.sprites.get(key)
      if (record === undefined) return
      record.pinned = false
      p.lru.unpin(key)
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
      const target = resolveTarget(t)
      if (target instanceof Error) return p.policy.returned(target, null)
      const created = createViewObject(t, target)
      views.push(created)
      return created
    },
    play: stagePlayMethod,
    stop: stageStopMethod,
    mount: mountMethod as never,
    // Task 16
    set: (() => undefined) as never,

    dispose() {
      if (p.isDisposed()) return
      p.markDisposed()
      // Views first — §4.6's teardown order — then the slots, then the context, then the surface.
      for (const v of [...views]) (v as unknown as { dispose(): void }).dispose()
      views.length = 0
      p.lru.clear()
      p.bus.clear()
      while (p.teardown.length > 0) p.teardown.pop()?.()
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
