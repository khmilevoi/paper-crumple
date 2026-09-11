import { ABORTED, isAborted } from '../abort.js'
import { ViewError } from '../errors.js'
import type { BlitStage, PlayResult, Run, SwapResult, View } from '../index.js'
import { rethrowFromMicrotask } from '../emitter.js'
import { createAcquisitions } from './acquire.js'
import { artworkStyleFor, frameStyleFor } from './frame.js'
import { rememberPair } from './pair.js'
import { createRequestGate, type RequestGate } from './request.js'
import { createCrumpleCore, onRunEnd, onRunStart, onRunStep, readCrumple } from './state.js'
import type {
  BindingStage,
  TargetFor,
  TargetViewController,
  ViewController,
  ViewControllerOptions,
  ViewInputs,
  ViewRequestResult,
} from './types.js'

function reducedMotion(mode: ViewInputs['reducedMotion']): boolean {
  return (
    mode !== 'off' &&
    typeof globalThis.matchMedia === 'function' &&
    globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

export function createTargetViewController<S extends BindingStage>(
  options: ViewControllerOptions<S> & {
    createView: (stage: S, target: TargetFor<S>) => View | Error
  },
): TargetViewController<TargetFor<S>> {
  const core = options.state ?? createCrumpleCore()
  let inputs: ViewInputs = options
  const latest = (): ViewInputs => options.readLatest?.() ?? inputs
  const pairs = options.sourcePairs ?? new Map<string, ViewInputs['source']>()
  const replacements = new Set<() => void>()
  let target: TargetFor<S> | null = null
  let attachment = 0
  let creating: { stage: S; target: TargetFor<S>; generation: number } | null = null
  let creationError: Error | null = null
  let sequence = 0
  let gate: RequestGate | null = null
  let requestError: Error | null = null
  let errorRevision = 0
  let disposed = false
  let pendingRequest: Promise<ViewRequestResult> = Promise.resolve(ABORTED)
  let offs: Array<() => void> = []
  let offScene: (() => void) | null = null

  const invoke = (listener: () => void): void => {
    try {
      listener()
    } catch (cause) {
      rethrowFromMicrotask(cause)
    }
  }
  const publish = (): void => invoke(options.onChange)
  const replaced = (): void => {
    for (const listener of [...replacements]) {
      if (!replacements.has(listener)) continue
      try {
        listener()
      } catch (cause) {
        rethrowFromMicrotask(cause)
      }
    }
    publish()
  }
  const report = (error: Error): void => {
    errorRevision += 1
    core.error = error
    if (core.pending !== null) requestError = error
    const version = attachment
    publish()
    if (version !== attachment) return
    invoke(() => latest().onError?.({ error, observed: true, view: core.view }))
  }
  const release = (): void => {
    creationError = null
    // Invalidate a factory call even before its View has been returned to us.
    if (core.view === null && gate === null) {
      if (creating !== null) attachment += 1
      return
    }
    sequence += 1
    const current = gate
    gate = null
    const view = core.view
    core.view = null
    core.pending = null
    core.synced = null
    onRunEnd(core)
    while (offs.length > 0) offs.pop()?.()
    current?.cancel()
    if (view === null) return
    attachment += 1
    view.dispose()
    replaced()
  }
  const detach = (): void => {
    target = null
    offScene?.()
    offScene = null
    release()
  }
  const ensureView = (): void => {
    const stage = options.scene.stage
    if (disposed || stage === null || stage.disposed || target === null || core.view !== null)
      return
    // A pending factory can already own the Blit canvas claim. Wait for its return
    // and disposal before creating a replacement, even after detach invalidated it.
    if (creating !== null) return
    const reservation = { stage, target, generation: ++attachment }
    creationError = null
    creating = reservation
    let result: View | Error
    try {
      result = options.createView(stage, reservation.target)
    } finally {
      if (creating === reservation) creating = null
    }
    const created = result
    // Stage.view publishes lifecycle synchronously. Callbacks can detach, dispose, or
    // attach a successor before the factory returns; only this reservation may commit.
    if (
      disposed ||
      stage.disposed ||
      options.scene.stage !== stage ||
      target !== reservation.target ||
      attachment !== reservation.generation ||
      core.view !== null
    ) {
      if (!(created instanceof Error)) created.dispose()
      ensureView()
      return
    }
    if (created instanceof Error) {
      creationError = created
      report(created)
      // A failed authoritative attempt is also a settled attachment. A callback
      // may already have replaced it; never notify for that obsolete refusal.
      if (attachment === reservation.generation && creationError === created) replaced()
      return
    }
    if (created.state === 'disposed') return
    core.view = created
    const current = (): boolean => core.view === created
    offs = [
      created.on('start', (event) => {
        if (!current()) return
        onRunStart(core, event)
        publish()
        if (current()) invoke(() => latest().onStart?.(event))
      }),
      ...(options.onStep === undefined
        ? []
        : [
            created.on('step', (event) => {
              if (!current()) return
              const parked = core.parked
              onRunStep(core, event)
              if (parked !== core.parked) publish()
              if (current()) invoke(() => options.onStep?.(event))
            }),
          ]),
      created.on('end', (event) => {
        if (!current()) return
        onRunEnd(core)
        publish()
        if (current()) invoke(() => latest().onEnd?.(event))
      }),
      stage.on('error', (event) => {
        if (!current() || event.view !== created) return
        core.error = event.error
        errorRevision += 1
        if (core.pending !== null) requestError = event.error
        publish()
        if (current()) invoke(() => latest().onError?.(event))
      }),
      created.changes.subscribe('lifecycle', () => {
        if (!current()) return
        if (created.state === 'disposed') release()
        else publish()
      }),
      created.changes.subscribe('state', () => {
        if (current()) publish()
      }),
      created.changes.subscribe('geometry', () => {
        if (current()) publish()
      }),
    ]
    replaced()
  }
  const settle = (
    request: RequestGate,
    seq: number,
    key: string,
    error: Error | null,
    reduced: boolean,
  ): ViewRequestResult => {
    if (!request.current()) return ABORTED
    const observed = requestError
    const outcome = error ?? observed
    core.pending = null
    core.error = outcome
    const result = outcome ?? core.view?.sprite ?? new ViewError('the request has no shown Sprite')
    request.finish()
    publish()
    if (seq !== sequence) return ABORTED
    if (error !== null && error !== observed) {
      invoke(() => latest().onError?.({ error, observed: true, view: core.view }))
    }
    if (seq === sequence) invoke(() => latest().onSettle?.({ key, error: outcome, reduced }))
    return seq === sequence ? result : ABORTED
  }
  const cancel = (request: RequestGate): void => {
    if (!request.current()) return
    core.pending = null
    request.finish()
    publish()
  }
  const track = (
    request: RequestGate,
    seq: number,
    opts: ViewInputs,
    run: Run<PlayResult> | Run<SwapResult>,
    phase: 'entering' | 'swapping',
  ): Promise<ViewRequestResult> => {
    request.adopt(run)
    if (!request.current()) return Promise.resolve(ABORTED)
    core.pending =
      phase === 'entering'
        ? { key: opts.key, phase, run: run as Run<PlayResult> }
        : { key: opts.key, phase, run: run as Run<SwapResult> }
    publish()
    return run.done.then((result) => {
      if (isAborted(result)) {
        cancel(request)
        return ABORTED
      }
      return settle(request, seq, opts.key, result instanceof Error ? result : null, false)
    })
  }
  const unavailable = (): Error =>
    new ViewError(
      disposed ? 'this view controller is disposed' : 'this view controller is detached',
    )
  const request = (
    key?: string,
    source?: ViewInputs['source'],
    requestOptions?: { pin?: true; signal?: AbortSignal },
  ): Promise<ViewRequestResult> => {
    const view = core.view
    const stage = options.scene.stage
    if (disposed || view === null || stage === null) return Promise.resolve(unavailable())
    if (requestOptions?.signal?.aborted) return Promise.resolve(ABORTED)
    const opts = {
      ...latest(),
      ...(key !== undefined && { key }),
      ...(source !== undefined && { source }),
      ...(requestOptions?.pin && { pin: requestOptions.pin }),
    }
    inputs = opts
    const mismatch = rememberPair(pairs, opts.key, opts.source)
    if (mismatch !== undefined) {
      report(mismatch)
      return Promise.resolve(mismatch)
    }
    if (core.synced?.view === view && core.synced.key === opts.key) return pendingRequest
    core.synced = { view, key: opts.key }
    core.requested = opts.key
    core.pending = { key: opts.key, phase: 'acquiring', run: null }
    sequence += 1
    const seq = sequence
    let resolveResponse!: (value: ViewRequestResult) => void
    const response = new Promise<ViewRequestResult>((resolve) => {
      resolveResponse = resolve
    })
    pendingRequest = response
    gate?.cancel()
    // Run.stop emits end synchronously: a callback may already have retried or detached.
    if (seq !== sequence) {
      resolveResponse(ABORTED)
      return response
    }
    const current = createRequestGate(
      () => seq === sequence && core.view === view,
      options.scene.signal,
    )
    gate = current
    const abortResponse = (): void => resolveResponse(ABORTED)
    current.signal.addEventListener('abort', abortResponse, { once: true })
    const abort = (): void => {
      if (!current.current()) return
      core.pending = null
      current.cancel()
      publish()
    }
    requestOptions?.signal?.addEventListener('abort', abort, { once: true })
    requestError = null
    replaced()
    // The predecessor's synchronous onEnd may have aborted this signal before registration.
    if (requestOptions?.signal?.aborted) abort()
    if (!current.current()) {
      requestOptions?.signal?.removeEventListener('abort', abort)
      current.signal.removeEventListener('abort', abortResponse)
      resolveResponse(ABORTED)
      return response
    }
    const acquisitions = createAcquisitions(stage)
    const reduced = reducedMotion(opts.reducedMotion)
    let work: Promise<ViewRequestResult>
    if (view.sprite === null || reduced) {
      work = acquisitions
        .acquire(opts.key, opts.source, opts.pin, current.signal)
        .then(async (got) => {
          if (!current.current()) return ABORTED
          if (isAborted(got)) {
            cancel(current)
            return ABORTED
          }
          if (got instanceof Error) {
            return settle(current, seq, opts.key, got, reduced)
          }
          if (opts.pin) stage.pin(got.key)
          const entering = view.sprite === null
          const refused = view.show(got)
          if (!current.current()) return ABORTED
          if (refused !== undefined) {
            return settle(current, seq, opts.key, refused, reduced)
          }
          if (!entering || opts.entrance !== 'uncrumple' || reduced) {
            return settle(current, seq, opts.key, null, reduced)
          }
          view.draw('ball')
          if (!current.current()) return ABORTED
          const run = view.play('ball', 'flat', { duration: opts.duration, signal: current.signal })
          return track(current, seq, opts, run, 'entering')
        })
    } else {
      // The registry owns source work; this View only owns its Run. Keep start synchronous.
      const pending = acquisitions.acquire(opts.key, opts.source, opts.pin).then((got) => {
        if (opts.pin && !isAborted(got) && !(got instanceof Error)) stage.pin(got.key)
        return got
      })
      const run = view.crumpleTo(pending, { duration: opts.duration, signal: current.signal })
      work = track(current, seq, opts, run, 'swapping')
    }
    void work.then((result) => {
      requestOptions?.signal?.removeEventListener('abort', abort)
      current.signal.removeEventListener('abort', abortResponse)
      resolveResponse(result)
    })
    return response
  }
  return {
    get view() {
      return core.view
    },
    get requested() {
      return core.requested
    },
    get pending() {
      return core.pending !== null
    },
    get error() {
      return core.error
    },
    get creationError() {
      return creationError
    },
    get frame() {
      return core.view?.frame ?? null
    },
    get attachmentGeneration() {
      return attachment
    },
    get requestGeneration() {
      return sequence
    },
    attach(next) {
      if (disposed) return
      if (next === null) {
        detach()
        return
      }
      if (next === target && core.view !== null) return
      if (target !== next) release()
      target = next
      offScene ??= options.scene.subscribe(() => {
        if (options.scene.stage === null) release()
        else ensureView()
      })
      ensureView()
      if (options.scene.status === 'idle') void options.scene.ensure()
    },
    detach,
    dispose() {
      if (disposed) return
      disposed = true
      detach()
      replacements.clear()
    },
    subscribeReplacement(listener) {
      replacements.add(listener)
      return () => {
        replacements.delete(listener)
      }
    },
    updateOptions(next) {
      inputs = { ...inputs, ...next }
    },
    read() {
      const reading = readCrumple(core)
      const frameTo = latest().frameTo
      return {
        ...reading,
        frameStyle: frameStyleFor(reading.frame, frameTo),
        artworkStyle: artworkStyleFor(reading.frame, frameTo),
      }
    },
    request,
    retry() {
      core.synced = null
      return request()
    },
    play(from, to, opts) {
      const view = core.view
      if (view === null) return unavailable()
      const run = view.play(from, to, { duration: latest().duration, ...opts })
      publish()
      return run
    },
    stop() {
      core.view?.stop()
      publish()
    },
    refresh() {
      core.view?.refresh()
      publish()
    },
    draw(pose) {
      if (core.view === null) return unavailable()
      const before = errorRevision
      core.view.draw(pose)
      publish()
      return before !== errorRevision ? (core.error ?? undefined) : undefined
    },
    set(patch) {
      if (core.view === null) return unavailable()
      // The controller accepts runtime descriptor keys; View validates their scope and values.
      const result = core.view.set(patch as never)
      publish()
      return result
    },
    sync: publish,
    prepare() {
      const view = core.view
      const stage = options.scene.stage
      const sprite = view?.sprite
      if (view === null || stage === null || !sprite) return () => {}
      const acquisitions = createAcquisitions(stage)
      if (acquisitions.pending(sprite.key) !== undefined) return () => {}
      const preparedSequence = sequence
      let cancelled = false
      void stage.prepare(sprite.key, { signal: acquisitions.signal }).then((got) => {
        if (
          cancelled ||
          core.view !== view ||
          view.sprite !== sprite ||
          sequence !== preparedSequence ||
          isAborted(got)
        )
          return
        if (got instanceof Error) {
          report(got)
          return
        }
        view.refresh()
        publish()
      })
      return () => {
        cancelled = true
      }
    },
  }
}

export function createViewController(options: ViewControllerOptions<BlitStage>): ViewController {
  let inputs: ViewInputs = options
  const latest = (): ViewInputs => options.readLatest?.() ?? inputs
  const controller = createTargetViewController({
    ...options,
    createView: (stage, target) => stage.view(target),
  })
  let canvas: HTMLCanvasElement | null = null
  let canvasTarget: TargetFor<BlitStage> | null = null
  const update = controller.updateOptions
  return Object.assign(controller, {
    updateOptions(next: Partial<ViewInputs>) {
      inputs = { ...inputs, ...next }
      update(next)
    },
    ref(element: HTMLCanvasElement | null) {
      if (element === canvas && (element === null || controller.view !== null)) return
      canvas = element
      if (element === null) {
        canvasTarget = null
        controller.detach()
      } else {
        const current = latest()
        // Reentrant refs must join the in-flight target instead of invalidating its
        // canvas claim. Explicit detach still reaches attach and can schedule a new View.
        if (
          canvasTarget?.canvas !== element ||
          canvasTarget.fit !== current.fit ||
          canvasTarget.tag !== current.tag
        )
          canvasTarget = { canvas: element, size: 'managed', fit: current.fit, tag: current.tag }
        controller.attach(canvasTarget)
      }
    },
  })
}
