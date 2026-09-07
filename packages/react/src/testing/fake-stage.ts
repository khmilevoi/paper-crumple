import { ABORTED, GlError, SheetError, ViewError } from '@paper-crumple/core'
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
  /** Settle the run most recently returned by `play`, `swapTo` or `crumpleTo`. */
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

function makeSprite(key: string): Sprite {
  return {
    key,
    frontSize: { w: 256, h: 256 },
    rect: { x: 0, y: 0, w: 256, h: 256 },
    pinned: false,
    attachCount: 0,
    set: ((): SetResult => undefined) as Sprite['set'],
  }
}

/** `usage()` is never called by the binding; the shape is not worth a hand-built literal. */
const EMPTY_USAGE = {} as unknown as ReturnType<BlitStage['usage']>

export function createFakeStage(o?: FakeStageOptions): FakeStageHandle {
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
      set: ((patch: Readonly<Record<string, unknown>>): SetResult => {
        vlog('view.set', patch)
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
        claimed.delete(target.canvas)
        viewListeners.clear()
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
        state = next
      },
      setFrame(next): void {
        frame = next
      },
    }
  }

  const stage: BlitStage = {
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
      return sprite
    },
    async addAll(entries) {
      log('addAll', entries)
      return entries.map((entry) => {
        const sprite = makeSprite(entry.key)
        sprites.set(entry.key, sprite)
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
      if (!sprites.delete(key)) return new SheetError(`no record for sprite ${key}`)
      return undefined
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
      return fn()
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
    set: ((patch: Readonly<Record<string, unknown>>): SetResult => {
      log('set', patch)
      for (const key of Object.keys(patch)) {
        const refusal = refusals.get(key)
        if (refusal !== undefined) return refusal as SetResult
      }
      return undefined
    }) as BlitStage['set'],
    dispose(): void {
      if (disposed) return
      log('dispose')
      disposed = true
      for (const handle of viewHandles) handle.view.dispose()
      stageListeners.clear()
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
      lost = true
      emitTo(stageListeners, 'lost', { view: null })
      emitTo(stageListeners, 'error', {
        error: new GlError('the WebGL2 context was lost; dispose this stage and build a new one'),
        observed: false,
        view: null,
      })
    },
    pushWarning(warning): void {
      warnings.push(warning)
    },
    refuseKnob(key, error): void {
      refusals.set(key, error)
    },
    addSprite(key): Sprite {
      const sprite = makeSprite(key)
      sprites.set(key, sprite)
      return sprite
    },
  }
}
