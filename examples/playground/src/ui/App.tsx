import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import * as pc from '@paper-crumple/core'
import { fitSheet } from '@paper-crumple/motion'
import type { Pack } from '@paper-crumple/motion'
import { evenKeyFrames } from '@paper-crumple/motion'
import type { EdgeSpec } from '@paper-crumple/paper'
import { PaperScene } from '@paper-crumple/react'

import type { AudioHandle, SyncMode } from '../audio'
import { createAudio, playSpec, swapSpec } from '../audio'
import type { BucketName, DemoConfig } from '../config'
import { DEFAULT_CONFIG } from '../config'
import { collectDescriptors } from '../knobs'
import { droppedSample, swapDurationFor, useHero, SWAP_DURATION_MS } from '../hero'
import { useDemoScene } from '../scene'
import { BROKEN_URL, DEFAULT_SAMPLE_ID, SAMPLES } from '../samples'
import type { Sample } from '../samples'
import { decodeState, encodeState } from '../state'
import { prefetchSamples, glInfo } from '../stage'

import { Diagnostics } from './Diagnostics'
import type { Metric } from './Diagnostics'
import { EdgeSection } from './EdgeSection'
import { Header } from './Header'
import { FactorySection, KnobRows, libraryGroups } from './LibrarySections'
import { LookSection } from './LookSection'
import type { StageBackground } from './LookSection'
import { PosesSection, MAX_POSES, MIN_POSES } from './PosesSection'
import { SoundSection } from './SoundSection'
import { BROKEN_ID, bucketForPacks, SourceSection } from './SourceSection'
import { Stage } from './Stage'
import { Transport } from './Transport'
import { Section } from './primitives'

/** What a run gets when sound is off or silent — the fold has to last *something*. */
const FOLD_DURATION_MS = 900

const BROKEN_SAMPLE: Sample = {
  id: BROKEN_ID,
  label: 'broken URL (rollback demo)',
  url: BROKEN_URL,
}

type SectionKey = 'source' | 'edge' | 'poses' | 'sound' | 'look'

const BOOT_SAMPLE: Sample = SAMPLES.find((s) => s.id === DEFAULT_SAMPLE_ID) ?? SAMPLES[0]

function sameList(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

/**
 * The "sample" `<select>`'s next bound value. `SourceSection`'s picker only ever renders an
 * `<option>` per `SAMPLES` entry (`ui/SourceSection.tsx:94`) — a dropped file's `dropped-N` id, or
 * the rollback demo's `broken` id, has no matching option, which desyncs a controlled `<select>`
 * and prints a React warning. `target` wins only when it is a library sample; anything else keeps
 * whatever was remembered, exactly like the pre-migration two-state version, where a dropped file
 * never touched the state the picker read (`075dc4e:ui/App.tsx`'s `onDropImage` called `swapTo`
 * directly and never `setSample`).
 */
export function nextLibrarySample(current: Sample, target: Sample): Sample {
  return SAMPLES.some((s) => s.id === target.id) ? target : current
}

/** The status line the pill shows: what the last action did, or `null` for the idle readout. */
export interface StageStatus {
  readonly ok: boolean
  readonly text: string
}

export function App(): ReactNode {
  // --- boot state, scene and hero ----------------------------------------------------------------

  // The fragment a reader may have opened this page with, decoded exactly once. A malformed one
  // falls back to `DEFAULT_CONFIG` rather than producing a blank page.
  const boot = useMemo(() => decodeState(location.hash), [])
  const [config, setConfig] = useState<DemoConfig>(
    boot instanceof Error ? DEFAULT_CONFIG : boot.config,
  )

  /**
   * The picture on screen. ONE state, not two: under `useStage` a different SAMPLE rebuilt the
   * stage because `mountHero` mounted it, and `shown` tracked what a swap had moved to. `create`
   * does not read the sample, and §4.1 says to put in `deps` only what `create` reads — so the
   * sample left `deps`, and a source pick is a swap now.
   */
  const [shown, setShown] = useState<Sample>(BOOT_SAMPLE)
  /** The "sample" picker's own bound value — see `nextLibrarySample`. Kept alongside the collapsed
   *  `shown` state rather than reviving the pre-migration two-state split. */
  const [librarySample, setLibrarySample] = useState<Sample>(BOOT_SAMPLE)
  const [status, setStatus] = useState<StageStatus | null>({ ok: true, text: 'booting…' })

  const onObserved = useCallback((where: string, error: Error): void => {
    setStatus({ ok: false, text: `${where}: ${error.message}` })
  }, [])

  const { scene, built, knobs, setKnob, resetKnobs, seedKnobs } = useDemoScene(config, onObserved)
  const generation = scene.generation

  // One controller for the life of the page — the handle owns an AudioContext and decoded buffers,
  // and a second one would be a second context.
  const [audio] = useState<AudioHandle>(() => createAudio(onObserved))

  const [direction, setDirection] = useState<'folding' | 'unfolding' | null>(null)
  /** The swap's wall time, written in the click that starts it. Both writes land in one batch, so
   *  the effect the commit schedules reads the new value when it starts the swap. */
  const [swapDuration, setSwapDuration] = useState(SWAP_DURATION_MS)
  /** True between the click that starts a swap and the settle that ends it, so the ENTRANCE does
   *  not print "swapped to …" on the way up. */
  const swappingRef = useRef(false)

  /** The swap-settle pair: the sound stops and the transport stops printing a direction. Shared by
   *  the reduced-motion backstop below, `useHero`'s own `onEnd`, and `runFold`'s completion. `audio`
   *  is stable for the life of the page (`useState`'s lazy initialiser runs once), so depending on
   *  it directly is exactly as stable as a ref would have been. */
  const endSwap = useCallback((): void => {
    audio.endSequence()
    setDirection(null)
  }, [audio])

  const { crumple, slotStyle } = useHero({
    scene,
    built,
    shown,
    duration: swapDuration,
    onEnd: endSwap,
    observed: onObserved,
  })

  const sprite = crumple.view?.sprite ?? null

  useEffect(() => {
    if (!(boot instanceof Error)) seedKnobs(boot.knobs)
    // A malformed fragment is reported once, on mount — there is no external store to subscribe
    // to instead, and the alternative is silently discarding the reader's own bad link.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    else onObserved('decodeState', boot)
    // Once, before the first rebuild lands — `useDemoScene` re-applies it on the way up.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // --- sound --------------------------------------------------------------------------------------

  const [audioSnapshot, setAudioSnapshot] = useState(() => audio.snapshot())
  useEffect(
    () =>
      audio.subscribe(() => {
        setAudioSnapshot(audio.snapshot())
      }),
    [audio],
  )

  // --- status: the settle backstop and the two error/failure effects ------------------------------

  /**
   * The swap settled. `onEnd` covers the animated path; this covers the reduced-motion one, where
   * `show()` is the whole swap — one draw, no run, no start/step/end triple — and emits nothing at
   * all. The placeholder only lifts because the binding versions its own store; there is no event
   * behind it (USAGE §7). Without this the audio sequence would never be closed under `reduce`.
   */
  useEffect(() => {
    if (crumple.shown === null || !swappingRef.current) return
    swappingRef.current = false
    endSwap()
    // Reporting the settle onto the status pill IS the synchronization this effect exists for —
    // there is no external store to read it from instead (USAGE §7's own point).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (crumple.shown === shown.id) setStatus({ ok: true, text: `swapped to ${shown.label}` })
  }, [crumple.shown, endSwap, shown.id, shown.label])

  /** A swap whose target failed rolled back to the previous sprite, and the hook reports the
   *  target's Error rather than retrying: the prop says B while the canvas shows A. `error` is
   *  cleared when the next run starts, so this pill clears itself on the next interaction. */
  useEffect(() => {
    const failed = crumple.error
    if (failed === null) return
    swappingRef.current = false
    // The status pill IS the sync target for `crumple.error` — there is nowhere else this reads
    // from and nothing to subscribe to instead.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStatus({
      ok: false,
      text: `swap failed, rolled back to the previous sprite: ${failed.message}`,
    })
  }, [crumple.error])

  /** A lost context also moves `status` to `'failed'` (§4.1), and a failed scene hands out a stage
   *  on which nothing works — so the pill says so rather than printing an idle readout. */
  useEffect(() => {
    if (scene.status !== 'failed') return
    // Same as above: the status pill is the sync target for `scene.status`, not derived data a
    // render could compute instead — a failed scene is a real external event.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStatus({
      ok: false,
      text: scene.lost
        ? 'the WebGL2 context was lost — reload to rebuild'
        : `stage build failed: ${scene.error?.message ?? 'unknown'}`,
    })
  }, [scene.status, scene.lost, scene.error])

  // --- panel state ----------------------------------------------------------------------------

  const [open, setOpen] = useState<Record<SectionKey, boolean>>({
    source: true,
    edge: true,
    poses: false,
    sound: false,
    look: false,
  })
  const [openExtra, setOpenExtra] = useState<Record<string, boolean>>({})
  const [swapTarget, setSwapTarget] = useState<string>(
    SAMPLES.find((s) => s.id !== shown.id)?.id ?? BROKEN_ID,
  )
  const [background, setBackground] = useState<StageBackground>('dark')

  const toggle = useCallback((key: SectionKey) => {
    setOpen((prev) => ({ ...prev, [key]: !prev[key] }))
  }, [])

  // Opening "04 Sound" is the gesture that lets the manifest be fetched and the AudioContext
  // start `running`; nothing audio-related happens before it.
  useEffect(() => {
    if (open.sound) audio.probe()
  }, [open.sound, audio])

  // --- pose, transport and playback ------------------------------------------------------------

  /** The interval between two consecutive scheduled renders of the last run. `step.ms` is
   *  elapsed-since-`start`, not a per-step cost (`runner.ts`'s `stepOnce`), so the interval is
   *  the difference of two of them — which is what the scheduler actually spent on that pose. */
  const [lastStepMs, setLastStepMs] = useState<number | null>(null)
  const stepAtRef = useRef<number | null>(null)
  /** A draw-only pose change, timed around the `view.draw(...)` call itself. */
  const [lastDrawMs, setLastDrawMs] = useState<number | null>(null)

  const dwells = built?.motion.poses?.dwells ?? pc.DWELL_MS

  const pose = crumple.pose

  /** The `step` interval the footer prints. The binding does not surface it, and the raw view is
   *  exposed for exactly this kind of unforeseen read. */
  const view = crumple.view
  useEffect(() => {
    if (view === null) return
    stepAtRef.current = null
    // `step` alone leaves `stepAtRef` spanning two runs — a fold that ends and a later one that
    // starts both feed the same interval, which is not what "the last run's interval" means. `view`
    // is a fresh object each rebuild, and this effect re-subscribes with it, but a run inside one
    // build still crosses a `start` without the effect re-running — so the reset also has to live
    // on the event itself.
    const offStart = view.on('start', () => {
      stepAtRef.current = null
    })
    const offStep = view.on('step', (e) => {
      const previous = stepAtRef.current
      stepAtRef.current = e.ms
      if (previous !== null) setLastStepMs(e.ms - previous)
    })
    return () => {
      offStart()
      offStep()
    }
  }, [view])

  const refresh = crumple.refresh
  const draw = useCallback(
    (next: number) => {
      if (view === null) return
      const startedAt = performance.now()
      view.draw(next)
      setLastDrawMs(performance.now() - startedAt)
      // `view.draw` is draw-only and emits nothing, so the binding's store has no reason to bump
      // and `crumple.pose` would stay stale. `refresh()` is the only re-read the instance offers,
      // and it forces a redraw on the way — one draw more than this needs.
      refresh()
    },
    [refresh, view],
  )

  /** `'flat'` / `'ball'` are input-only names; the audio schedule is computed by index, so the
   *  same resolution has to happen here first — against the *bound* schedule's length. */
  const poseIndex = useCallback(
    (ref: pc.PoseRef): number => {
      if (ref === 'flat') return 0
      if (ref === 'ball') return dwells.length - 1
      return ref
    },
    [dwells],
  )

  const play = crumple.play
  const runFold = useCallback(
    async (from: pc.PoseRef, to: pc.PoseRef): Promise<void> => {
      // The pre-migration `runFold` (`075dc4e:ui/App.tsx:303`) returned on a null `view` before
      // ever touching audio — `play(...)` returns null for exactly the same reason `view` was
      // null there (`use-crumple.ts`'s `play` checks `core.view === null`), so checking `view`
      // here, before `audio.beginSequence`, reproduces that guard: a Space press before the stage
      // is ready plays no clip and leaves nothing pending.
      if (view === null) return
      const fromIdx = poseIndex(from)
      const toIdx = poseIndex(to)
      if (fromIdx === toIdx) return

      // Synchronous, inside the click: that is what lets the AudioContext resume under the autoplay
      // policy, and it hands back the clip's length as the run's `duration`. One `duration` is the
      // whole of the sync — the library spreads it over the traversed dwells.
      const duration = audio.beginSequence(playSpec(fromIdx, toIdx, '', dwells))
      setDirection(toIdx > fromIdx ? 'folding' : 'unfolding')
      // A plain function, never awaited above the call: `start` is emitted synchronously inside
      // `view.play`, and a wrapper is exactly where that guarantee is lost (§5.1).
      const run = play(from, to, { duration: duration ?? FOLD_DURATION_MS })
      if (run === null) {
        // Reached only if `view` went away between the check above and this call — audio was
        // already begun, so it has to be ended through the shared callback, not a bare
        // `setDirection(null)`, or `audio`'s `pending` is left set with nothing to close it.
        endSwap()
        return
      }
      const r = await run
      endSwap()
      if (r === pc.ABORTED) return
      if (r instanceof Error) {
        onObserved('crumple.play', r)
        return
      }
      refresh()
    },
    [audio, dwells, endSwap, onObserved, play, poseIndex, refresh, view],
  )

  // --- pose schedule --------------------------------------------------------------------------

  /** The pack the selects are built from. Every built-in pack stores the same twelve frames and
   *  `setPoses` checks a draft against every resident pack anyway, so the first resident one is as
   *  good as any. */
  const pack = useMemo(
    () => built?.motion.packs()[0] ?? null,
    // `generation` is what makes this re-read after a rebuild swaps the slot underneath.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [built, generation],
  )
  /** `null` means "whatever the pack's manifest says"; anything else is the reader's own draft,
   *  and it survives a rebuild the way the open sections do. */
  const [draft, setDraft] = useState<readonly number[] | null>(null)
  const keyFrames = useMemo(
    () => draft ?? (pack === null ? [] : [...pack.keyFrames]),
    [draft, pack],
  )

  /** Applies a draft, or lets the library refuse it and says why. */
  const applyPoses = useCallback(
    (draftPoses: readonly number[], resident: Pack): boolean => {
      if (built === null) return false
      // A run in flight keeps the plan it started with and would render its remaining poses
      // through the new key frames, so every run stops first and every view goes back to pose 0,
      // which exists in every schedule. `scene.stop` is the stable method; `scene` itself is a
      // fresh object on every `knobEpoch` bump and must not be a dependency here.
      scene.stop({ all: true })
      const manifest = sameList(draftPoses, resident.keyFrames)
      const refused = built.motion.setPoses(manifest ? null : { keyFrames: [...draftPoses] })
      if (refused !== undefined) {
        setStatus({ ok: false, text: `rejected: ${refused.message}` })
        return false
      }
      view?.draw('flat')
      refresh()
      return true
    },
    // `scene.stop` only, not `scene`: the analyzer does not narrow a called member expression
    // (`scene.stop({...})`) the way it narrows a plain property read, so it still asks for the
    // base identifier — but `scene`'s identity moves on every `knobEpoch` bump
    // (`use-paper-scene.ts:251,284`), and depending on the object would re-run this effect, and
    // everything that closes over it, on every knob write.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [built, refresh, scene.stop, view],
  )

  // Re-point the schedule at the stage a rebuild just produced. A rebuild is a fresh
  // `bakedMotion()` with no override, so whatever draft the reader was editing is re-applied here.
  useEffect(() => {
    if (built === null || pack === null) return
    // The only state this can touch is the status pill, and only when the library REFUSES the
    // draft — which is the one thing a reader must be told about a schedule that did not take.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    applyPoses(keyFrames, pack)
    // Only when a new stage lands: `keyFrames` changing from an edit is applied by the edit itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generation, built, pack])

  const commitKeyFrames = useCallback(
    (draft: readonly number[]) => {
      if (pack === null) return
      if (!applyPoses(draft, pack)) return
      setDraft(draft)
      setStatus({
        ok: true,
        text: `key frames ${draft.map((s) => pack.frames[s]?.index ?? s).join(' → ')}`,
      })
    },
    [applyPoses, pack, setStatus],
  )

  const onCountChange = useCallback(
    (count: number) => {
      if (pack === null) return
      const clamped = Math.max(MIN_POSES, Math.min(MAX_POSES, count))
      const even = evenKeyFrames(clamped, pack.frameCount)
      if (even instanceof Error) {
        setStatus({ ok: false, text: even.message })
        return
      }
      commitKeyFrames(even)
    },
    [commitKeyFrames, pack, setStatus],
  )

  const onKeyFrameChange = useCallback(
    (pose: number, slot: number) => {
      const next = [...keyFrames]
      next[pose] = slot
      commitKeyFrames(next)
    },
    [commitKeyFrames, keyFrames],
  )

  const poseCount = keyFrames.length > 0 ? keyFrames.length : dwells.length
  const lastPose = poseCount - 1

  // --- swap ------------------------------------------------------------------------------------

  /**
   * The swap, as a state change.
   *
   * The audio still begins in the click — `beginSequence` resumes the AudioContext under the
   * autoplay policy and hands back the clip's length — and both writes land in one batch, so the
   * effect the commit schedules starts the swap at the new duration.
   *
   * There is no controller here any more: `useCrumple` supersedes its own previous acquisition and
   * run by sequence number, which is also what aborts the `add` a superseded swap started.
   */
  const startSwap = useCallback(
    (target: Sample) => {
      const duration = audio.beginSequence(swapSpec(crumple.pose, dwells))
      setSwapDuration(swapDurationFor(duration))
      setDirection('folding')
      swappingRef.current = true
      setShown(target)
      setLibrarySample((prev) => nextLibrarySample(prev, target))
    },
    [audio, crumple.pose, dwells],
  )

  const onSwap = useCallback(() => {
    const target =
      swapTarget === BROKEN_ID ? BROKEN_SAMPLE : SAMPLES.find((s) => s.id === swapTarget)
    if (target === undefined) return
    startSwap(target)
    // The pre-migration guard (App.tsx:398, pre-rewire) skipped BOTH `setShown` and
    // `setSwapTarget` once `swapTarget` was already `BROKEN_ID` — `sampleId` above restores the
    // first half; this restores the second, so a rollback demo leaves the "swap to" select on
    // "broken URL" instead of advancing it.
    if (swapTarget === BROKEN_ID) return
    setSwapTarget(SAMPLES.find((s) => s.id !== target.id)?.id ?? BROKEN_ID)
  }, [startSwap, swapTarget])

  const dropSeq = useRef(0)
  const onDropImage = useCallback(
    (file: File) => {
      dropSeq.current += 1
      // The blob URL is deliberately NOT revoked when the swap settles. The pair guard keeps the
      // (key, src) pair for the life of the component and compares by identity, and `useCrumple`
      // re-acquires the key across a scene rebuild (§5.2) — which would then read a revoked URL.
      // One live blob URL per drop is the price of the declarative source.
      startSwap(droppedSample(file, URL.createObjectURL(file), dropSeq.current))
    },
    [startSwap],
  )

  // --- keyboard ---------------------------------------------------------------------------------

  const busy = direction !== null

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const tag = e.target instanceof HTMLElement ? e.target.tagName.toLowerCase() : ''
      if (tag === 'input' || tag === 'select' || tag === 'textarea') return
      if (busy) return
      if (e.key === 'ArrowRight') {
        draw(Math.min(lastPose, pose + 1))
        e.preventDefault()
      } else if (e.key === 'ArrowLeft') {
        draw(Math.max(0, pose - 1))
        e.preventDefault()
      } else if (e.key === ' ') {
        void (pose >= lastPose ? runFold('ball', 'flat') : runFold('flat', 'ball'))
        e.preventDefault()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [busy, draw, lastPose, pose, runFold])

  // --- prefetch ------------------------------------------------------------------------------

  useEffect(() => {
    if (built === null) return
    const controller = new AbortController()
    // Through the built stage, and safe: the binding's `acquire` retries a live-key refusal through
    // `prepare`, which joins the winner of the race rather than failing a correct sequence. The
    // returned map is deliberately dropped — the binding's own in-flight registry is what a swap
    // joins now.
    prefetchSamples(built, shown, controller.signal)
    return () => {
      controller.abort()
    }
    // Only when a new stage lands. A swap must not re-run the prefetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generation, built])

  // --- derived ----------------------------------------------------------------------------------

  const entries = useMemo(() => (built === null ? [] : collectDescriptors(built)), [built])
  const groups = useMemo(() => libraryGroups(entries), [entries])

  /**
   * Which baked bucket this silhouette actually lands in — the design calls it `bucketShown` and
   * derives it from the picker, mapping its own `auto` to `1x1` because that is what `auto` picks
   * for the sheet it draws. Here the real fit answers the same question for the sprite that is
   * really mounted, so `auto` names whichever bucket was really chosen rather than a fixed guess.
   */
  const fit = useMemo(() => {
    if (sprite === null) return null
    const override = config.packs.length === 1 ? config.packs[0] : null
    const result = fitSheet(sprite.rect.w, sprite.rect.h, override)
    return result instanceof Error ? null : result
  }, [config.packs, sprite])

  const bucketShown = fit?.bucket ?? bucketForPacks(config.packs) ?? config.packs.join('+')

  const storedFrames = useMemo(() => (pack === null ? [] : pack.frames.map((f) => f.index)), [pack])
  const frameFor = useCallback(
    (slot: number | undefined): number => (slot === undefined ? 0 : (storedFrames[slot] ?? 0)),
    [storedFrames],
  )

  const keyFrameLine =
    keyFrames.length === 0
      ? 'key frames —'
      : `key frames ${keyFrames.map((s) => frameFor(s)).join(' → ')}`

  /**
   * What the stage chip and the "source" summary show — NOT the picker (that binds to
   * `librarySample.id`, above). `shown` is the state that DRIVES the request — it becomes the
   * broken sample the instant a rollback demo is clicked, so `crumple.shown` (the sprite key
   * `<Crumple>` is really showing) is read instead: a rollback leaves it at the PREVIOUS sprite's
   * key, which is what App.tsx:398's old `swapTarget === BROKEN_ID` guard also kept the chip on.
   * Before anything has ever landed, `crumple.shown` is `null` and `shown.id` (the request in
   * flight) is the only thing there is to show.
   */
  const sampleId = crumple.shown ?? shown.id

  /** The design's two decimals, but only while they fit: past 10 ms the tile is 150px wide and
   *  the second decimal is what pushes the value into an ellipsis. */
  const msText = (v: number): string => (v < 10 ? v.toFixed(2) : v.toFixed(1))

  /**
   * `mountMs` re-derived. `useStage` timed `mountHero` around its own `add` + `view` + `show`, and
   * printed the front bake (`addMs`) separately. `useCrumple` owns the `add` now and reports no
   * timing, so what is left to measure is scene-ready → the first sprite on screen. The front bake
   * on its own has no seam left; the `hull` tile prints an em dash and says why.
   */
  const [mountMs, setMountMs] = useState<number | null>(null)
  const readyAtRef = useRef<number | null>(null)
  useEffect(() => {
    readyAtRef.current = scene.status === 'ready' ? performance.now() : null
    // Clearing the previous build's reading is the sync this effect exists for; the fresh
    // measurement is written by the effect below once a sprite actually lands.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMountMs(null)
  }, [scene.status, generation])
  useEffect(() => {
    const startedAt = readyAtRef.current
    if (crumple.shown === null || startedAt === null) return
    setMountMs((prev) => prev ?? performance.now() - startedAt)
  }, [crumple.shown])

  const metrics = useMemo((): Metric[] => {
    if (built === null || sprite === null) {
      return [
        { label: 'texture', value: '—' },
        { label: 'sheet', value: '—' },
        { label: 'bucket / stretch', value: '—' },
        { label: 'pass a / mount', value: '—' },
        { label: 'hull', value: '—' },
        { label: 'draw / step', value: '—' },
      ]
    }
    const fitText = fit ?? '—'
    return [
      {
        label: 'texture',
        value: `${String(sprite.frontSize.w)} × ${String(sprite.frontSize.h)}`,
        title: 'the front texture the sheet is baked into',
      },
      {
        label: 'sheet',
        value:
          typeof fitText === 'string'
            ? fitText
            : `${String(Math.round(fitText.sheetW))} × ${String(Math.round(fitText.sheetH))} px`,
        title: "the baked sheet stretched onto the silhouette's bounding box",
      },
      {
        label: 'bucket / stretch',
        value:
          typeof fitText === 'string'
            ? fitText
            : `${fitText.bucket} · ×${fitText.stretch.toFixed(3)}${fitText.clamped ? ' (clamped)' : ''}`,
        title: 'which baked bucket this silhouette lands in, and its non-uniform stretch',
      },
      {
        label: 'pass a / mount',
        value: `${msText(built.buildMs)} / ${mountMs === null ? '—' : msText(mountMs)} ms`,
        title:
          'a: paperStage + both slots · mount: scene ready → the first sprite on screen, timed ' +
          'here because useCrumple owns the add() inside it',
      },
      {
        label: 'hull',
        // The front bake used to be timed on its own, around `stage.add`. `useCrumple` owns that
        // call now and reports no timing, and there is no seam left to measure it at.
        value: '—',
        title: 'the front bake — no longer separately timeable: the binding owns add()',
      },
      {
        // The design's tile here reads "draw / upload". Nothing in the library reports an upload
        // separately — the front upload happens inside `add()`, which the `hull` tile above
        // already times — so this pairs the two per-frame numbers that ARE measurable and says so
        // in its own label rather than printing something else under the design's.
        label: 'draw / step',
        value: `${lastDrawMs === null ? '—' : msText(lastDrawMs)} / ${
          lastStepMs === null ? '—' : msText(lastStepMs)
        } ms`,
        title:
          'draw: one draw-only pose change, timed here · step: the last run’s interval between ' +
          'two scheduled renders',
      },
    ]
  }, [built, fit, lastDrawMs, lastStepMs, mountMs, sprite])

  /**
   * The design's own idle status: what the stage is, not what the last action was. `useDemoScene`
   * reports `null` for a clean build precisely so this line can take over, and every later action
   * — a knob write, a refused pose draft, a failed swap — overwrites it until the next rebuild.
   */
  const shownStatus: StageStatus =
    status ??
    (built === null || pack === null
      ? { ok: true, text: 'booting…' }
      : {
          ok: true,
          text:
            `bucket ${bucketShown} · ${String(pack.frameCount)} stored frames` +
            (scene.warnings.length === 0 ? '' : ` · ${String(scene.warnings.length)} warnings`),
        })

  const transportReadout =
    `${direction === null ? '' : `${direction} · `}` +
    `stored frame ${String(frameFor(keyFrames[Math.min(pose, keyFrames.length - 1)]))} · ` +
    `${String(Math.round(dwells[Math.min(pose, dwells.length - 1)] ?? 0))} ms / step`

  // The design prints two different things and they are easy to confuse: the diagnostics footer
  // lists the stored FRAME each pose shows, while the sound box's last line lists the pose SLOTS
  // the fold walks. Same schedule, two coordinate systems.
  const soundLines = audio.lines(
    playSpec(0, lastPose, '', dwells),
    keyFrames.length === 0 ? 'no pose schedule resident' : `folds ${keyFrames.join(' → ')}`,
  )

  // --- config plumbing --------------------------------------------------------------------------

  const applyConfig = useCallback((next: DemoConfig) => {
    setConfig(next)
  }, [])

  // `edgeShape`, `edgeFinish` and `edgeWidthUnit` are all factory options, so every segment
  // rebuilds the stage (design 2026-09-05 §6.5) — `EdgeSection` calls this with the WHOLE spec,
  // never one field at a time, so a reader flipping shape does not race a reader flipping finish.
  const onSpecChange = useCallback(
    (spec: EdgeSpec) => {
      if (
        spec.shape !== config.edgeShape ||
        spec.finish !== config.edgeFinish ||
        spec.widthUnit !== config.edgeWidthUnit
      ) {
        applyConfig({
          ...config,
          edgeShape: spec.shape,
          edgeFinish: spec.finish,
          edgeWidthUnit: spec.widthUnit,
        })
      }
    },
    [applyConfig, config],
  )

  // The address bar is always a live share link: `replaceState`, so a knob drag adds no history
  // entry, and never `pushState`.
  useEffect(() => {
    const changed: Record<string, string | number | boolean> = {}
    for (const { key, k } of entries) {
      const v = knobs[key]
      if (v !== undefined && v !== k.default) changed[key] = v
    }
    history.replaceState(null, '', encodeState(config, changed))
  }, [config, entries, knobs])

  const onReset = useCallback(() => {
    setDraft(null)
    resetKnobs()
    setConfig(DEFAULT_CONFIG)
    setStatus({ ok: true, text: 'reset to manifest defaults' })
  }, [resetKnobs, setStatus])

  // --- render -----------------------------------------------------------------------------------

  const edgeChip = `${config.edgeShape} · ${config.edgeFinish}`

  return (
    <PaperScene value={scene}>
      <div className="page">
        <Header
          status={shownStatus}
          chip={`bucket ${bucketShown} · ${String(poseCount)} ${poseCount === 1 ? 'pose' : 'poses'}`}
          onReset={onReset}
        />

        <main className="main">
          <section className="stage-column">
            <Stage
              hero={crumple}
              slotStyle={slotStyle}
              poseChip={`pose ${String(pose)} / ${String(lastPose)}`}
              sampleChip={sampleId}
              edgeChip={edgeChip}
              background={background}
              onDropImage={onDropImage}
            />

            <Transport
              steps={keyFrames.map((slot, i) => ({
                top: String(frameFor(slot)),
                title: `pose ${String(i)} · stored frame ${String(frameFor(slot))}`,
              }))}
              pose={pose}
              readout={transportReadout}
              busy={busy}
              onFold={() => void runFold('flat', 'ball')}
              onUnfold={() => void runFold('ball', 'flat')}
              onStepBack={() => {
                draw(Math.max(0, pose - 1))
              }}
              onStepForward={() => {
                draw(Math.min(lastPose, pose + 1))
              }}
              onGoto={draw}
            />

            <Diagnostics
              metrics={metrics}
              keyFrameLine={keyFrameLine}
              glInfo={built === null ? 'no stage' : glInfo(built)}
            />
          </section>

          <aside className="sidebar">
            <Section
              number="01"
              title="Source"
              summary={`${sampleId} · ${bucketShown}`}
              open={open.source}
              onToggle={() => {
                toggle('source')
              }}
            >
              <SourceSection
                sampleId={librarySample.id}
                packs={config.packs}
                swapTarget={swapTarget}
                busy={busy}
                onSampleChange={(id) => {
                  const next = SAMPLES.find((s) => s.id === id)
                  if (next === undefined) return
                  startSwap(next)
                }}
                onPacksChange={(packs: readonly BucketName[]) => {
                  applyConfig({ ...config, packs })
                }}
                onSyntheticUnavailable={() => {
                  setStatus({ ok: false, text: 'no synthetic bucket source in this build' })
                }}
                onSwapTargetChange={setSwapTarget}
                onSwap={onSwap}
              />
            </Section>

            <Section
              number="02"
              title="Edge"
              summary={edgeChip}
              open={open.edge}
              onToggle={() => {
                toggle('edge')
              }}
            >
              <EdgeSection
                entries={entries}
                knobs={knobs}
                spec={{
                  shape: config.edgeShape,
                  finish: config.edgeFinish,
                  widthUnit: config.edgeWidthUnit,
                }}
                onSpecChange={onSpecChange}
                onSet={setKnob}
                overscanHeadroom={config.overscanHeadroom}
              />
            </Section>

            <Section
              number="03"
              title="Poses"
              summary={`${String(poseCount)} ${poseCount === 1 ? 'pose' : 'poses'}`}
              open={open.poses}
              onToggle={() => {
                toggle('poses')
              }}
            >
              <PosesSection
                frames={storedFrames}
                keyFrames={keyFrames}
                disabled={pack === null}
                onCountChange={onCountChange}
                onKeyFrameChange={onKeyFrameChange}
                onManifest={() => {
                  if (pack !== null) commitKeyFrames([...pack.keyFrames])
                }}
                onEven={() => {
                  onCountChange(keyFrames.length)
                }}
              />
            </Section>

            <Section
              number="04"
              title="Sound"
              summary={audioSnapshot.summary}
              open={open.sound}
              onToggle={() => {
                toggle('sound')
              }}
            >
              <SoundSection
                snapshot={audioSnapshot}
                lines={soundLines}
                onClipChange={(id) => {
                  audio.setClip(id)
                }}
                onVolumeChange={(v) => {
                  audio.setVolume(v)
                }}
                onSyncChange={(m: SyncMode) => {
                  audio.setSync(m)
                }}
              />
            </Section>

            <Section
              number="05"
              title="Look & debug"
              summary={
                typeof knobs['motion.debug'] === 'string' ? knobs['motion.debug'] : 'composite'
              }
              open={open.look}
              onToggle={() => {
                toggle('look')
              }}
            >
              <LookSection
                entries={entries}
                knobs={knobs}
                onSet={setKnob}
                background={background}
                onBackgroundChange={setBackground}
              />
            </Section>

            {/*
              Everything past "05" has NO counterpart in the mockup: the library knobs the design's
              curated subset leaves out, then the factory options. Both are kept deliberately, and
              both are numbered on from the design's own sequence.
            */}
            {groups.map((g, i) => {
              const number = String(i + 6).padStart(2, '0')
              return (
                <Section
                  key={g.group}
                  number={number}
                  title={g.group}
                  summary={`${String(g.entries.length)} ${g.entries.length === 1 ? 'knob' : 'knobs'}`}
                  open={openExtra[g.group] ?? false}
                  onToggle={() => {
                    setOpenExtra((prev) => ({ ...prev, [g.group]: !(prev[g.group] ?? false) }))
                  }}
                >
                  <KnobRows entries={g.entries} knobs={knobs} onSet={setKnob} />
                </Section>
              )
            })}

            <Section
              number={String(groups.length + 6).padStart(2, '0')}
              title="Factory options"
              summary={`${String(config.artworkCssPx)} px · ${String(config.budgetMb)} MB`}
              open={openExtra['factory'] ?? false}
              onToggle={() => {
                setOpenExtra((prev) => ({ ...prev, factory: !(prev['factory'] ?? false) }))
              }}
            >
              <FactorySection config={config} onChange={applyConfig} />
            </Section>
          </aside>
        </main>
      </div>
    </PaperScene>
  )
}
