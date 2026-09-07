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
import { useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { acquire, pendingAcquisition, stageSignal } from './acquire.js'
import type { Crumple } from './crumple.js'
import {
  createCrumpleCore,
  onRunEnd,
  onRunStart,
  onRunStep,
  readCrumple,
  type CrumpleReading,
} from './crumple-state.js'
import type { CrumpleOptions, CrumpleSettleEvent, ReducedMotion } from './crumple-types.js'
import { artworkStyleFor, frameStyleFor } from './frame-style.js'
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
  const [store] = useState(() => createVersionedStore<CrumpleReading>(() => readCrumple(core)))
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
   * Derived, never mirrored (§2.7). A prop written into `core` from an effect is only published by
   * the NEXT bump, so `frameStyle` used to lag its own `frameTo` by one commit — and on the
   * entrance the one blit the view performs lands inside that lag, against a 0 × 0 element (§9.1).
   * `frameStyleFor` is pure and cheap; the memo exists so the value has a stable identity between
   * bumps, not to save the four multiplications.
   */
  const frameTo = o.frameTo
  const frameStyle = useMemo(
    () => frameStyleFor(snapshot.frame, frameTo),
    [snapshot.frame, frameTo],
  )

  /**
   * The same inputs, the same scale, the same `null` convention — derived here rather than
   * mirrored, for the reason `frameStyle` above is (§2.3, §2.7). One render publishes both, so a
   * layout that reserves the artwork box and a wrapper that takes the paper box can never be a
   * bump out of step with each other.
   */
  const artworkStyle = useMemo(
    () => artworkStyleFor(snapshot.frame, frameTo),
    [snapshot.frame, frameTo],
  )

  /**
   * "Apply the frame, then one event-free redraw" — the pairing `mountHero` had and the migration
   * dropped (§9.1). Under `size: 'managed'` the core writes `canvas.width/height` from
   * `getBoundingClientRect()` during a draw, and `managedBackingStore` returns `null` for a zero
   * box, so the entrance's one blit — which lands before the wrapper has any size at all — leaves
   * the default 300 × 150 store in place and the browser stretches it. A LAYOUT effect, because
   * the redraw has to see the box React committed in this very commit; a passive effect measures
   * the same 0 × 0.
   *
   * Keyed on the two box strings and NOT on `frameStyle` or `snapshot.frame`: `View.frame` returns
   * a fresh object per read, so both have a new identity at every bump and an effect keyed on
   * either would redraw on every step of every run. The values move only when the front or
   * `frameTo` moves, and a blit view's frame does not depend on the canvas size, so this cannot
   * feed itself.
   *
   * No `store.bump()`: a redraw of the pose already on screen changes nothing a consumer reads,
   * and bumping here would re-enter this render path for nothing.
   *
   * One implicit coupling this key rests on: it is `frameStyle`, i.e. `frame.box * scale`, while a
   * consumer is free to size its slot from a DIFFERENT box — the playground's `heroSlotStyle` uses
   * `frameArtwork(frame, cssPx).image` (`examples/playground/src/hero.ts:42-46`). The two co-vary
   * today because they share their inputs, so the key does fire in the commit that resizes the
   * slot; but a consumer whose box is NOT co-variant with `frameStyle` — or who passes no
   * `frameTo` at all, leaving `frameStyle` null — gets no redraw from here, and is left to the
   * core's own deferred sizing on the next blit (`packages/core/src/stage.ts:1058-1073`).
   */
  const frameWidth = frameStyle?.width ?? null
  const frameHeight = frameStyle?.height ?? null
  useLayoutEffect(() => {
    if (frameWidth === null || frameHeight === null) return
    core.view?.refresh()
  }, [frameWidth, frameHeight, core])

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

  const dispatchSettle = useEvent((e: CrumpleSettleEvent): void => {
    o.onSettle?.(e)
  })

  /**
   * The one place a request ends (§2.1). Every success path and every failure path of the sprite
   * driver funnels through it, which is what makes "exactly once per request" a property of the
   * code rather than of four call sites agreeing.
   *
   * `seq` is the whole of "never for a superseded or unmounted request": supersession bumps
   * `live.seq` in `syncSprite` and `destroy()` bumps it too, so a continuation that settles after
   * either one carries a stale `seq` and stops here. `core.pending` is deliberately not consulted
   * — a request superseded a microtask before its own settlement would otherwise clear its
   * successor's `pending` on the way past.
   *
   * The error, when there is one, takes the same two routes it always did: `crumple.error` and
   * `onError` with `observed: true` (§7). `onSettle` is a third exit for the SAME value, and §7's
   * telemetry filter on `!observed` is what stops it being counted twice.
   */
  const settle = useEvent(
    (seq: number, key: string, error: Error | null, reduced: boolean): void => {
      if (seq !== live.seq) return
      // eslint-disable-next-line react-hooks/immutability -- `core` is an intentionally mutable record held once per hook instance and never replaced; `store.bump()` publishes each write (§5.5).
      core.pending = null
      if (error !== null) core.error = error
      store.bump()
      if (error !== null) dispatchError({ error, observed: true, view: core.view })
      dispatchSettle({ key, error, reduced })
    },
  )

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
        // Read once, on the path this request actually took, and carried into the payload: it is
        // the accommodation that applied, not "did anything animate" (§2.1).
        const reduced = prefersReducedMotion(opts.reducedMotion)
        if (got instanceof Error) {
          settle(seq, opts.spriteKey, got, reduced)
          return
        }
        const refused = view.show(got)
        if (refused !== undefined) {
          settle(seq, opts.spriteKey, refused, reduced)
          return
        }
        // An `entrance: 'uncrumple'` under `reduce` is `'flat'`: `show()` is one draw, with no run
        // and no start/step/end triple, which is why nothing downstream needs its own branch. It
        // still SETTLES — it is a request that reached an outcome — and this is the fourth clear
        // site §2.1's "three sites" gloss omits.
        if (opts.entrance !== 'uncrumple' || reduced) {
          settle(seq, opts.spriteKey, null, reduced)
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
        // eslint-disable-next-line react-hooks/immutability -- `core` is an intentionally mutable record held once per hook instance and never replaced; `store.bump()` publishes each write (§5.5).
        core.pending = { key: opts.spriteKey, phase: 'entering', run }
        store.bump()
        void run.done.then((result) => {
          settle(seq, opts.spriteKey, result instanceof Error ? result : null, false)
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
      const reduced = prefersReducedMotion(opts.reducedMotion)
      if (reduced) {
        // `show()` IS the degraded swap — instant, pose 0, no run — so the accommodation needs no
        // API of its own, and it goes through `acquire` exactly as the entrance does. It emits no
        // `end`, which is exactly why `onSettle` and not `onEnd` is what a consumer branches on.
        void (async () => {
          const got = await acquire(stage, opts.spriteKey, opts.src, opts.pin, controller.signal)
          if (got === ABORTED || seq !== live.seq) return
          if (got instanceof Error) {
            settle(seq, opts.spriteKey, got, true)
            return
          }
          const refused = view.show(got)
          if (refused !== undefined) {
            settle(seq, opts.spriteKey, refused, true)
            return
          }
          settle(seq, opts.spriteKey, null, true)
        })()
        return
      }

      // The in-flight map gates `swapTo` too: a concurrent second `swapTo` on a key whose `add` is
      // still in flight is refused by `reserved`, which is private to the core. Joining the
      // existing acquisition and handing the promise to `crumpleTo` is the same park, and costs
      // one ingest rather than two. Named `pendingAdd`, not `pending`: `pending` is the snapshot
      // field now, and one of the two shadowing the other in this function would be a trap.
      const pendingAdd = pendingAcquisition(stage, opts.spriteKey)
      const run =
        pendingAdd === undefined
          ? view.swapTo(opts.src, {
              key: opts.spriteKey,
              duration: opts.duration,
              signal: controller.signal,
            })
          : view.crumpleTo(pendingAdd, { duration: opts.duration, signal: controller.signal })
      // eslint-disable-next-line react-hooks/immutability -- `core` is an intentionally mutable record held once per hook instance and never replaced; `store.bump()` publishes each write (§5.5).
      core.pending = { key: opts.spriteKey, phase: 'swapping', run }
      store.bump()
      void run.done.then((result) => {
        // A swap whose target fails rolls back to the previous sprite and the Run returns the
        // target's Error, so the prop says B while the canvas shows A. `settle` puts it on
        // `crumple.error` and through `onError` — the route it always took — and hands it to
        // `onSettle` as the outcome of this request. Reported, never retried automatically: a
        // retry policy inside an animation library is a network policy nobody asked for, which is
        // what `retry()` is for (§2.6). `ABORTED` is a sentinel and not an `Error`, so a stopped
        // swap settles with `error: null`.
        settle(seq, opts.spriteKey, result instanceof Error ? result : null, false)
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
    // The request opens here, before the path is known; `enter`/`swap` refine the phase and hang
    // the typed run on it as soon as there is one (§2.1).
    core.pending = { key, phase: 'acquiring', run: null }
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

  /**
   * The escape from a rolled-back key (§2.6). Clearing `synced` IS the bypass: it is the only
   * thing refusing the re-request, and `syncSprite` rebuilds everything else — a new `seq`, a new
   * controller, a fresh `pending` — from the current options.
   */
  const retry = useEvent((): void => {
    const view = core.view
    if (view === null) return
    // eslint-disable-next-line react-hooks/immutability -- `core` is an intentionally mutable record held once per hook instance and never replaced; `store.bump()` publishes each write (§5.5).
    core.synced = null
    syncSprite(view)
  })

  const view = snapshot.view
  const { spriteKey, src } = o
  useEffect(() => {
    if (view === null) return
    syncSprite(view)
  }, [view, spriteKey, src, syncSprite])

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
      // A detach that leaves `knobEpoch` unmoved — the scene leaving `ready` disposes the view
      // without bumping the epoch — never runs this effect's cleanup, so `cancelled` alone is not
      // enough: `core.view` may already have moved past `active` by the time this settles.
      if (cancelled || core.view !== active) return
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
    core.pending = null
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

  const draw = useEvent((pose: PoseRef): void => {
    const view = core.view
    if (view === null) return
    view.draw(pose)
    store.bump()
  })

  const sync = useEvent((): void => {
    store.bump()
  })

  // Deliberately a fresh object per render: it carries the reactive snapshot (§2.1).
  return { ...snapshot, frameStyle, artworkStyle, ref, play, stop, refresh, draw, sync, retry }
}
