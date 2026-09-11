import { ABORTED, GlError, KnobError, SheetError, ViewError } from '@paper-crumple/core'
import {
  createChangeBatch,
  createChanges,
  type InternalChangePublisher,
} from '../../../core/src/changes.js'
import { createKnobRegistry } from '../../../core/src/knob-registry.js'
import { INVALIDATION_ORDER, SPRITE_SCOPE, VIEW_SCOPE } from '../../../core/src/invalidation.js'
import type {
  Aborted,
  AddError,
  AddOptions,
  BlitStage,
  BlitTarget,
  EventName,
  Events,
  KnobDescriptor,
  KnobValues,
  Invalidates,
  PlayOptions,
  PlayResult,
  PoseRef,
  Run,
  SetResult,
  Sprite,
  SpriteSource,
  StageEvent,
  StagePlayReport,
  SwapOptions,
  SwapResult,
  View,
  ViewFrame,
  ViewState,
} from '@paper-crumple/core'

/**
 * A fake `BlitStage` implementing the real interface, so the level-1 tests in this run exercise
 * the binding's own state machine rather than WebGL (spec §9).
 *
 * Nothing here throws: ESLint bans `ThrowStatement` repository-wide and this file is not on the
 * boundary allowlist. A method the binding never calls returns an Error of the right kind.
 */
export interface FakeCall {
  readonly method: string
  readonly args: readonly unknown[]
}

export interface FakeViewHandle {
  readonly view: View
  readonly calls: FakeCall[]
  readonly disposed: boolean
  readonly target: BlitTarget
  /** A view's bus carries `start`, `step` and `end` only — an `error` takes the stage's bus. */
  emit<E extends 'start' | 'step' | 'end'>(event: E, payload: Events[E]): void
  /**
   * Settles the run most recently returned by `play`, `swapTo` or `crumpleTo`.
   * This cannot select an older overlapping run; only the latest run is controllable.
   */
  settleRun(result: PlayResult | SwapResult): void
  setState(state: ViewState): void
  setFrame(frame: ViewFrame | null): void
}

export interface FakeStageHandle {
  readonly stage: BlitStage
  /** Every call the binding made, stage and views alike, in order. */
  readonly calls: FakeCall[]
  readonly views: readonly FakeViewHandle[]
  readonly sprites: Map<string, Sprite>
  readonly disposed: boolean
  emit<E extends EventName>(event: E, payload: StageEvent<E>): void
  /** Flip `lost`, then emit the pair core emits at `stage.ts:426-430`. */
  lose(): void
  pushWarning(warning: Error): void
  /** Make every subsequent `set` of `key` refuse with `error`. */
  refuseKnob(key: string, error: Error): void
  addSprite(key: string): Sprite
}

export interface FakeStageOptions {
  /** Sprite keys resident before the binding does anything. */
  readonly sprites?: readonly string[]
  readonly knobs?: readonly KnobDescriptor[]
  /** `stage.defaults` (§3.4): every descriptor's default under its **namespaced** path. The fake
   *  has no registry to derive these from `knobs`, which carries slot-local keys with no path, so
   *  a test that needs them states them. Frozen and handed out by identity, like core's. */
  readonly defaults?: KnobValues
  readonly prepare?: (key: string) => Promise<Sprite | AddError | Aborted>
  readonly add?: (
    src: SpriteSource,
    o: AddOptions<SpriteSource>,
  ) => Promise<Sprite | AddError | Aborted>
}

type Listeners = Map<string, Set<(e: never) => void>>

function emitTo(listeners: Listeners, event: string, payload: unknown): void {
  const set = listeners.get(event)
  if (set === undefined) return
  for (const fn of [...set]) (fn as (e: unknown) => void)(payload)
}

function subscribe(listeners: Listeners, event: string, fn: (e: never) => void): () => void {
  const set = listeners.get(event) ?? new Set()
  set.add(fn)
  listeners.set(event, set)
  return () => {
    set.delete(fn)
  }
}

const spriteState = new WeakMap<
  Sprite,
  {
    resident: boolean
    pinned: boolean
    attachCount: number
    disposed: boolean
    changes: InternalChangePublisher
  }
>()

type Normalise = (
  patch: Readonly<Record<string, unknown>>,
  scope: readonly Invalidates[],
) => KnobValues | Error

function fakeNormalise(descriptors?: readonly KnobDescriptor[]): Normalise {
  const registry = createKnobRegistry({ sheet: descriptors ?? [], motion: [] })
  return (patch, scope) => {
    if (descriptors !== undefined) return registry.normalise(patch, scope)
    // Older binding probes intentionally use arbitrary knob names. Give those synthetic sheet
    // knobs namespaced storage while real shared knobs still use the actual registry resolver.
    const known: Record<string, unknown> = {}
    const synthetic: Record<string, string | number | boolean> = {}
    for (const [key, value] of Object.entries(patch)) {
      if (!(registry.resolve(key) instanceof Error)) known[key] = value
      else if (
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean'
      ) {
        synthetic[key.includes('.') ? key : `sheet.${key}`] = value
      } else return new KnobError(`invalid fake knob value for ${key}`)
    }
    const accepted = registry.normalise(known, scope)
    return accepted instanceof Error ? accepted : { ...accepted, ...synthetic }
  }
}

export function makeFakeSprite(
  key: string,
  o?: { group?: ReturnType<typeof createChangeBatch>; normalise?: Normalise },
): Sprite {
  const changes = createChanges(o?.group)
  const normalise = o?.normalise ?? fakeNormalise()
  const state = { resident: true, pinned: false, attachCount: 0, disposed: false, changes }
  let applied: KnobValues = {}
  const sprite: Sprite = {
    changes,
    get resident() {
      return state.resident
    },
    get appliedKnobs() {
      return applied
    },
    key,
    frontSize: { w: 256, h: 256 },
    rect: { x: 0, y: 0, w: 256, h: 256 },
    get pinned() {
      return state.pinned
    },
    get attachCount() {
      return state.attachCount
    },
    set: ((patch: KnobValues) => {
      if (state.disposed) return new SheetError('this sprite was removed')
      const accepted = normalise(patch, SPRITE_SCOPE)
      if (accepted instanceof Error) return accepted as SetResult
      applied = Object.freeze({ ...applied, ...accepted })
      changes.emit('settings')
      return undefined
    }) as Sprite['set'],
  }
  spriteState.set(sprite, state)
  return sprite
}

const EMPTY_USAGE: ReturnType<BlitStage['usage']> = {
  bytes: 0,
  reclaimable: 0,
  unreclaimable: 0,
  fronts: 0,
  pinned: 0,
  attached: 0,
  handles: 0,
}

/**
 * Creates a non-throwing `BlitStage` test double with call logs and controllable views.
 *
 * Requires a DOM environment because the fake creates `stage.surface.canvas` with
 * `document.createElement('canvas')`. The fake does not model core's live `view.run` getter:
 * `view.run` is always `null`, and `FakeViewHandle.settleRun` controls only the latest run.
 */
export function createFakeStage(o?: FakeStageOptions): FakeStageHandle {
  const group = createChangeBatch()
  const changes = createChanges(group)
  const normalise = fakeNormalise(o?.knobs)
  const makeSprite = (key: string): Sprite => makeFakeSprite(key, { group, normalise })
  let applied: KnobValues = {}
  const calls: FakeCall[] = []
  const warnings: Error[] = []
  const defaults: KnobValues = Object.freeze({ ...o?.defaults })
  const sprites = new Map<string, Sprite>()
  const refusals = new Map<string, Error>()
  const viewHandles: FakeViewHandle[] = []
  const claimed = new Set<HTMLCanvasElement>()
  const stageListeners: Listeners = new Map()
  let lost = false
  let disposed = false

  const log = (method: string, ...args: unknown[]): void => {
    calls.push({ method, args })
  }

  for (const key of o?.sprites ?? []) sprites.set(key, makeSprite(key))

  function makeRun<R>(handle: { settle: (r: R) => void } & Record<string, unknown>): Run<R> {
    let settle: ((r: R) => void) | undefined
    const done = new Promise<R>((resolve) => {
      settle = resolve
    })
    handle.settle = (r: R): void => settle?.(r)
    return {
      done,
      then: (onFulfilled, onRejected) => done.then(onFulfilled, onRejected),
      stop(): void {
        settle?.(ABORTED as R)
      },
    }
  }

  function makeView(target: BlitTarget): FakeViewHandle {
    const viewChanges = createChanges(group)
    let applied: KnobValues = {}
    const viewCalls: FakeCall[] = []
    const viewListeners: Listeners = new Map()
    let sprite: Sprite | null = null
    let pose = 0
    let state: ViewState = 'idle'
    let frame: ViewFrame | null = null
    let viewDisposed = false
    let latest: { settle: (r: never) => void } | null = null

    const vlog = (method: string, ...args: unknown[]): void => {
      viewCalls.push({ method, args })
      log(method, ...args)
    }

    const start = <R>(): Run<R> => {
      const box = { settle: (): void => {} } as unknown as { settle: (r: R) => void } & Record<
        string,
        unknown
      >
      const run = makeRun<R>(box)
      latest = box as unknown as { settle: (r: never) => void }
      return run
    }

    const view: View = {
      changes: viewChanges,
      get appliedKnobs() {
        return applied
      },
      get pose(): number {
        return pose
      },
      get state(): ViewState {
        return state
      },
      get sprite(): Sprite | null {
        return sprite
      },
      get run(): Run<PlayResult | SwapResult> | null {
        return null
      },
      get tag(): string | undefined {
        return target.tag
      },
      get idealSize(): { readonly w: number; readonly h: number } {
        return { w: 256, h: 256 }
      },
      get frame(): ViewFrame | null {
        return frame
      },
      show(next: Sprite | null): InstanceType<typeof SheetError> | undefined {
        vlog('view.show', next)
        sprite = next
        viewChanges.emit('content')
        viewChanges.emit('geometry')
        return undefined
      },
      refresh(): void {
        vlog('view.refresh')
      },
      draw(next: PoseRef): void {
        vlog('view.draw', next)
        pose = typeof next === 'number' ? next : 0
      },
      play(from: PoseRef, to: PoseRef, opts?: PlayOptions): Run<PlayResult> {
        vlog('view.play', from, to, opts)
        return start<PlayResult>()
      },
      crumpleTo(
        targetSprite: Sprite | Promise<Sprite | Error | Aborted>,
        opts?: SwapOptions,
      ): Run<SwapResult> {
        vlog('view.crumpleTo', targetSprite, opts)
        return start<SwapResult>()
      },
      swapTo(src: SpriteSource, opts?: SwapOptions): Run<SwapResult> {
        vlog('view.swapTo', src, opts)
        return start<SwapResult>()
      },
      stop(): void {
        vlog('view.stop')
      },
      set: ((patch: Readonly<Record<string, unknown>>) => {
        vlog('view.set', patch)
        if (disposed || viewDisposed) return new GlError('this view is disposed')
        const accepted = normalise(patch, VIEW_SCOPE)
        if (accepted instanceof Error) return accepted as SetResult
        applied = Object.freeze({ ...applied, ...accepted })
        viewChanges.emit('settings')
        return undefined
      }) as View['set'],
      on: (<E extends EventName>(event: E, fn: (e: Events[E]) => void) =>
        subscribe(viewListeners, event, fn as (e: never) => void)) as View['on'],
      once: (<E extends EventName>(event: E, fn: (e: Events[E]) => void) => {
        const off = subscribe(viewListeners, event, ((e: Events[E]) => {
          off()
          fn(e)
        }) as (e: never) => void)
        return off
      }) as View['once'],
      dispose(): void {
        if (viewDisposed) return
        vlog('view.dispose')
        viewDisposed = true
        state = 'disposed'
        sprite = null
        claimed.delete(target.canvas)
        viewListeners.clear()
        viewChanges.batch(() => {
          viewChanges.emit('lifecycle')
          viewChanges.emit('state')
          viewChanges.emit('content')
          changes.emit('lifecycle')
          changes.emit('resources')
          viewChanges.clearAfterBatch()
        })
      },
    }

    return {
      view,
      calls: viewCalls,
      get disposed(): boolean {
        return viewDisposed
      },
      target,
      emit(event, payload): void {
        emitTo(viewListeners, event, payload)
      },
      settleRun(result): void {
        latest?.settle(result as never)
      },
      setState(next): void {
        if (state === next) return
        state = next
        viewChanges.emit('state')
      },
      setFrame(next): void {
        frame = next
        viewChanges.emit('geometry')
      },
    }
  }

  const stage: BlitStage = {
    changes,
    get disposed() {
      return disposed
    },
    get appliedKnobs() {
      return applied
    },
    get warnings(): readonly Error[] {
      return warnings
    },
    caps: { floatRT: true, maxTextureSize: 4096, timer: false },
    knobs: o?.knobs ?? [],
    defaults,
    get lost(): boolean {
      return lost
    },
    get views(): readonly View[] {
      return viewHandles.filter((h) => !h.disposed).map((h) => h.view)
    },
    on: (<E extends EventName>(event: E, fn: (e: StageEvent<E>) => void) =>
      subscribe(stageListeners, event, fn as (e: never) => void)) as BlitStage['on'],
    once: (<E extends EventName>(event: E, fn: (e: StageEvent<E>) => void) => {
      const off = subscribe(stageListeners, event, ((e: StageEvent<E>) => {
        off()
        fn(e)
      }) as (e: never) => void)
      return off
    }) as BlitStage['once'],
    async add(src, opts) {
      log('add', src, opts)
      if (o?.add !== undefined) return o.add(src as SpriteSource, opts as AddOptions<SpriteSource>)
      const sprite = makeSprite(opts.key)
      sprites.set(opts.key, sprite)
      changes.emit('resources')
      return sprite
    },
    async addAll(entries) {
      log('addAll', entries)
      return entries.map((entry) => {
        const sprite = makeSprite(entry.key)
        sprites.set(entry.key, sprite)
        changes.emit('resources')
        return sprite
      })
    },
    get(key) {
      log('get', key)
      return sprites.get(key)
    },
    async replace(key, src) {
      log('replace', key, src)
      const sprite = makeSprite(key)
      sprites.set(key, sprite)
      changes.emit('resources')
      return sprite
    },
    async prepare(key) {
      log('prepare', key)
      if (o?.prepare !== undefined) return o.prepare(key)
      const sprite = sprites.get(key)
      if (sprite === undefined) return new SheetError(`no record for sprite ${key}`)
      return sprite
    },
    remove(key) {
      log('remove', key)
      return group.batch(() => {
        const state = spriteState.get(sprites.get(key) as Sprite)
        if (!sprites.delete(key)) return new SheetError(`no record for sprite ${key}`)
        if (state !== undefined) {
          state.resident = false
          state.disposed = true
          state.changes.emit('resources')
          state.changes.clearAfterBatch()
        }
        changes.emit('resources')
        return undefined
      })
    },
    async mount(item) {
      log('mount', item)
      return new ViewError('the fake stage does not implement mount; the binding never calls it')
    },
    async play(from, to, opts): Promise<StagePlayReport<View>> {
      log('play', from, to, opts)
      if (disposed || lost) return { started: [], skipped: [], failed: [], completed: false }
      return {
        started: viewHandles.filter((h) => !h.disposed).map((h) => h.view),
        skipped: [],
        failed: [],
        completed: true,
      }
    },
    stop(opts): void {
      log('stop', opts)
    },
    batch(fn) {
      log('batch')
      return group.batch(fn)
    },
    budget(opts): void {
      log('budget', opts)
    },
    usage() {
      log('usage')
      return EMPTY_USAGE
    },
    pin(key): void {
      log('pin', key)
    },
    unpin(key): void {
      log('unpin', key)
    },
    set: ((patch: Readonly<Record<string, unknown>>) => {
      log('set', patch)
      if (disposed) return new GlError('this stage is disposed')
      for (const key of Object.keys(patch)) {
        const refusal = refusals.get(key)
        if (refusal !== undefined) return refusal as SetResult
      }
      const accepted = normalise(patch, INVALIDATION_ORDER)
      if (accepted instanceof Error) return accepted as SetResult
      applied = Object.freeze({ ...applied, ...accepted })
      changes.emit('settings')
      return undefined
    }) as BlitStage['set'],
    dispose(): void {
      if (disposed) return
      log('dispose')
      group.batch(() => {
        disposed = true
        for (const handle of viewHandles) handle.view.dispose()
        stageListeners.clear()
        for (const sprite of sprites.values()) {
          const state = spriteState.get(sprite)
          if (state !== undefined) {
            state.resident = false
            state.disposed = true
            state.changes.emit('resources')
            state.changes.clearAfterBatch()
          }
        }
        sprites.clear()
        changes.emit('lifecycle')
        changes.emit('resources')
        changes.clearAfterBatch()
      })
    },
    view(target: BlitTarget) {
      log('view', target)
      if (disposed) return new ViewError('this stage is disposed')
      if (lost) return new ViewError('the WebGL2 context was lost')
      if (claimed.has(target.canvas)) {
        return new ViewError(
          'this canvas is already claimed by another view. Dispose the first; React runs a ' +
            'cleanup before the second effect, so StrictMode does not trip this.',
        )
      }
      claimed.add(target.canvas)
      const handle = makeView(target)
      viewHandles.push(handle)
      changes.batch(() => {
        changes.emit('lifecycle')
        changes.emit('resources')
      })
      return handle.view
    },
    resize(w, h) {
      log('resize', w, h)
      return undefined
    },
    surface: {
      canvas: document.createElement('canvas'),
      owned: true,
      width: 256,
      height: 256,
      presentable: true,
    },
  }

  return {
    stage,
    calls,
    views: viewHandles,
    sprites,
    get disposed(): boolean {
      return disposed
    },
    emit(event, payload): void {
      emitTo(stageListeners, event, payload)
    },
    lose(): void {
      if (lost || disposed) return
      lost = true
      changes.emit('lifecycle')
      emitTo(stageListeners, 'lost', { view: null })
      emitTo(stageListeners, 'error', {
        error: new GlError('the WebGL2 context was lost; dispose this stage and build a new one'),
        observed: false,
        view: null,
      })
    },
    pushWarning(warning): void {
      warnings.push(warning)
      changes.emit('lifecycle')
    },
    refuseKnob(key, error): void {
      refusals.set(key, error)
    },
    addSprite(key): Sprite {
      const sprite = makeSprite(key)
      sprites.set(key, sprite)
      changes.emit('resources')
      return sprite
    },
  }
}
