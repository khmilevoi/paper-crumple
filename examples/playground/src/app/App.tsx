import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Dispatch, MutableRefObject, ReactNode, SetStateAction } from 'react'
import * as pc from '@paper-crumple/core'
import { fitSheet } from '@paper-crumple/motion'
import type { Pack } from '@paper-crumple/motion'
import { evenKeyFrames } from '@paper-crumple/motion'
import type { EdgeSpec } from '@paper-crumple/paper'
import { PaperScene, useScene } from '@paper-crumple/react'

import {
  BOOT_SAMPLE,
  BROKEN_SAMPLE,
  EMPTY_TARGETS,
  sourceForRebuild,
  type SourceState,
  type PrefetchState,
} from '../source/state'
import type { AudioHandle, SyncMode } from '../sound/audio'
import { createAudio, playSpec } from '../sound/audio'
import type { BuiltStage, BucketName, DemoConfig } from '../scene/config'
import { DEFAULT_CONFIG } from '../scene/config'
import { collectDescriptors } from '../controls/knobs'
import { droppedSample } from '../source/samples'
import { useDemoScene } from '../scene/scene'
import type { DemoScene } from '../scene/scene'
import { BROKEN_ID, nextLibrarySample, SAMPLES } from '../source/samples'
import type { Sample } from '../source/samples'
import { decodeState, encodeState } from './state'
import { prefetchSamples } from '../source/prefetch'
import { glInfo } from '../diagnostics/gl-info'
import { useTransport } from '../playback/use-transport'

import { Diagnostics } from '../diagnostics/Diagnostics'
import { diagnosticsMetrics } from '../diagnostics/metrics'
import { EdgeSection } from '../paper/EdgeSection'
import { Header, type StageStatus } from './Header'
import { FactorySection, KnobRows, libraryGroups } from '../controls/LibrarySections'
import { LookSection } from '../paper/LookSection'
import type { StageBackground } from '../paper/LookSection'
import { PosesSection, MAX_POSES, MIN_POSES } from '../playback/PosesSection'
import { SoundSection } from '../sound/SoundSection'
import { bucketForPacks, SourceSection } from '../source/SourceSection'
import { Stage } from '../scene/Stage'
import { Transport } from '../playback/Transport'
import { Section } from '../controls/primitives'

type SectionKey = 'source' | 'edge' | 'poses' | 'sound' | 'look'

function sameList(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

export function App(): ReactNode {
  // --- boot state and scene owner ----------------------------------------------------------------

  // The fragment a reader may have opened this page with, decoded exactly once. A malformed one
  // falls back to `DEFAULT_CONFIG` rather than producing a blank page.
  const boot = useMemo(() => decodeState(location.hash), [])
  const [config, setConfig] = useState<DemoConfig>(
    boot instanceof Error ? DEFAULT_CONFIG : boot.config,
  )

  /** The declaratively requested picture plus the full last successful source. A failed request
   * stays requested for retry, but a later stage rebuild reacquires `retained` instead. Keeping the
   * complete Sample is required for dropped Files, which cannot be recovered from `SAMPLES`. */
  const [source, setSource] = useState<SourceState>({
    requested: BOOT_SAMPLE,
    retained: null,
    failed: null,
  })
  /** The built-in sample picker's own bound value. Dropped and deliberately broken sources never
   * become options in that picker, so this stays separate from the requested source policy. */
  const [librarySample, setLibrarySample] = useState<Sample>(BOOT_SAMPLE)
  const [status, setStatus] = useState<StageStatus | null>(() =>
    boot instanceof Error
      ? { ok: false, text: `decodeState: ${boot.message}` }
      : { ok: true, text: 'booting…' },
  )

  const onObserved = useCallback((where: string, error: Error): void => {
    setStatus({ ok: false, text: `${where}: ${error.message}` })
  }, [])

  const [draft, setDraft] = useState<readonly number[] | null>(null)

  // One controller for the life of the page — the handle owns an AudioContext and decoded buffers,
  // and a second one would be a second context.
  const [audio] = useState<AudioHandle>(() => createAudio(onObserved))
  const [mountMs, setMountMs] = useState<number | null>(null)
  const readyAtRef = useRef<number | null>(null)
  const prefetchOwnerRef = useRef<object | null>(null)
  const [prefetch, setPrefetch] = useState<PrefetchState | null>(null)

  const demo = useDemoScene(config, onObserved, boot instanceof Error ? {} : boot.knobs, {
    onReady(built, info) {
      setStatus(null)
      readyAtRef.current = performance.now()
      setMountMs(null)
      const owner = {}
      prefetchOwnerRef.current = owner
      prefetchSamples(built, source.requested, info.signal, (stage, targets) => {
        if (info.signal.aborted || prefetchOwnerRef.current !== owner) return
        setPrefetch({ stage, targets })
      })
      if (draft === null) return
      const refused = built.motion.setPoses({ keyFrames: [...draft] })
      if (refused !== undefined) setStatus({ ok: false, text: `rejected: ${refused.message}` })
    },
    onFailed(error, info) {
      setStatus({
        ok: false,
        text: info.lost
          ? 'the WebGL2 context was lost — reload to rebuild'
          : `stage build failed: ${error.message}`,
      })
    },
  })

  return (
    <PaperScene value={demo.scene}>
      <Playground
        config={config}
        setConfig={setConfig}
        source={source}
        setSource={setSource}
        prefetch={prefetch}
        librarySample={librarySample}
        setLibrarySample={setLibrarySample}
        status={status}
        setStatus={setStatus}
        draft={draft}
        setDraft={setDraft}
        audio={audio}
        mountMs={mountMs}
        setMountMs={setMountMs}
        readyAtRef={readyAtRef}
        observed={onObserved}
        demo={demo}
      />
    </PaperScene>
  )
}

interface PlaygroundProps {
  config: DemoConfig
  setConfig: Dispatch<SetStateAction<DemoConfig>>
  source: SourceState
  setSource: Dispatch<SetStateAction<SourceState>>
  prefetch: PrefetchState | null
  librarySample: Sample
  setLibrarySample: Dispatch<SetStateAction<Sample>>
  status: StageStatus | null
  setStatus: Dispatch<SetStateAction<StageStatus | null>>
  draft: readonly number[] | null
  setDraft: Dispatch<SetStateAction<readonly number[] | null>>
  audio: AudioHandle
  mountMs: number | null
  setMountMs: Dispatch<SetStateAction<number | null>>
  readyAtRef: MutableRefObject<number | null>
  observed: (where: string, error: Error) => void
  demo: DemoScene
}

function Playground({
  config,
  setConfig,
  source,
  setSource,
  prefetch,
  librarySample,
  setLibrarySample,
  status,
  setStatus,
  draft,
  setDraft,
  audio,
  mountMs,
  setMountMs,
  readyAtRef,
  observed,
  demo,
}: PlaygroundProps): ReactNode {
  const scene = useScene<BuiltStage>()
  const built = scene.status === 'ready' ? scene.meta : null
  const { knobs, setKnob } = demo
  const { stop } = scene
  const shown = source.requested
  const prefetching =
    built !== null && prefetch?.stage === built.stage ? prefetch.targets : EMPTY_TARGETS

  const transport = useTransport({
    shown,
    audio,
    observed,
    onSettle(event, wasSwap) {
      if (event.key !== shown.id) return
      const startedAt = readyAtRef.current
      if (startedAt !== null && event.error === null) {
        readyAtRef.current = null
        setMountMs((previous) => previous ?? performance.now() - startedAt)
      }
      if (event.error !== null) {
        setSource((current) =>
          current.requested.id === event.key ? { ...current, failed: event.key } : current,
        )
        setStatus({
          ok: false,
          text: wasSwap
            ? `swap failed, rolled back to the previous sprite: ${event.error.message}`
            : `image failed: ${event.error.message}`,
        })
        return
      }
      setSource((current) =>
        current.requested.id === event.key
          ? { requested: current.requested, retained: current.requested, failed: null }
          : current,
      )
      if (!wasSwap) return
      setStatus({ ok: true, text: `swapped to ${shown.label}` })
    },
  })
  const { crumple, dwells, lastStepMs, lastDrawMs, beginSwap, retrySwap, cancelSwap } = transport

  const sprite = crumple.sprite

  // --- sound --------------------------------------------------------------------------------------

  const [audioSnapshot, setAudioSnapshot] = useState(() => audio.snapshot())
  useEffect(
    () =>
      audio.subscribe(() => {
        setAudioSnapshot(audio.snapshot())
      }),
    [audio],
  )

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
  const pose = crumple.pose
  const drawFlat = crumple.draw

  // --- pose schedule --------------------------------------------------------------------------

  /** The pack the selects are built from. Every built-in pack stores the same twelve frames and
   *  `setPoses` checks a draft against every resident pack anyway, so the first resident one is as
   *  good as any. */
  const pack = built?.motion.packs()[0] ?? null
  /** `null` means "whatever the pack's manifest says"; anything else is the reader's own draft,
   *  and it survives a rebuild the way the open sections do. */
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
      if (crumple.pending !== null) cancelSwap(crumple.pending.key)
      stop({ all: true })
      const manifest = sameList(draftPoses, resident.keyFrames)
      const refused = built.motion.setPoses(manifest ? null : { keyFrames: [...draftPoses] })
      if (refused !== undefined) {
        setStatus({ ok: false, text: `rejected: ${refused.message}` })
        return false
      }
      drawFlat('flat')
      return true
    },
    [built, cancelSwap, crumple.pending, drawFlat, stop, setStatus],
  )

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
    [applyPoses, pack, setDraft, setStatus],
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
   * The swap, as a state change. The transport arms its audio and duration synchronously before
   * the new sample is handed to `useHero`; the binding then owns the acquisition and run.
   */
  const startSwap = useCallback(
    (target: Sample) => {
      if (prefetching.has(target.id)) return
      if (target.id === crumple.requested) {
        if (crumple.status === 'rolled-back') {
          setSource((current) =>
            current.requested.id === target.id ? { ...current, failed: null } : current,
          )
          retrySwap(target.id)
        }
        return
      }
      beginSwap(target.id)
      setSource((current) => ({ ...current, requested: target, failed: null }))
      setLibrarySample((prev) => nextLibrarySample(prev, target))
    },
    [beginSwap, crumple, prefetching, retrySwap, setLibrarySample, setSource],
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
      startSwap(droppedSample(file, dropSeq.current))
    },
    [startSwap],
  )

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

  const sampleId =
    crumple.status === 'rolled-back' ? (crumple.shown ?? shown.id) : (crumple.requested ?? shown.id)
  const busy = transport.busy

  const metrics = useMemo(
    () => diagnosticsMetrics({ built, sprite, fit, lastDrawMs, lastStepMs, mountMs }),
    [built, fit, lastDrawMs, lastStepMs, mountMs, sprite],
  )

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
    `${transport.direction === null ? '' : `${transport.direction} · `}` +
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

  const applyConfig = useCallback(
    (next: DemoConfig) => {
      if (crumple.pending !== null) cancelSwap(crumple.pending.key)
      setSource(sourceForRebuild)
      setConfig(next)
    },
    [cancelSwap, crumple.pending, setConfig, setSource],
  )

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
    const changed: Record<string, pc.Knobs[string]> = {}
    if (scene.status === 'ready') {
      for (const [key, value] of Object.entries(knobs)) {
        if (value !== scene.stage.defaults[key]) changed[key] = value
      }
    }
    history.replaceState(null, '', encodeState(config, changed))
  }, [config, knobs, scene])

  const onReset = useCallback(() => {
    if (crumple.pending !== null) {
      cancelSwap(crumple.pending.key)
      stop({ all: true })
    }
    setDraft(null)
    demo.resetKnobs()
    if (config !== DEFAULT_CONFIG) setSource(sourceForRebuild)
    setConfig(DEFAULT_CONFIG)
    setStatus({ ok: true, text: 'reset to manifest defaults' })
  }, [cancelSwap, config, crumple.pending, demo, setConfig, setDraft, setSource, setStatus, stop])

  // --- render -----------------------------------------------------------------------------------

  const edgeChip = `${config.edgeShape} · ${config.edgeFinish}`

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
            hero={crumple}
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
            onFold={() => void transport.runFold('flat', 'ball')}
            onUnfold={() => void transport.runFold('ball', 'flat')}
            onStepBack={() => {
              transport.draw(Math.max(0, pose - 1))
            }}
            onStepForward={() => {
              transport.draw(Math.min(lastPose, pose + 1))
            }}
            onGoto={transport.draw}
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
              preparing={prefetching}
              onSampleChange={(id) => {
                const next = SAMPLES.find((s) => s.id === id)
                if (next === undefined) return
                startSwap(next)
                // Same as `onSwap`'s own re-derivation below: the swap-to select must never keep
                // naming the sample just picked here, or the next Swap click becomes the no-op
                // `startSwap`'s guard now refuses silently (Finding A).
                setSwapTarget(SAMPLES.find((s) => s.id !== next.id)?.id ?? BROKEN_ID)
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
  )
}
