import {
  ABORTED,
  ViewError,
  type BitmapSupplier,
  type BlitStage,
  type ChangeArea,
  type Knobs,
  type PlayOptions,
  type PoseRef,
  type Sprite,
  type SpriteSource,
  type View,
  type ViewFrame,
  type ViewState,
} from '@paper-crumple/core'
import {
  createCrumpleCore,
  createTargetViewController,
  frameStyleFor,
  type BindingStage,
  type RenderValue,
  type SceneController,
  type TargetFor,
  type ViewInputs,
} from '@paper-crumple/core/bindings'
import {
  abortVar,
  action,
  atom,
  bind,
  type Atom,
  type Frame,
  reatomObservable,
  withAsyncData,
  withMiddleware,
  wrap,
} from '@reatom/core'
import { observeExternal, readAtRevision } from './observable.js'
import { createProgress } from './progress.js'
import { reatomRun, type RunModel } from './run.js'
import { cancelWithOwner } from './owner.js'
import { joinReady } from './ready.js'
import { toAsyncValue } from './result.js'
import type { Ready, ViewOptions, ViewSettings } from './types.js'

function createView<S extends BindingStage>(
  config: ViewOptions<S>,
  scope: {
    controller: SceneController<S>
    ready: Ready<S>
    owner: Frame
    assertOwner(): void
    mintKey(): string
    claimSource(key: string, source: SpriteSource): AbortSignal
  },
) {
  const { name, source: initialSource, createView: factory, ...initialOptions } = config
  const { owner, assertOwner } = scope
  const source = atom<SpriteSource>(() => initialSource, `${name}.source`)
  const knobs = atom<Knobs>({}, `${name}.knobs`)
  const options = atom<ViewSettings>(initialOptions, `${name}.options`)
  const keys = new Map<SpriteSource, string>()
  const suppliers = new WeakMap<BitmapSupplier, BitmapSupplier>()
  const keyFor = (next: SpriteSource, explicit?: string) => {
    if (explicit !== undefined) return explicit
    let key = keys.get(next)
    if (key === undefined) {
      key = scope.mintKey()
      keys.set(next, key)
    }
    return key
  }
  const coreSource = (next: SpriteSource): SpriteSource => {
    if (typeof next !== 'function') return next
    let bound = suppliers.get(next)
    if (bound === undefined) {
      bound = bind(next, owner)
      suppliers.set(next, bound)
    }
    return bound
  }
  const bindInputs = (next: SpriteSource, settings: ViewSettings): ViewInputs => ({
    ...settings,
    source: coreSource(next),
    key: keyFor(next, settings.key),
    onStart: settings.onStart && bind(settings.onStart, owner),
    onEnd: settings.onEnd && bind(settings.onEnd, owner),
    onError: settings.onError && bind(settings.onError, owner),
    onSettle: settings.onSettle && bind(settings.onSettle, owner),
  })
  const core = createCrumpleCore()
  const sourcePairs = new Map<string, SpriteSource>()
  const makeView = factory as ((stage: S, target: TargetFor<S>) => View | Error) | undefined
  const controller = createTargetViewController<S>({
    ...bindInputs(initialSource, initialOptions),
    scene: scope.controller,
    state: core,
    sourcePairs,
    createView: bind(
      makeView ?? ((stage, target) => (stage as BlitStage).view(target as TargetFor<BlitStage>)),
      owner,
    ),
    onChange() {},
  })
  let target: TargetFor<S> | null = null
  let attachment = new AbortController()
  let disposed = false
  let appliedOptions: ViewSettings = initialOptions
  let activeRequest: ReturnType<typeof abortVar.require> | undefined
  let requestSequence = 0
  let invocation = 0
  // Reserve before native withAbort can synchronously emit the predecessor's end callback.
  const reserveRequest = withMiddleware(
    () =>
      (next, ...params) => {
        assertOwner()
        const previous = invocation
        invocation = ++requestSequence
        try {
          return next(...params)
        } finally {
          invocation = previous
        }
      },
    'read',
  )
  let readyIdentity: {
    attachment: AbortSignal
    source: SpriteSource
    settings: ViewSettings
    knobs: Knobs
  } | null = null
  const identity = () => {
    assertOwner()
    const desired = source(),
      settings = options(),
      patch = knobs()
    if (
      readyIdentity?.attachment !== attachment.signal ||
      readyIdentity.source !== desired ||
      readyIdentity.settings !== settings ||
      readyIdentity.knobs !== patch
    )
      readyIdentity = { attachment: attachment.signal, source: desired, settings, knobs: patch }
    return readyIdentity
  }
  const request = async (next: SpriteSource, settings: ViewSettings, patch: Knobs, seq: number) => {
    if (disposed || target === null)
      return toAsyncValue<Sprite>(
        new ViewError(disposed ? 'this view model is disposed' : 'this view model is detached'),
      )
    const current = attachment
    const operation = abortVar.require()
    const signal = operation.signal
    const predecessor = activeRequest
    activeRequest = operation
    predecessor?.abort()
    if (seq !== requestSequence || current !== attachment || signal.aborted)
      return toAsyncValue<Sprite>(ABORTED)
    const releaseScene = cancelWithOwner(scope.controller.signal)
    const releaseAttachment = cancelWithOwner(current.signal)
    let releaseSource = () => {}
    try {
      if (scope.controller.stage === null) await wrap(scope.ready())
      if (seq !== requestSequence || current !== attachment || signal.aborted)
        return toAsyncValue<Sprite>(ABORTED)
      if (controller.creationError !== null) return toAsyncValue<Sprite>(controller.creationError)
      const inputs = bindInputs(next, settings)
      releaseSource = cancelWithOwner(scope.claimSource(inputs.key, next))
      // Scene validation also recognizes a resource model's explicit replace().
      sourcePairs.set(inputs.key, inputs.source)
      controller.updateOptions(inputs)
      toAsyncValue(controller.set(patch))
      if (seq !== requestSequence || current !== attachment || signal.aborted)
        return toAsyncValue<Sprite>(ABORTED)
      appliedOptions = settings
      // A settled attempt may be retried; pending identical requests remain controller-owned joins.
      if (core.pending === null) core.synced = null
      return toAsyncValue<Sprite>(
        await wrap(controller.request(inputs.key, inputs.source, { pin: inputs.pin, signal })),
      )
    } finally {
      releaseScene()
      releaseAttachment()
      releaseSource()
      if (activeRequest === operation) activeRequest = undefined
    }
  }
  const trackReady = action(async () => {
    const seq = invocation
    if (seq !== requestSequence) return toAsyncValue<Sprite>(ABORTED)
    const desired = identity()
    return request(desired.source, desired.settings, desired.knobs, seq)
  }, `${name}._ready`).extend(withAsyncData({ initState: null as Sprite | null }), reserveRequest)
  const ready: Ready<Sprite> = Object.assign(
    joinReady(
      bind(() => trackReady(), owner),
      identity,
    ),
    {
      data: trackReady.data,
      error: trackReady.error,
      pending: trackReady.pending,
      ready: trackReady.ready,
    },
  )
  const swap = action(async (next: SpriteSource) => {
    assertOwner()
    const seq = invocation
    if (seq !== requestSequence) return toAsyncValue<Sprite>(ABORTED)
    source.set(() => next)
    if (seq !== requestSequence) return toAsyncValue<Sprite>(ABORTED)
    return request(next, options(), knobs(), seq)
  }, `${name}.swap`).extend(withAsyncData({ initState: null as Sprite | null }), reserveRequest)
  let automaticAttachment: AbortController | undefined
  const autoReady = bind(() => {
    if (
      disposed ||
      scope.controller.disposed ||
      target === null ||
      automaticAttachment === attachment ||
      (controller.view === null &&
        scope.controller.stage !== null &&
        controller.creationError === null)
    )
      return
    // Adoption and request publication share this notification. Reserve before ready()
    // so its synchronous request publication cannot recursively start another action.
    automaticAttachment = attachment
    void ready().catch(() => {})
  }, owner)
  const offAutoReady = controller.subscribeReplacement(autoReady)
  let canvas: HTMLCanvasElement | null = null
  let canvasTarget: TargetFor<S> | null = null
  const attach = bind((next: TargetFor<S> | null) => {
    if (disposed || scope.controller.disposed) return
    if (next === target && controller.view !== null) return
    const previous = attachment
    attachment = new AbortController()
    const current = attachment
    target = next
    canvas = next !== null && 'canvas' in next ? next.canvas : null
    previous.abort()
    if (attachment !== current || disposed || scope.controller.disposed) return
    controller.attach(next)
    // A reentrant attach can return before the core adopts its queued View. The
    // replacement signal above starts that target only once adoption succeeds.
    if (attachment === current) autoReady()
  }, owner)
  const ref = bind((next: HTMLCanvasElement | null) => {
    if (next === canvas && controller.view !== null) return
    const settings = options()
    if (next === null) canvasTarget = null
    else if (
      canvasTarget === null ||
      !('canvas' in canvasTarget) ||
      canvasTarget.canvas !== next ||
      canvasTarget.fit !== settings.fit ||
      canvasTarget.tag !== settings.tag
    )
      canvasTarget = {
        canvas: next,
        size: 'managed',
        fit: settings.fit,
        tag: settings.tag,
      } as TargetFor<S>
    attach(canvasTarget)
  }, owner)
  const dispose = action(() => {
    assertOwner()
    if (disposed) return
    disposed = true
    target = null
    offAutoReady()
    attachment.abort()
    controller.dispose()
  }, `${name}.dispose`)
  const readRaw = () => controller.view
  const observe = <T>(property: string, read: () => T, areas: readonly ChangeArea[]) =>
    observeExternal({
      name: `${name}.${property}`,
      owner,
      assertOwner,
      read,
      entity: readRaw,
      areas,
      subscribeReplacement: controller.subscribeReplacement,
    })
  const readFrame = readAtRevision(readRaw, 'geometry', () => controller.view?.frame ?? null)
  let cached: RenderValue = { ref, shown: null, frameStyle: null }
  let renderedView = controller.view
  let lifecycle = -1,
    content = -1,
    geometry = -1,
    attachmentVersion = -1,
    requestVersion = -1
  let frameTo: number | undefined
  const readRenderValue = (): RenderValue => {
    assertOwner()
    const view = controller.view
    const nextLifecycle = view?.changes.revision('lifecycle') ?? 0
    const nextContent = view?.changes.revision('content') ?? 0
    const nextGeometry = view?.changes.revision('geometry') ?? 0
    const replacement =
      view !== renderedView || attachmentVersion !== controller.attachmentGeneration
    const styleChanged =
      replacement || nextGeometry !== geometry || frameTo !== appliedOptions.frameTo
    if (
      !replacement &&
      nextLifecycle === lifecycle &&
      nextContent === content &&
      !styleChanged &&
      requestVersion === controller.requestGeneration
    )
      return cached
    const shown =
      replacement || nextContent !== content ? (view?.sprite?.key ?? null) : cached.shown
    let frameStyle = styleChanged
      ? frameStyleFor(readFrame(), appliedOptions.frameTo)
      : cached.frameStyle
    if (
      frameStyle !== null &&
      cached.frameStyle !== null &&
      frameStyle.width === cached.frameStyle.width &&
      frameStyle.height === cached.frameStyle.height &&
      frameStyle.left === cached.frameStyle.left &&
      frameStyle.top === cached.frameStyle.top
    )
      frameStyle = cached.frameStyle
    if (shown !== cached.shown || frameStyle !== cached.frameStyle)
      cached = { ref, shown, frameStyle }
    renderedView = view
    lifecycle = nextLifecycle
    content = nextContent
    geometry = nextGeometry
    attachmentVersion = controller.attachmentGeneration
    requestVersion = controller.requestGeneration
    frameTo = appliedOptions.frameTo
    return cached
  }
  const subscribeRenderChanges = (trigger: () => void): (() => void) => {
    let current = controller.view
    let offs: Array<() => void> = []
    const subscribe = () => {
      offs =
        current === null
          ? []
          : (['lifecycle', 'content', 'geometry'] as const).map((area) =>
              current!.changes.subscribe(area, trigger),
            )
    }
    const offReplacement = controller.subscribeReplacement(
      bind(() => {
        if (current !== controller.view) {
          offs.forEach((off) => off())
          current = controller.view
          subscribe()
        }
        trigger()
      }, owner),
    )
    subscribe()
    return () => {
      offReplacement()
      offs.forEach((off) => off())
    }
  }
  const render = reatomObservable<RenderValue>(
    (trigger) => ({ getState: readRenderValue, subscribe: () => subscribeRenderChanges(trigger) }),
    `${name}.render`,
  )
  const play = action((from: PoseRef, to: PoseRef, settings?: PlayOptions): RunModel<undefined> => {
    assertOwner()
    const run = controller.play(from, to, settings)
    if (run instanceof Error) {
      const done = Promise.resolve(run)
      return reatomRun<undefined>({ done, then: done.then.bind(done), stop() {} }, `${name}.run`)
    }
    return reatomRun<undefined>(run, `${name}.run`)
  }, `${name}.play`)
  const draw = action((pose: PoseRef) => {
    assertOwner()
    return controller.draw(pose)
  }, `${name}.draw`)
  const set = action((patch: Knobs) => {
    assertOwner()
    return controller.set(patch)
  }, `${name}.set`)
  const stop = action(() => {
    assertOwner()
    controller.stop()
  }, `${name}.stop`)
  const readPose = () => {
    assertOwner()
    return controller.view?.pose ?? null
  }
  return {
    source,
    knobs,
    options,
    ready,
    swap,
    attach,
    dispose,
    play,
    draw,
    set,
    stop,
    readPose,
    ...(factory === undefined ? { ref, render } : {}),
    progress: createProgress({
      name: `${name}.progress`,
      owner,
      assertOwner,
      view: readRaw,
      subscribeReplacement: controller.subscribeReplacement,
    }),
    raw: observe('raw', readRaw, ['lifecycle']),
    shown: observe('shown', () => controller.view?.sprite?.key ?? null, ['content']),
    sprite: observe('sprite', () => controller.view?.sprite ?? null, ['content']),
    state: observe<ViewState | 'detached'>('state', () => controller.view?.state ?? 'detached', [
      'state',
    ]),
    frame: observe<ViewFrame | null>('frame', readFrame, ['geometry']),
    appliedKnobs: observe(
      'appliedKnobs',
      readAtRevision(readRaw, 'settings', () => controller.view?.appliedKnobs ?? emptyKnobs),
      ['settings'],
    ),
  }
}

const emptyKnobs: Readonly<Knobs> = Object.freeze({})

export type ViewModel<S extends BindingStage = BlitStage> = Omit<
  ReturnType<typeof createView<S>>,
  'render' | 'ref'
> &
  (S extends BlitStage ? { render: Atom<RenderValue>; ref: RenderValue['ref'] } : object)

export function createViewModel<S extends BindingStage>(
  ...args: Parameters<typeof createView<S>>
): ViewModel<S> {
  return createView(...args) as ViewModel<S>
}
