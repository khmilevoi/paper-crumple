import { isAborted } from '../abort.js'
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
  let sequence = 0
  let gate: RequestGate | null = null
  let requestError: Error | null = null
  let pendingRequest: Promise<void> = Promise.resolve()
  let offs: Array<() => void> = []
  let offScene: (() => void) | null = null

  const publish = (): void => options.onChange()
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
    core.error = error
    if (core.pending !== null) requestError = error
    const version = attachment
    publish()
    if (version !== attachment) return
    latest().onError?.({ error, observed: true, view: core.view })
  }
  const release = (): void => {
    if (core.view === null && gate === null) return
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
    if (stage === null || target === null || core.view !== null) return
    const created = options.createView(stage, target)
    if (created instanceof Error) {
      report(created)
      return
    }
    core.view = created
    attachment += 1
    const current = (): boolean => core.view === created
    offs = [
      created.on('start', (event) => {
        if (!current()) return
        onRunStart(core, event)
        publish()
        if (current()) latest().onStart?.(event)
      }),
      created.on('step', (event) => {
        if (!current()) return
        const parked = core.parked
        onRunStep(core, event)
        if (parked !== core.parked) publish()
        if (current()) options.onStep?.(event)
      }),
      created.on('end', (event) => {
        if (!current()) return
        onRunEnd(core)
        publish()
        if (current()) latest().onEnd?.(event)
      }),
      stage.on('error', (event) => {
        if (!current() || event.view !== created) return
        core.error = event.error
        if (core.pending !== null) requestError = event.error
        publish()
        if (current()) latest().onError?.(event)
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
  ): void => {
    if (!request.current()) return
    const observed = requestError
    const outcome = error ?? observed
    core.pending = null
    core.error = outcome
    request.finish()
    publish()
    if (seq !== sequence) return
    if (error !== null && error !== observed) {
      latest().onError?.({ error, observed: true, view: core.view })
    }
    if (seq === sequence) latest().onSettle?.({ key, error: outcome, reduced })
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
  ): Promise<void> => {
    request.adopt(run)
    if (!request.current()) return Promise.resolve()
    core.pending =
      phase === 'entering'
        ? { key: opts.key, phase, run: run as Run<PlayResult> }
        : { key: opts.key, phase, run: run as Run<SwapResult> }
    publish()
    return run.done.then((result) => {
      if (isAborted(result)) cancel(request)
      else settle(request, seq, opts.key, result instanceof Error ? result : null, false)
    })
  }
  const request = (): Promise<void> => {
    const view = core.view
    const stage = options.scene.stage
    if (view === null || stage === null) return Promise.resolve()
    const opts = latest()
    const mismatch = rememberPair(pairs, opts.key, opts.source)
    if (mismatch !== undefined) {
      report(mismatch)
      return Promise.resolve()
    }
    if (core.synced?.view === view && core.synced.key === opts.key) return pendingRequest
    core.synced = { view, key: opts.key }
    core.requested = opts.key
    core.pending = { key: opts.key, phase: 'acquiring', run: null }
    sequence += 1
    const seq = sequence
    gate?.cancel()
    // Run.stop emits end synchronously: a callback may already have retried or detached.
    if (seq !== sequence) return Promise.resolve()
    const current = createRequestGate(
      () => seq === sequence && core.view === view,
      options.scene.signal,
    )
    gate = current
    requestError = null
    publish()
    if (!current.current()) return Promise.resolve()
    const acquisitions = createAcquisitions(stage)
    const reduced = reducedMotion(opts.reducedMotion)
    let work: Promise<void>
    if (view.sprite === null || reduced) {
      work = acquisitions
        .acquire(opts.key, opts.source, opts.pin, current.signal)
        .then(async (got) => {
          if (!current.current()) return
          if (isAborted(got)) {
            cancel(current)
            return
          }
          if (got instanceof Error) {
            settle(current, seq, opts.key, got, reduced)
            return
          }
          const entering = view.sprite === null
          const refused = view.show(got)
          if (!current.current()) return
          if (refused !== undefined) {
            settle(current, seq, opts.key, refused, reduced)
            return
          }
          if (!entering || opts.entrance !== 'uncrumple' || reduced) {
            settle(current, seq, opts.key, null, reduced)
            return
          }
          view.draw('ball')
          if (!current.current()) return
          const run = view.play('ball', 'flat', { duration: opts.duration, signal: current.signal })
          await track(current, seq, opts, run, 'entering')
        })
    } else {
      // Keep the call synchronous: onStart may need the browser's user gesture.
      const pending = acquisitions.pending(opts.key)
      const run =
        pending === undefined
          ? view.swapTo(opts.source, {
              key: opts.key,
              duration: opts.duration,
              signal: current.signal,
            })
          : view.crumpleTo(pending, { duration: opts.duration, signal: current.signal })
      work = track(current, seq, opts, run, 'swapping')
    }
    if (seq === sequence) pendingRequest = work
    return work
  }
  return {
    get view() {
      return core.view
    },
    get attachmentGeneration() {
      return attachment
    },
    get requestGeneration() {
      return sequence
    },
    attach(next) {
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
      if (view === null) return null
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
      if (core.view !== null) {
        core.view.draw(pose)
        publish()
      }
    },
    sync: publish,
    prepare() {
      const view = core.view
      const stage = options.scene.stage
      const sprite = view?.sprite
      if (view === null || stage === null || !sprite) return () => {}
      const acquisitions = createAcquisitions(stage)
      if (acquisitions.pending(sprite.key) !== undefined) return () => {}
      let cancelled = false
      void stage.prepare(sprite.key, { signal: acquisitions.signal }).then((got) => {
        if (cancelled || core.view !== view || isAborted(got)) return
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
    readLatest: latest,
    createView: (stage, target) => stage.view(target),
  })
  let canvas: HTMLCanvasElement | null = null
  return Object.assign(controller, {
    updateOptions(next: Partial<ViewInputs>) {
      inputs = { ...inputs, ...next }
    },
    ref(element: HTMLCanvasElement | null) {
      if (element === canvas && (element === null || controller.view !== null)) return
      canvas = element
      if (element === null) controller.detach()
      else {
        const current = latest()
        controller.attach({ canvas: element, size: 'managed', fit: current.fit, tag: current.tag })
      }
    },
  })
}
