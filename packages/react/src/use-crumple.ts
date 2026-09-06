import type {
  BlitStage,
  Events,
  PlayOptions,
  PlayResult,
  PoseRef,
  Run,
  SpriteSource,
  StageEvent,
  View,
} from '@paper-crumple/core'
import { ABORTED } from '@paper-crumple/core'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { acquire, pendingAcquisition, stageSignal } from './acquire.js'
import type { Crumple } from './crumple.js'
import { createCrumpleCore, onRunEnd, onRunStart, onRunStep, readCrumple } from './crumple-state.js'
import type { CrumpleOptions, CrumpleSnapshot, ReducedMotion } from './crumple-types.js'
import { rememberPair } from './pair-guard.js'
import { useScene } from './scene-context.js'
import { createVersionedStore } from './store.js'
import { useEvent } from './use-event.js'

/**
 * The options as the body reads them. `PinFor<S>` is a deferred conditional while `S` is a type
 * parameter, so `o.pin` is not reachable through `CrumpleOptions<S>` itself — and it does not
 * need to be: the generic exists for the call-site check, which has already happened by the time
 * this runs. `PinFor<SpriteSource>` is `{ pin?: true }`, because the whole union is not a
 * `PinnedSource`.
 */
type ResolvedOptions = CrumpleOptions<SpriteSource>

/**
 * Consulted at the swap and at the entrance, never cached at mount (§5.3): a consumer who changes
 * the OS setting mid-session gets the new behaviour on their next interaction. Guarded for the
 * server, where the whole question is moot because no effect runs (§8).
 */
function prefersReducedMotion(mode: ReducedMotion | undefined): boolean {
  if (mode === 'off') return false
  if (typeof globalThis.matchMedia !== 'function') return false
  return globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** Everything the hook owns that is not part of the snapshot. One per hook instance. */
interface CrumpleLive {
  stage: BlitStage | null
  canvas: HTMLCanvasElement | null
  offs: Array<() => void>
  /** Aborts the acquisition or run the current (view, key) pair started. */
  run: AbortController | null
  /** Bumped by every supersession, so a settled continuation can tell it is stale. */
  seq: number
}

export function useCrumple<S extends SpriteSource>(o: CrumpleOptions<S>): Crumple {
  const provided = useScene()
  const scene = o.scene ?? provided

  const latest = useEvent((): ResolvedOptions => o as unknown as ResolvedOptions)

  const [core] = useState(createCrumpleCore)
  const [store] = useState(() => createVersionedStore<CrumpleSnapshot>(() => readCrumple(core)))
  const [live] = useState<CrumpleLive>(() => ({
    stage: null,
    canvas: null,
    offs: [],
    run: null,
    seq: 0,
  }))
  const [pairs] = useState(() => new Map<string, SpriteSource>())

  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot)

  /**
   * Every consumer callback goes through `useEvent`, and they are dispatched from the binding's
   * own four subscriptions rather than from `view.on` calls of their own: subscribing per callback
   * would put the consumer's function identity in the effect's dependencies, so an inline arrow
   * would tear down and re-attach every render — and omitting it is the stale-closure bug that
   * replaces that one (§5.5).
   */
  const dispatchStart = useEvent((e: Events['start']): void => {
    o.onStart?.(e)
  })
  const dispatchEnd = useEvent((e: Events['end']): void => {
    o.onEnd?.(e)
  })
  const dispatchError = useEvent((e: StageEvent<'error'>): void => {
    o.onError?.(e)
  })

  /** `observed: true`: the error is on `crumple.error` too, and §7's telemetry filter on
   *  `!observed` exists so a value with two routes is not counted twice. */
  const report = useEvent((error: Error): void => {
    // eslint-disable-next-line react-hooks/immutability -- `core` is an intentionally mutable record held once per hook instance and never replaced; `store.bump()` publishes each write (§5.5).
    core.error = error
    store.bump()
    dispatchError({ error, observed: true, view: core.view })
  })

  /**
   * The three real view events, plus the stage's error bus filtered to this view. A view's bus
   * carries exactly `start`, `step` and `end`; an error takes the route straight onto the STAGE's
   * bus, so `view.on('error', …)` compiles and is silently dead (§5.5).
   */
  const listen = useEvent((view: View, stage: BlitStage): Array<() => void> => [
    view.on('start', (e) => {
      onRunStart(core, e)
      store.bump()
      dispatchStart(e)
    }),
    view.on('step', (e) => {
      onRunStep(core, e)
      store.bump()
    }),
    view.on('end', (e) => {
      onRunEnd(core)
      store.bump()
      dispatchEnd(e)
    }),
    stage.on('error', (e) => {
      if (e.view !== view) return
      core.error = e.error
      store.bump()
      dispatchError(e)
    }),
  ])

  /**
   * The first sprite of a view. `stage.mount` is deliberately not used: it composes
   * `add` + `view` + `show('flat')` in one call, and the three are needed separately — the view is
   * born with the canvas ref and the sprite is acquired against a key that may already be live, in
   * flight, or resident with an evicted front (§5.4).
   */
  const enter = useEvent(
    (
      view: View,
      stage: BlitStage,
      opts: ResolvedOptions,
      controller: AbortController,
      seq: number,
    ): void => {
      void (async () => {
        const got = await acquire(stage, opts.spriteKey, opts.src, opts.pin, controller.signal)
        if (got === ABORTED || seq !== live.seq) return
        if (got instanceof Error) {
          report(got)
          return
        }
        const refused = view.show(got)
        if (refused !== undefined) {
          report(refused)
          return
        }
        // An `entrance: 'uncrumple'` under `reduce` is `'flat'`: `show()` is one draw, with no run
        // and no start/step/end triple, which is why nothing downstream needs its own branch.
        if (opts.entrance !== 'uncrumple' || prefersReducedMotion(opts.reducedMotion)) {
          store.bump()
          return
        }
        // The order is load-bearing: `draw` resolves a PoseRef against the SHOWN sprite's clip,
        // so a `draw('ball')` before the `show` resolves against a pose count of 1 and silently
        // draws the flat sheet.
        view.draw('ball')
        const run = view.play('ball', 'flat', {
          duration: opts.duration,
          signal: controller.signal,
        })
        store.bump()
        void run.done.then(() => {
          if (seq === live.seq) store.bump()
        })
      })()
    },
  )

  /**
   * A view that is already showing something swaps rather than enters. Not `async`, and no `await`
   * may be introduced above `swapTo`: `start` is emitted synchronously inside the call, and an
   * `AudioContext.resume()` in a start handler only runs inside the user gesture because of it
   * (§5.3, §7.1). Settlement is handled in a `.then` on the returned `Run`.
   */
  const swap = useEvent(
    (
      view: View,
      stage: BlitStage,
      opts: ResolvedOptions,
      controller: AbortController,
      seq: number,
    ): void => {
      if (prefersReducedMotion(opts.reducedMotion)) {
        // `show()` IS the degraded swap — instant, pose 0, no run — so the accommodation needs no
        // API of its own, and it goes through `acquire` exactly as the entrance does.
        void (async () => {
          const got = await acquire(stage, opts.spriteKey, opts.src, opts.pin, controller.signal)
          if (got === ABORTED || seq !== live.seq) return
          if (got instanceof Error) {
            report(got)
            return
          }
          const refused = view.show(got)
          if (refused !== undefined) {
            report(refused)
            return
          }
          store.bump()
        })()
        return
      }

      // The in-flight map gates `swapTo` too: a concurrent second `swapTo` on a key whose `add` is
      // still in flight is refused by `reserved`, which is private to the core. Joining the
      // existing acquisition and handing the promise to `crumpleTo` is the same park, and costs
      // one ingest rather than two.
      const pending = pendingAcquisition(stage, opts.spriteKey)
      const run =
        pending === undefined
          ? view.swapTo(opts.src, {
              key: opts.spriteKey,
              duration: opts.duration,
              signal: controller.signal,
            })
          : view.crumpleTo(pending, { duration: opts.duration, signal: controller.signal })
      store.bump()
      void run.done.then((result) => {
        if (seq !== live.seq) return
        // A swap whose target fails rolls back to the previous sprite and the Run returns the
        // target's Error, so the prop says B while the canvas shows A. Reported through `report`,
        // the same route every other failure in this hook takes, so `onError` sees it too;
        // `report` already bumps, so this branch and the success branch below each bump exactly
        // once. Reported, never retried: a retry policy inside an animation library is a network
        // policy nobody asked for.
        if (result instanceof Error) {
          report(result)
          return
        }
        store.bump()
      })
    },
  )

  /**
   * The one entry point for "this view should be showing this key". Called when a view appears and
   * whenever `spriteKey` or `src` changes. Whether that is an entrance or a swap is decided by
   * whether this view is showing anything at all — which is also what makes a scene rebuild replay
   * the entrance rather than swap on a stage with nothing in it.
   */
  const syncSprite = useEvent((view: View): void => {
    const stage = live.stage
    if (stage === null) return
    const opts = latest()
    const key = opts.spriteKey
    // Before any library call: a changed `src` under an unchanged key is refused and nothing is
    // requested (§5.3).
    const mismatch = rememberPair(pairs, key, opts.src)
    if (mismatch !== undefined) {
      report(mismatch)
      return
    }
    if (core.synced?.view === view && core.synced.key === key) return
    // eslint-disable-next-line react-hooks/immutability -- `core` is an intentionally mutable record held once per hook instance and never replaced; `store.bump()` publishes each write (§5.5).
    core.synced = { view, key }
    core.requested = key
    // eslint-disable-next-line react-hooks/immutability -- `live` is an intentionally mutable record held once per hook instance and never replaced; it tracks the pair's own bookkeeping and is never handed to a consumer.
    live.seq += 1
    const seq = live.seq
    // Supersession: the previous acquisition or run is aborted, which is what aborts the `add` a
    // superseded swap started so a second swap does not pay for an ingest nobody will show.
    live.run?.abort()
    const controller = new AbortController()
    live.run = controller
    store.bump()
    // Whether this is the entrance or a swap is decided by whether the view is showing anything:
    // `crumpleTo` on an empty view degenerates to `show()`, so there is no ball to park at before
    // the first sprite exists, and a rebuilt stage hands back a view with nothing in it (§5.4).
    if (view.sprite === null) {
      enter(view, stage, opts, controller, seq)
      return
    }
    swap(view, stage, opts, controller, seq)
  })

  const view = snapshot.view
  const { spriteKey, src } = o
  useEffect(() => {
    if (view === null) return
    syncSprite(view)
  }, [view, spriteKey, src, syncSprite])

  const frameTo = o.frameTo
  useEffect(() => {
    if (core.frameTo === frameTo) return
    // Mirrored into the record rather than derived at render: the snapshot must be one cached
    // object, rebuilt only at a bump (§5.5).
    // eslint-disable-next-line react-hooks/immutability -- `core` is an intentionally mutable record held once per hook instance and never replaced; `store.bump()` publishes each write (§5.5).
    core.frameTo = frameTo
    store.bump()
  }, [frameTo, core, store])

  const knobEpoch = scene.knobEpoch
  useEffect(() => {
    const active = core.view
    const stage = live.stage
    if (active === null || stage === null) return
    const sprite = active.sprite
    // A crumple with no sprite yet skips the join entirely: `prepare` on a key with no record
    // returns a SheetError, and a key that is merely reserved has no record until `addBody`
    // finishes, so joining here would report a library error for the ordinary sequence of moving
    // a knob while a tile is still mounting (§4.3).
    if (sprite === null) return
    if (pendingAcquisition(stage, sprite.key) !== undefined) return
    let cancelled = false
    void (async () => {
      // A knob whose descriptor moves geometry makes the next demand answer SourceExpiredError,
      // which the stage turns into a re-source. That work is still in flight when `stage.set`
      // returns, and `prepare` is the one demand that waits for it — reading `View.frame` any
      // earlier reads the frame the sprite is about to leave.
      const joined = await stage.prepare(sprite.key, { signal: stageSignal(stage) })
      if (cancelled) return
      if (joined instanceof Error) {
        report(joined)
        return
      }
      // A landed re-source emits nothing at all, so this bump is the only thing that re-reads
      // `frame` and `frameStyle` (§5.5).
      active.refresh()
      store.bump()
    })()
    return () => {
      cancelled = true
    }
  }, [knobEpoch, core, live, report, store])

  /**
   * Disposal, from either half of the pair. Idempotent: React runs the ref's null call before the
   * effect cleanups, and `dispose()` is idempotent in the core besides.
   */
  const destroy = useEvent((): void => {
    const view = core.view
    if (view === null) return
    // eslint-disable-next-line react-hooks/immutability -- `live` is an intentionally mutable record held once per hook instance and never replaced; it tracks the pair's own bookkeeping and is never handed to a consumer.
    live.seq += 1
    live.run?.abort()
    live.run = null
    for (const off of live.offs) off()
    live.offs = []
    // eslint-disable-next-line react-hooks/immutability -- `core` is an intentionally mutable record held once per hook instance and never replaced; `store.bump()` publishes each write (§5.5).
    core.view = null
    core.synced = null
    core.parked = false
    core.via = undefined
    // Leaves the element's last blitted pixels in place; the element itself is the consumer's.
    view.dispose()
    store.bump()
  })

  /** Creation, from either half of the pair — whichever completes it. */
  const ensure = useEvent((): void => {
    if (core.view !== null) return
    const stage = live.stage
    const canvas = live.canvas
    if (stage === null || canvas === null) return
    const opts = latest()
    // `size: 'managed'` always (§5.1): under `'manual'` the core never writes the backing store
    // and §6 excludes `width`/`height` from `canvasProps`, so nobody could size the destination.
    const created = stage.view({ canvas, size: 'managed', fit: opts.fit, tag: opts.tag })
    if (created instanceof Error) {
      report(created)
      return
    }
    // eslint-disable-next-line react-hooks/immutability -- `core` is an intentionally mutable record held once per hook instance and never replaced; `store.bump()` publishes each write (§5.5).
    core.view = created
    // eslint-disable-next-line react-hooks/immutability -- `live` is an intentionally mutable record held once per hook instance and never replaced; it tracks the pair's own bookkeeping and is never handed to a consumer.
    live.offs = listen(created, stage)
    store.bump()
  })

  /**
   * Identity-stable, and that is correctness rather than ergonomics: React re-invokes a callback
   * ref whose identity changed, so an unstable one would `dispose()` and rebuild the view on
   * every render.
   *
   * The null call IS the ref's cleanup here — the declared type returns `void`, so React 19 falls
   * back to calling the ref with `null`, and it does so in the commit's mutation phase, before
   * any effect cleanup. That is what §1 requires: a canvas that detaches disposes its view then,
   * not in a later effect, or StrictMode trips the claimed-canvas `ViewError`.
   */
  const ref = useEvent((el: HTMLCanvasElement | null): void => {
    // eslint-disable-next-line react-hooks/immutability -- `live` is an intentionally mutable record held once per hook instance and never replaced; it tracks the pair's own bookkeeping and is never handed to a consumer.
    live.canvas = el
    if (el === null) {
      destroy()
      return
    }
    ensure()
  })

  const stage = scene.status === 'ready' ? scene.stage : null
  useEffect(() => {
    // eslint-disable-next-line react-hooks/immutability -- `live` is an intentionally mutable record held once per hook instance and never replaced; it tracks the pair's own bookkeeping and is never handed to a consumer.
    live.stage = stage
    if (stage === null) {
      destroy()
      return
    }
    ensure()
    return () => {
      live.stage = null
      destroy()
    }
  }, [stage, live, destroy, ensure])

  const play = useEvent(
    (from: PoseRef, to: PoseRef, options?: PlayOptions): Run<PlayResult> | null => {
      const view = core.view
      if (view === null) return null
      // A plain function, never `async` and never wrapped in one: `start` is emitted
      // synchronously inside `view.play` and a wrapper is exactly where that is lost.
      const run = view.play(from, to, { duration: latest().duration, ...options })
      store.bump()
      return run
    },
  )

  const stop = useEvent((): void => {
    core.view?.stop()
    store.bump()
  })

  const refresh = useEvent((): void => {
    core.view?.refresh()
    store.bump()
  })

  // Deliberately a fresh object per render: it carries the reactive snapshot (§2.1).
  return { ...snapshot, ref, play, stop, refresh }
}
