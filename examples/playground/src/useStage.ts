import { useCallback, useEffect, useRef, useState } from 'react'
import * as pc from '@paper-crumple/core'
import type { RefObject } from 'react'
import type { BuiltStage, DemoConfig } from './config'
import { buildStage } from './config'
import type { Sample } from './samples'
import { frameHero, mountHero } from './stage'
import type { KnobValues } from './knobs'
import { collectDescriptors, movesGeometry } from './knobs'

/**
 * The stage's whole lifecycle, in one hook.
 *
 * A factory option (`DemoConfig`) or a different sample rebuilds; a knob does not. That is the
 * §6.5 split, and it is why this effect depends on exactly those two things: everything else the
 * panel can change — every knob, the pose schedule — is applied to the live stage through the
 * callbacks below and reaches the next build via the refs this hook re-reads after each mount.
 *
 * A rebuild is not a reset: the knob values a reader has moved away from their defaults are
 * carried forward and re-applied once the new stage is up, and any key the new slot set no longer
 * declares is simply skipped (a `torn`-only knob after a switch to `hull`, say).
 */

export interface StageLive {
  readonly built: BuiltStage
  readonly view: pc.View | null
  /** The element the library paints into, so a swap can re-frame it without a rebuild. */
  readonly canvas: HTMLCanvasElement | null
  /** `stage.mount` end to end — the design's `pass b`. */
  readonly mountMs: number
  /** The front bake, which is where the hull runs — the design's `hull`, in `hull` mode. */
  readonly addMs: number
}

export interface StageStatus {
  readonly ok: boolean
  readonly text: string
}

export interface UseStageResult {
  readonly live: StageLive | null
  /**
   * The sprite the view is showing *now*, which is not a property of the build: `view.swapTo`
   * replaces it under a stage that never moved. Kept apart from `live` so re-reading it after a
   * swap does not look like a new build to everything that watches `live`.
   */
  readonly sprite: pc.Sprite | null
  /** Re-read that sprite once a `view.swapTo` has settled, rollback included. */
  readonly noteSwapped: () => void
  /**
   * Re-frame the canvas around whatever the view is drawing *now*, and redraw.
   *
   * A swap replaces the sprite under a stage that never rebuilt, and the new sprite brings its own
   * silhouette and its own paper reach — so the canvas has to be re-sized and re-offset around an
   * artwork box that is itself new. `View.frame` says where that box is, for the sprite that won
   * (the swap's target, or the one a rollback kept), so nothing has to be told which one did.
   */
  readonly reframe: () => void
  /** `null` once a rebuild has landed cleanly: the caller renders its own idle line then. */
  readonly status: StageStatus | null
  readonly setStatus: (status: StageStatus | null) => void
  /** Bumped after every landed rebuild, so consumers can re-read imperative library state. */
  readonly generation: number
  /** Write one knob to the live stage, remembering it for the next rebuild. */
  readonly setKnob: (key: string, value: string | number | boolean) => Error | undefined
  readonly knobs: KnobValues
  /** Drop every remembered knob and put the live stage back on its declared defaults. */
  readonly resetKnobs: () => void
  readonly seedKnobs: (values: KnobValues) => void
  /** Report a narrowed Error from outside the hook onto the same status pill. */
  readonly observed: (where: string, error: Error) => void
}

export function useStage(
  config: DemoConfig,
  sample: Sample,
  shown: Sample,
  slotRef: RefObject<HTMLElement | null>,
): UseStageResult {
  const [live, setLive] = useState<StageLive | null>(null)
  const [sprite, setSprite] = useState<pc.Sprite | null>(null)
  const [generation, setGeneration] = useState(0)
  const [status, setStatus] = useState<StageStatus | null>({ ok: true, text: 'booting…' })
  const [knobs, setKnobs] = useState<KnobValues>({})

  // Read, never depended on: a knob write must not rebuild the stage, but the next rebuild has to
  // see the value the reader left behind. Mirrored in effects rather than assigned during render,
  // and declared BEFORE the rebuild effect so a commit that changes both updates the mirror first.
  const knobsRef = useRef<KnobValues>({})
  const liveRef = useRef<StageLive | null>(null)
  useEffect(() => {
    knobsRef.current = knobs
  }, [knobs])
  useEffect(() => {
    liveRef.current = live
  }, [live])

  // Which sample is really on the stage, mirrored the same way and for the same reason: a swap
  // moves the sprite through `view.swapTo` without rebuilding, so `shown` drifts away from
  // `sample` and must not be depended on — a swap that rebuilt would undo its own animation. The
  // next rebuild, whatever triggers it, still mounts what the reader is looking at.
  const shownRef = useRef<Sample>(shown)
  useEffect(() => {
    shownRef.current = shown
  }, [shown])

  /**
   * Every narrowed Error this hook observes goes to the status pill and nowhere else — that is the
   * design's own error channel, and there is no second log surface to keep in sync with it.
   *
   * `errorsRef` counts them, so a caller can tell whether a library call it just made reported
   * something *through the event bus* on the way: a front-class `stage.set()` on an idle view
   * rebuilds synchronously inside the call (§8.8 demand 3), and a rebuild that refuses — a knob
   * dragged past the frozen reserve, "re-add required" (§8.6) — is an orphan (§10.6) that reaches
   * the pill through `stage.on('error')` *before* `set()` returns `undefined`. Without the count,
   * the "set" line written next silently covered the refusal.
   */
  const errorsRef = useRef(0)
  const observed = useCallback((where: string, error: Error) => {
    errorsRef.current += 1
    setStatus({ ok: false, text: `${where}: ${error.message}` })
  }, [])

  /**
   * The sprite the canvas's box was last framed around — only so a swap's `step` listener can
   * tell the step the sprite changes from every other one, rather than re-framing six times a
   * fold. `View.frame` itself remembers nothing and needs nothing remembered.
   */
  const framedRef = useRef<pc.Sprite | null>(null)

  const applyFrame = useCallback((): void => {
    const current = liveRef.current
    const slot = slotRef.current
    if (current === null || slot === null || current.view === null || current.canvas === null) {
      return
    }
    frameHero({
      view: current.view,
      slot,
      canvas: current.canvas,
      cssPx: current.built.artworkCssPx,
    })
    framedRef.current = current.view.sprite
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `slotRef` is a ref.
  }, [])

  /**
   * Re-frame after a write that moved the sprite's geometry, once that move has actually landed.
   *
   * A hull-tier knob (`minDist`, `maxDist`, `angularity`, `seed`) makes the next demand on the
   * front answer `SourceExpiredError`, which the stage turns into a **re-source** at the live
   * values — a new `SheetHandle`, and with it a new paper box for the sheet to be centred on. That
   * work is still in flight when `stage.set()` returns, so re-framing there reads the frame the
   * sprite is about to leave. `prepare(key)` is the one demand that joins a re-source rather than
   * returning around it, so it is the honest place to wait; the library redraws the idle view
   * itself, and the redraw below is for the managed backing store, which is only rewritten from
   * `getBoundingClientRect()` during a draw.
   */
  const settleFrame = useCallback(async (): Promise<void> => {
    const current = liveRef.current
    const sprite = current?.view?.sprite ?? null
    if (current === null || sprite === null) return
    const prepared = await current.built.stage.prepare(sprite.key)
    if (prepared === pc.ABORTED) return
    if (prepared instanceof Error) {
      observed('stage.prepare', prepared)
      return
    }
    applyFrame()
    current.view?.refresh()
  }, [applyFrame, observed])

  useEffect(() => {
    const controller = new AbortController()
    let owned: BuiltStage | null = null
    let offStep: (() => void) | null = null
    // Read once, here: the mirror effect above has already run for this commit.
    const mount = shownRef.current

    const run = async (): Promise<void> => {
      const built = await buildStage(
        config,
        (e) => {
          observed('stage error event', e.error)
        },
        controller.signal,
      )
      if (built === pc.ABORTED) return
      if (built instanceof Error) {
        observed('buildStage', built)
        setLive(null)
        setSprite(null)
        setStatus({ ok: false, text: `stage build failed: ${built.message}` })
        return
      }
      owned = built

      const slot = slotRef.current
      if (slot === null) {
        built.stage.dispose()
        owned = null
        setStatus({ ok: false, text: 'playground: the stage has no slot to mount into' })
        return
      }

      const mounted = await mountHero(built, mount, slot, controller.signal)
      if (mounted === pc.ABORTED) {
        // This build never went live, so nothing else will ever dispose it.
        built.stage.dispose()
        owned = null
        return
      }

      // A hero that refuses to mount is reported and then *kept*, not disposed: the knob
      // descriptors live on the two slots and exist the moment the stage is built — no sprite is
      // involved — so every control still renders and still writes, and the failure stays
      // explorable from the page it happened on.
      const hero = mounted instanceof Error ? null : mounted
      if (mounted instanceof Error) observed('mountHero', mounted)

      // Carry every knob the reader moved forward onto the new stage, skipping the keys this
      // slot set does not declare.
      const byKey = new Map(collectDescriptors(built).map((e) => [e.key, e.k]))
      const carried: Record<string, string | number | boolean> = {}
      let carriedMoved = false
      const errorsBefore = errorsRef.current
      for (const [key, value] of Object.entries(knobsRef.current)) {
        const k = byKey.get(key)
        if (k === undefined) continue
        carried[key] = value
        const applied = built.stage.set({ [key]: value } as never)
        if (applied instanceof Error) {
          observed(`stage.set ${key}`, applied)
          continue
        }
        carriedMoved ||= movesGeometry(k)
      }
      setKnobs(carried)
      const carriedRefused = errorsRef.current !== errorsBefore

      // `mountHero` framed this sprite already; from here the framing only moves when the sprite
      // does. The listener reads the closure's own `built`, `slot` and canvas rather than
      // `liveRef`, whose mirror effect has not run for this commit yet.
      framedRef.current = hero?.sprite ?? null
      if (hero !== null) {
        const { view, canvas } = hero
        offStep = view.on('step', () => {
          const next = view.sprite
          if (next === null || next === framedRef.current) return
          frameHero({ view, slot, canvas, cssPx: built.artworkCssPx })
          framedRef.current = next
        })
      }

      setSprite(hero?.sprite ?? null)
      setLive({
        built,
        view: hero?.view ?? null,
        canvas: hero?.canvas ?? null,
        mountMs: hero?.mountMs ?? 0,
        addMs: hero?.addMs ?? 0,
      })
      setGeneration((g) => g + 1)
      // Nothing to say about a clean build that the caller's own idle line does not say better —
      // and nothing to say over a carried knob the new stage just refused, either.
      if (mounted instanceof Error) {
        setStatus({ ok: false, text: `hero mount failed: ${mounted.message}` })
      } else if (!carriedRefused) {
        setStatus(null)
      }

      // The carry-forward above wrote hull-tier values onto a sprite `mountHero` had already
      // framed at this slot's defaults, so the same re-source a slider triggers happens here too —
      // once, on the way up. Settled with the closure's own values rather than through
      // `settleFrame`, because `liveRef`'s mirror effect has not run for this commit yet.
      if (carriedMoved && !carriedRefused && hero !== null) {
        const prepared = await built.stage.prepare(hero.sprite.key, { signal: controller.signal })
        if (prepared === pc.ABORTED || controller.signal.aborted) return
        if (prepared instanceof Error) {
          observed('stage.prepare', prepared)
          return
        }
        frameHero({ view: hero.view, slot, canvas: hero.canvas, cssPx: built.artworkCssPx })
        hero.view.refresh()
      }
    }

    void run()

    return () => {
      controller.abort()
      offStep?.()
      owned?.stage.dispose()
      // `owned` is null when the build was still in flight; the abort above is what stops it, and
      // the aborted branch disposes whatever it had already produced.
      if (owned !== null) {
        setLive(null)
        setSprite(null)
        liveRef.current = null
      }
    }
    // `slotRef` is a ref and `observed` is stable; the knob mirror is read, never depended on —
    // a knob write must not rebuild the stage. See the comment above the mirrors.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, sample, observed])

  const setKnob = useCallback(
    (key: string, value: string | number | boolean): Error | undefined => {
      const current = liveRef.current
      if (current === null) {
        const err = new Error('playground: no stage is built yet')
        observed('setKnob', err)
        return err
      }
      // §6.6: `stage.set` takes the whole invalidation ladder. On the erased `pc.BlitStage` /
      // `pc.DirectStage` types a runtime string key cannot be proved to be one of the slot's own,
      // so the patch is cast at the call site exactly as the library's own tests do; the runtime
      // registry is what actually enforces the scope, and a refused write comes back as an Error
      // rather than being filtered out before it reaches the library.
      const errorsBefore = errorsRef.current
      const result = current.built.stage.set({ [key]: value } as never)
      if (result instanceof Error) {
        observed(`stage.set ${key}`, result)
        return result
      }
      // The layer took the value either way — the panel keeps showing what the stage holds.
      setKnobs((prev) => ({ ...prev, [key]: value }))
      // A rebuild the write triggered may have refused it on the way — "re-add required" — and
      // said so on the pill already; that line stays, and there is no re-source to wait for.
      if (errorsRef.current !== errorsBefore) return undefined
      setStatus({ ok: true, text: `${key} set` })
      // Only a knob that can move the geometry pays for the join; a front-tier write leaves the
      // handle — and so the framing — exactly where it was.
      const entry = collectDescriptors(current.built).find((e) => e.key === key)
      if (entry !== undefined && movesGeometry(entry.k)) void settleFrame()
      return undefined
    },
    [observed, settleFrame],
  )

  const resetKnobs = useCallback(() => {
    const current = liveRef.current
    setKnobs({})
    if (current === null) return
    let moved = false
    const errorsBefore = errorsRef.current
    for (const { key, k } of collectDescriptors(current.built)) {
      const result = current.built.stage.set({ [key]: k.default } as never)
      if (result instanceof Error) {
        observed(`stage.set ${key}`, result)
        continue
      }
      moved ||= movesGeometry(k)
    }
    // One join for the whole batch: the re-source is per sprite, not per knob.
    if (moved && errorsRef.current === errorsBefore) void settleFrame()
  }, [observed, settleFrame])

  const seedKnobs = useCallback((values: KnobValues) => {
    setKnobs(values)
  }, [])

  const noteSwapped = useCallback(() => {
    setSprite(liveRef.current?.view?.sprite ?? null)
  }, [])

  const reframe = useCallback((): void => {
    applyFrame()
    // The managed backing store is written from `getBoundingClientRect()` *during a draw*, so a
    // box changed after the last one leaves the store describing the box before it. One
    // event-free redraw settles it.
    liveRef.current?.view?.refresh()
  }, [applyFrame])

  return {
    live,
    sprite,
    noteSwapped,
    reframe,
    status,
    setStatus,
    generation,
    setKnob,
    knobs,
    resetKnobs,
    seedKnobs,
    observed,
  }
}
