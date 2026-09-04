import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import * as pc from '@paper-crumple/core'
import { fitSheet } from '@paper-crumple/motion'
import type { Pack } from '@paper-crumple/motion'
import { evenKeyFrames } from '@paper-crumple/motion'

import type { AudioHandle, SyncMode } from '../audio'
import { createAudio, playSpec, swapSpec } from '../audio'
import type { BucketName, DemoConfig } from '../config'
import { DEFAULT_CONFIG } from '../config'
import { collectDescriptors } from '../knobs'
import { BROKEN_URL, DEFAULT_SAMPLE_ID, SAMPLES } from '../samples'
import type { Sample } from '../samples'
import { decodeState, encodeState } from '../state'
import { glInfo } from '../stage'
import { useStage } from '../useStage'
import type { StageStatus } from '../useStage'

import { Diagnostics } from './Diagnostics'
import type { Metric } from './Diagnostics'
import { EdgeSection } from './EdgeSection'
import type { UiEdgeMode } from './EdgeSection'
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
const SWAP_DURATION_MS = 900

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

export function App(): ReactNode {
  // --- boot state -------------------------------------------------------------------------------

  // The fragment a reader may have opened this page with, decoded exactly once. A malformed one
  // falls back to `DEFAULT_CONFIG` rather than producing a blank page.
  const boot = useMemo(() => decodeState(location.hash), [])
  const [config, setConfig] = useState<DemoConfig>(
    boot instanceof Error ? DEFAULT_CONFIG : boot.config,
  )
  /**
   * Two names for one silhouette, because they answer different questions. `sample` is the pick
   * that BUILDS the stage — writing it rebuilds. `shown` is what is on the stage right now, which
   * a swap moves without rebuilding; every chip and picker reads that one. The picker sets both,
   * so they only differ after a swap.
   */
  const [sample, setSample] = useState<Sample>(BOOT_SAMPLE)
  const [shown, setShown] = useState<Sample>(BOOT_SAMPLE)

  const slotRef = useRef<HTMLDivElement>(null)

  const {
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
    observed: onObserved,
  } = useStage(config, sample, shown, slotRef)

  useEffect(() => {
    if (!(boot instanceof Error)) seedKnobs(boot.knobs)
    else onObserved('decodeState', boot)
    // Once, before the first rebuild lands — `useStage` re-applies it on the way up.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // --- sound ------------------------------------------------------------------------------------

  // One controller for the life of the page. `useState`'s lazy initialiser rather than a ref
  // assigned during render: the handle owns an AudioContext and decoded buffers, and a second one
  // would be a second context.
  const [audio] = useState<AudioHandle>(() => createAudio(onObserved))
  const [audioSnapshot, setAudioSnapshot] = useState(() => audio.snapshot())
  useEffect(
    () =>
      audio.subscribe(() => {
        setAudioSnapshot(audio.snapshot())
      }),
    [audio],
  )

  // --- panel state ------------------------------------------------------------------------------

  const [open, setOpen] = useState<Record<SectionKey, boolean>>({
    source: true,
    edge: true,
    poses: false,
    sound: false,
    look: false,
  })
  const [openExtra, setOpenExtra] = useState<Record<string, boolean>>({})
  const [swapTarget, setSwapTarget] = useState<string>(
    SAMPLES.find((s) => s.id !== sample.id)?.id ?? BROKEN_ID,
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

  // --- pose schedule ----------------------------------------------------------------------------

  /** The pack the selects are built from. Every built-in pack stores the same twelve frames and
   *  `setPoses` checks a draft against every resident pack anyway, so the first resident one is as
   *  good as any. */
  const pack = useMemo(
    () => live?.built.motion.packs()[0] ?? null,
    // `generation` is what makes this re-read after a rebuild swaps the slot underneath.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [live, generation],
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
    (draft: readonly number[], resident: Pack): boolean => {
      const current = live
      if (current === null) return false
      // A run in flight keeps the plan it started with and would render its remaining poses
      // through the new key frames, so every run stops first and every view goes back to pose 0,
      // which exists in every schedule.
      current.built.stage.stop({ all: true })
      const manifest = sameList(draft, resident.keyFrames)
      const refused = current.built.motion.setPoses(manifest ? null : { keyFrames: [...draft] })
      if (refused !== undefined) {
        setStatus({ ok: false, text: `rejected: ${refused.message}` })
        return false
      }
      current.view?.draw('flat')
      return true
    },
    [live, setStatus],
  )

  // Re-point the schedule at the stage a rebuild just produced. A rebuild is a fresh
  // `bakedMotion()` with no override, so whatever draft the reader was editing is re-applied here.
  useEffect(() => {
    if (live === null || pack === null) return
    // The only state this can touch is the status pill, and only when the library REFUSES the
    // draft — which is the one thing a reader must be told about a schedule that did not take.
    applyPoses(keyFrames, pack)
    // Only when a new stage lands: `keyFrames` changing from an edit is applied by the edit itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generation, live, pack])

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

  // --- playback ---------------------------------------------------------------------------------

  const [direction, setDirection] = useState<'folding' | 'unfolding' | null>(null)
  /** The interval between two consecutive scheduled renders of the last run. `step.ms` is
   *  elapsed-since-`start`, not a per-step cost (`runner.ts`'s `stepOnce`), so the interval is
   *  the difference of two of them — which is what the scheduler actually spent on that pose. */
  const [lastStepMs, setLastStepMs] = useState<number | null>(null)
  const stepAtRef = useRef<number | null>(null)
  /** A draw-only pose change, timed around the `view.draw(...)` call itself. */
  const [lastDrawMs, setLastDrawMs] = useState<number | null>(null)
  const runRef = useRef<pc.Run<pc.PlayResult | pc.SwapResult> | null>(null)

  const dwells = live?.built.motion.poses?.dwells ?? pc.DWELL_MS
  const poseCount = keyFrames.length > 0 ? keyFrames.length : dwells.length
  const lastPose = poseCount - 1

  /**
   * `view.pose` lives in the library, not in React, so it is read through
   * `useSyncExternalStore` rather than mirrored into state by an effect.
   *
   * The library's own `start` / `step` / `end` are only half the signal: `view.draw(...)` is
   * documented as draw-only and emits nothing, and the pose strip and the two arrow buttons all
   * go through it. `notifyPose` below is what those call, and it drives the same subscribers.
   */
  const poseListeners = useRef(new Set<() => void>())
  const notifyPose = useCallback(() => {
    for (const fn of poseListeners.current) fn()
  }, [])
  const subscribePose = useCallback(
    (onStoreChange: () => void) => {
      const listeners = poseListeners.current
      listeners.add(onStoreChange)
      const view = live?.view ?? null
      const offs =
        view === null
          ? []
          : [
              view.on('start', () => {
                stepAtRef.current = null
                onStoreChange()
              }),
              view.on('step', (e) => {
                const previous = stepAtRef.current
                stepAtRef.current = e.ms
                if (previous !== null) setLastStepMs(e.ms - previous)
                onStoreChange()
              }),
              view.on('end', onStoreChange),
            ]
      return () => {
        listeners.delete(onStoreChange)
        for (const off of offs) off()
      }
    },
    [live],
  )
  const pose = useSyncExternalStore(subscribePose, () => live?.view?.pose ?? 0)

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

  const draw = useCallback(
    (next: number) => {
      const view = live?.view
      if (view === null || view === undefined) return
      const startedAt = performance.now()
      view.draw(next)
      setLastDrawMs(performance.now() - startedAt)
      notifyPose()
    },
    [live, notifyPose],
  )

  const runFold = useCallback(
    async (from: pc.PoseRef, to: pc.PoseRef): Promise<void> => {
      const view = live?.view
      if (view === null || view === undefined) return
      const fromIdx = poseIndex(from)
      const toIdx = poseIndex(to)
      if (fromIdx === toIdx) return

      // Synchronous, inside the click: that is what lets the AudioContext resume under the
      // autoplay policy, and it hands back the clip's length as the run's `duration`. One
      // `duration` is the whole of the sync — the library spreads it over the traversed dwells,
      // so the authored uneven cadence survives and the run ends when the clip does.
      const duration = audio.beginSequence(playSpec(fromIdx, toIdx, '', dwells))
      setDirection(toIdx > fromIdx ? 'folding' : 'unfolding')
      const run = view.play(from, to, { duration: duration ?? FOLD_DURATION_MS })
      runRef.current = run
      const r = await run
      audio.endSequence()
      setDirection(null)
      if (r === pc.ABORTED) return
      if (r instanceof Error) {
        onObserved('view.play', r)
        return
      }
      notifyPose()
    },
    [audio, dwells, live, notifyPose, onObserved, poseIndex],
  )

  // --- swap -------------------------------------------------------------------------------------

  const swapControllerRef = useRef<AbortController | null>(null)

  const swapTo = useCallback(
    async (src: string, label: string): Promise<void> => {
      const view = live?.view
      if (view === null || view === undefined) return

      swapControllerRef.current?.abort()
      const controller = new AbortController()
      swapControllerRef.current = controller

      // A swap's basis is the rise / ball-hold / fall, not a play's gaps, so the printed factor is
      // the one the library will use.
      const duration = audio.beginSequence(swapSpec(view.pose, dwells))
      setDirection('folding')
      const run = view.swapTo(src, {
        duration: duration ?? SWAP_DURATION_MS,
        signal: controller.signal,
      })
      runRef.current = run
      const r = await run
      audio.endSequence()
      setDirection(null)
      if (r === pc.ABORTED) return
      // Either way the view is now showing a sprite this hook has never seen — the new one, or
      // the old one the library rolled back to — and the panel's numbers describe the sprite.
      noteSwapped()
      // …and so does the framing: the new silhouette reaches its own distance into the paper, and
      // the canvas has to be re-sized around whichever artwork actually won. The step listener
      // already framed the target on the step it arrived; this settles a rollback, which lands
      // the old sprite back on a step of its own, and costs one redraw otherwise.
      reframe()
      if (r instanceof Error) {
        onObserved('view.swapTo', r)
        setStatus({
          ok: false,
          text: `swap failed, rolled back to the previous sprite: ${r.message}`,
        })
        notifyPose()
        return
      }
      setStatus({ ok: true, text: `swapped to ${label}` })
      notifyPose()
    },
    [audio, dwells, live, noteSwapped, notifyPose, onObserved, reframe, setStatus],
  )

  const onSwap = useCallback(() => {
    const target =
      swapTarget === BROKEN_ID ? BROKEN_SAMPLE : SAMPLES.find((s) => s.id === swapTarget)
    if (target === undefined) return
    void swapTo(target.url, target.id).then(() => {
      if (swapTarget === BROKEN_ID) return
      // NOT `setSample`: that is the rebuild trigger, and a rebuild here would throw away the
      // sprite the swap just animated into place, reload it unanimated, and reset the pose, the
      // status line and every live knob with it. The swap is the live path; this only records
      // which sample the reader is now looking at.
      setShown(target)
      setSwapTarget(SAMPLES.find((s) => s.id !== target.id)?.id ?? BROKEN_ID)
    })
  }, [swapTarget, swapTo])

  const onDropImage = useCallback(
    (file: File) => {
      const url = URL.createObjectURL(file)
      void swapTo(url, file.name).then(() => {
        // The sprite holds its own decoded texture by now; the blob URL has no further reader.
        URL.revokeObjectURL(url)
      })
    },
    [swapTo],
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

  // --- derived ----------------------------------------------------------------------------------

  const entries = useMemo(() => (live === null ? [] : collectDescriptors(live.built)), [live])
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

  /** The design's two decimals, but only while they fit: past 10 ms the tile is 150px wide and
   *  the second decimal is what pushes the value into an ellipsis. */
  const msText = (v: number): string => (v < 10 ? v.toFixed(2) : v.toFixed(1))

  const metrics = useMemo((): Metric[] => {
    if (live === null || sprite === null) {
      return [
        { label: 'texture', value: '—' },
        { label: 'sheet', value: '—' },
        { label: 'bucket / stretch', value: '—' },
        { label: 'pass a / b', value: '—' },
        { label: 'hull', value: '—' },
        { label: 'draw / upload', value: '—' },
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
        label: 'pass a / b',
        value: `${msText(live.built.buildMs)} / ${msText(Math.max(0, live.mountMs - live.addMs))} ms`,
        title: 'a: paperStage + both slots · b: view + show, after the front bake',
      },
      {
        label: 'hull',
        // `hull` is the only edge mode that builds one; in `torn` the pass does not exist, and
        // the design prints the same em dash for it.
        value: config.edgeMode === 'torn' ? '—' : `${msText(live.addMs)} ms`,
        title: 'the front bake, which is where the hull polygon is built',
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
  }, [config.edgeMode, fit, lastDrawMs, lastStepMs, live, sprite])

  /**
   * The design's own idle status: what the stage is, not what the last action was. `useStage`
   * reports `null` for a clean build precisely so this line can take over, and every later action
   * — a knob write, a refused pose draft, a failed swap — overwrites it until the next rebuild.
   */
  const shownStatus: StageStatus =
    status ??
    (live === null || pack === null
      ? { ok: true, text: 'booting…' }
      : {
          ok: true,
          text:
            `bucket ${bucketShown} · ${String(pack.frameCount)} stored frames` +
            (live.built.stage.warnings.length === 0
              ? ''
              : ` · ${String(live.built.stage.warnings.length)} warnings`),
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

  // `edgeMode` is a factory option, so every segment — `both` included — rebuilds the stage.
  // `descriptorsFor('both')` is `[...HULL_KNOBS, ...TORN_KNOBS]`, which is what makes the two
  // sub-cards below fill in rather than one of them reporting itself unavailable.
  const onEdgeModeChange = useCallback(
    (mode: UiEdgeMode) => {
      if (mode !== config.edgeMode) applyConfig({ ...config, edgeMode: mode })
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

  const edgeChip = config.edgeMode === 'both' ? 'hull + torn' : config.edgeMode

  return (
    <div className="page">
      <Header
        status={shownStatus}
        chip={`bucket ${bucketShown} · ${String(poseCount)} ${poseCount === 1 ? 'pose' : 'poses'}`}
        onReset={onReset}
      />

      <main className="main">
        <section className="stage-column">
          <Stage
            slotRef={slotRef}
            poseChip={`pose ${String(pose)} / ${String(lastPose)}`}
            sampleChip={shown.id}
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
            glInfo={live === null ? 'no stage' : glInfo(live.built)}
          />
        </section>

        <aside className="sidebar">
          <Section
            number="01"
            title="Source"
            summary={`${shown.id} · ${bucketShown}`}
            open={open.source}
            onToggle={() => {
              toggle('source')
            }}
          >
            <SourceSection
              sampleId={shown.id}
              packs={config.packs}
              swapTarget={swapTarget}
              busy={busy}
              onSampleChange={(id) => {
                const next = SAMPLES.find((s) => s.id === id)
                if (next === undefined) return
                setSample(next)
                setShown(next)
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
              mode={config.edgeMode}
              onModeChange={onEdgeModeChange}
              onSet={setKnob}
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
            summary={config.present}
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
  )
}
