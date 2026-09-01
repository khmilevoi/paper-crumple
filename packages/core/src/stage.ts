import { ABORTED, type Aborted } from './abort.js'
import { attempt } from './attempt.js'
import type { StagePlayReport } from './collisions.js'
import { createErrorPolicy, type ErrorPolicy } from './error-policy.js'
import { createEventBus, type EventBus } from './emitter.js'
import { GlError, KnobError, SheetError, ViewError } from './errors.js'
import type { KnobDescriptor } from './forward.js'
import { createFrontLru, type FrontLru, type FrontLruUsage } from './front-lru.js'
import { createGlContext, type CoreGlContext } from './gl-context.js'
import { createScratchPools, type ScratchPools } from './gl-pools.js'
import type { GlCaps } from './gl.js'
import type { EventName, StageEvent } from './events.js'
import { createKnobRegistry, type KnobRegistry } from './knob-registry.js'
import type { KnobPatch, KnobSetter } from './knob-patch.js'
import type { PoseRef } from './pose.js'
import type { AddError, ReadyError } from './results.js'
import type { StagePlayOptions } from './runner.js'
import { sdfResFor, sizeForDisplay } from './resolution.js'
import type { PinFor, SourceEnv, SpriteSource } from './source.js'
import type { Sprite } from './sprite.js'
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
} from './stage-types.js'
import { systemTimers, type Timers } from './stepper.js'
import type { View } from './view.js'

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
      registry instanceof KnobError ? registry : new KnobError(registry.message),
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

  // Task 10 replaces this release with the sheet-slot front release; the LRU is created here
  // because §8.8 makes it the stage's, and because `budget` must be right before the first add().
  const lru = createFrontLru({ bytes: o.budget ?? Number.POSITIVE_INFINITY, release: () => {} })

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

function buildStage(p: StageParts): BuiltStage {
  let batching = false
  const views: View[] = []

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
    pin: (key: string) => p.lru.pin(key), // Task 10 guards it
    unpin: (key: string) => p.lru.unpin(key),

    // Task 10
    add: () => Promise.resolve(new SheetError('not implemented')) as never,
    addAll: () => Promise.resolve([]) as never,
    get: () => undefined,
    // Task 11
    replace: () => Promise.resolve(new SheetError('not implemented')) as never,
    prepare: () => Promise.resolve(new SheetError('not implemented')) as never,
    remove: () => undefined,
    // Task 12
    view: () => new ViewError('not implemented') as never,
    // Task 14
    play: () =>
      Promise.resolve({ started: [], skipped: [], failed: [], completed: false }) as never,
    stop: () => {},
    // Task 15
    mount: () => Promise.resolve(new ViewError('not implemented')) as never,
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
