import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Dispatch, MutableRefObject, ReactNode, SetStateAction } from 'react'
import { fitSheet } from '@paper-crumple/motion'
import type { Pack } from '@paper-crumple/motion'
import { evenKeyFrames } from '@paper-crumple/motion'
import type { EdgeSpec } from '@paper-crumple/paper'
import { PaperScene, useScene } from '@paper-crumple/react'

import type { AudioHandle, SyncMode } from '../audio'
import { createAudio, playSpec } from '../audio'
import type { BuiltStage, BucketName, DemoConfig } from '../config'
import { DEFAULT_CONFIG } from '../config'
import { collectDescriptors } from '../knobs'
import { droppedSample } from '../hero'
import { useDemoScene } from '../scene'
import type { DemoScene } from '../scene'
import { BROKEN_URL, DEFAULT_SAMPLE_ID, nextLibrarySample, SAMPLES } from '../samples'
import type { Sample } from '../samples'
import { decodeState, encodeState } from '../state'
import { prefetchSamples, glInfo } from '../stage'
import { useTransport } from '../transport'

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

const BROKEN_SAMPLE: Sample = {
  id: BROKEN_ID,
  label: 'broken URL (rollback demo)',
  src: BROKEN_URL,
}

type SectionKey = 'source' | 'edge' | 'poses' | 'sound' | 'look'

const BOOT_SAMPLE: Sample = SAMPLES.find((s) => s.id === DEFAULT_SAMPLE_ID) ?? SAMPLES[0]

function sameList(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

/**
 * Whether a swap to `target` would be a no-op the library itself never reports back on. `useCrumple`
 * refuses a same-key request before it does anything observable — `syncSprite`'s
 * `core.synced.key === key` check (`packages/react/src/use-crumple.ts:261`) returns before an
 * `add`, a run, or an `end` event, so nothing would ever arrive to close a transport this component
 * armed for the swap (Finding A). `startSwap` must never begin one.
 *
 * `requestedKey` MUST be `crumple.requested` (falling back to the request in flight, `shown.id`,
 * before anything has landed) — the key `useCrumple` itself compares at `use-crumple.ts:261`, where
 * it moves in lockstep with `core.synced.key` (`packages/react/src/crumple-state.ts:47`,
 * `use-crumple.ts:264`). It is NOT `crumple.shown`: that is `view?.sprite?.key`
 * (`crumple-state.ts:46`), the sprite actually on the canvas, and it diverges from `requested`
 * precisely on the rollback path — a failed acquisition rolls back, leaving `synced.key` /
 * `requested` at `'broken'` while `shown` is still the previous sprite's key. Comparing against
 * `shown` instead re-arms `direction` and `swappingRef` on a second "Swap" click for the broken
 * sample, then bails out of `setShown` on an identical object: the
 * `[view, spriteKey, src, syncSprite]` effect (`use-crumple.ts:286-289`) never re-fires, and nothing
 * ever clears those flags — the transport, keyboard and Swap button go dead until reload.
 *
 * Swallowing the repeated broken-URL click here is correct, not a regression: with `spriteKey`
 * unchanged `useCrumple` refuses by construction, and `rememberPair` refuses a changed `src` under
 * the same key, so the rollback demo cannot be re-armed by clicking Swap again at all — the guard's
 * job is to swallow the click rather than arm a transport for a run that can never happen.
 */
export function isNoOpSwap(requestedKey: string, target: Sample): boolean {
  return target.id === requestedKey
}

/**
 * Whether the swap this component started has reached the sprite it asked for (§9.3).
 *
 * All three values, not two. `crumple.requested === crumple.shown` alone is true AT REST — and the
 * commit right after a "Swap" click is at rest as far as the snapshot is concerned: `startSwap`
 * arms `swappingRef` and calls `setShown(target)`, so the effect re-runs on the new `shown.label`
 * while the snapshot it reads is still the pre-click one, both values naming the PREVIOUS sprite.
 * Gating on the pair alone would consume the transport and print the new label at the start of the
 * swap instead of the end. `requested` moves one commit later, inside `useCrumple`'s own
 * `syncSprite` effect (`use-crumple.ts:286-289`); `shown` moves when the sprite lands.
 *
 * `requested !== shownKey` is also exactly the rollback path — a failed acquisition leaves
 * `requested` at `'broken'` while the previous sprite is still on the canvas — so this never fires
 * for a swap that did not happen. That path is closed by the error effect, which clears
 * `swappingRef` itself.
 *
 * It reports the ball, not the true end, while `adopt` still moves `shown` mid-fold (§0.1). §2.1's
 * `onSettle` is the real fix and is not this plan's.
 */
export function isSwapSettled(
  requested: string | null,
  shownKey: string | null,
  targetKey: string,
): boolean {
  return requested === targetKey && shownKey === targetKey
}

/** The status line the pill shows: what the last action did, or `null` for the idle readout. */
export interface StageStatus {
  readonly ok: boolean
  readonly text: string
}

export function App(): ReactNode {
  // --- boot state and scene owner ----------------------------------------------------------------

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

  const demo = useDemoScene(config, onObserved, boot instanceof Error ? {} : boot.knobs, {
    onReady(built, info) {
      setStatus(null)
      readyAtRef.current = performance.now()
      setMountMs(null)
      prefetchSamples(built, shown, info.signal)
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
        shown={shown}
        setShown={setShown}
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
  shown: Sample
  setShown: Dispatch<SetStateAction<Sample>>
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
  shown,
  setShown,
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
  const { knobs, setKnob, resetKnobs } = demo
  const generation = scene.generation

  /** True between the click that starts a swap and the settle that ends it, so the ENTRANCE does
   *  not print "swapped to …" on the way up. */
  const swappingRef = useRef(false)

  const { crumple, dwells, direction, busy, lastStepMs, lastDrawMs, beginSwap, draw, runFold } =
    useTransport({
      shown,
      audio,
      observed,
      onSettle: () => {},
    })

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

  // --- status: the settle backstop and the two error/failure effects ------------------------------

  /**
   * The swap settled. The transport callback covers the animated path; this covers the reduced-
   * motion one, where `show()` is the whole swap — one draw, no run, no start/step/end triple — and
   * emits nothing at all. The placeholder only lifts because the binding versions its own store;
   * there is no event behind it (USAGE §7). Without this the status would never close under `reduce`.
   */
  useEffect(() => {
    if (!swappingRef.current) return
    if (!isSwapSettled(crumple.requested, crumple.shown, shown.id)) return
    swappingRef.current = false
    setStatus({ ok: true, text: `swapped to ${shown.label}` })
  }, [crumple.requested, crumple.shown, setStatus, shown.id, shown.label])

  /** A swap whose target failed rolled back to the previous sprite, and the hook reports the
   *  target's Error rather than retrying: the prop says B while the canvas shows A. `error` is
   *  cleared when the next run starts, so this pill clears itself on the next interaction. */
  useEffect(() => {
    const failed = crumple.error
    if (failed === null) return
    swappingRef.current = false
    // The status pill IS the sync target for `crumple.error` — there is nowhere else this reads
    // from and nothing to subscribe to instead.
    setStatus({
      ok: false,
      text: `swap failed, rolled back to the previous sprite: ${failed.message}`,
    })
  }, [crumple.error, setStatus])

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

  // --- pose schedule --------------------------------------------------------------------------

  /** The pack the selects are built from. Every built-in pack stores the same twelve frames and
   *  `setPoses` checks a draft against every resident pack anyway, so the first resident one is as
   *  good as any. */
  const pack = useMemo(
    () => built?.motion.packs()[0] ?? null,
    // `generation` is what makes this re-read after a rebuild swaps the slot underneath, and
    // `crumple.shown` is what makes it re-read when a sprite LANDS: `packs()` lists the resident
    // packs and there are none before the first `add` resolves, which is strictly after `built`
    // (§9.2). Neither is read in the body.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [built, generation, crumple.shown],
  )
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
      scene.stop({ all: true })
      const manifest = sameList(draftPoses, resident.keyFrames)
      const refused = built.motion.setPoses(manifest ? null : { keyFrames: [...draftPoses] })
      if (refused !== undefined) {
        setStatus({ ok: false, text: `rejected: ${refused.message}` })
        return false
      }
      crumple.draw('flat')
      crumple.refresh()
      return true
    },
    // `scene.stop` only, not `scene`: the analyzer does not narrow a called member expression
    // (`scene.stop({...})`) the way it narrows a plain property read, so it still asks for the
    // base identifier — but `scene`'s identity moves on every `knobEpoch` bump
    // (`use-paper-scene.ts:251,284`), and depending on the object would re-run this effect, and
    // everything that closes over it, on every knob write.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [built, crumple.draw, crumple.refresh, scene.stop, setStatus],
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
      // A same-key request is a silent no-op in `useCrumple` (see `isNoOpSwap`) — nothing would
      // ever arrive to clear `direction` or `swappingRef`, so no swap that cannot run may leave the
      // transport armed. This is the root guard for the whole class, not just one caller's route.
      // Compared against `crumple.requested ?? shown.id` — the key `useCrumple` itself compares at
      // `use-crumple.ts:261`, which moves in lockstep with `core.synced.key`. NOT `crumple.shown`:
      // that is the sprite actually on the canvas, and it diverges from `requested` precisely on the
      // rollback path — a failed acquisition leaves `requested` at `'broken'` while `shown` is still
      // the previous sprite's key. Comparing against `shown` would re-arm the transport on a second
      // broken-URL click and nothing would ever disarm it (see `isNoOpSwap`'s doc for the full
      // sequence). Swallowing the repeated click here is correct: with `spriteKey` unchanged the
      // rollback demo cannot be re-armed by clicking Swap again at all.
      if (isNoOpSwap(crumple.requested ?? shown.id, target)) return
      beginSwap()
      swappingRef.current = true
      setShown(target)
      setLibrarySample((prev) => nextLibrarySample(prev, target))
    },
    [beginSwap, crumple.requested, setLibrarySample, setShown, shown],
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
  useEffect(() => {
    const startedAt = readyAtRef.current
    if (crumple.shown === null || startedAt === null) return
    setMountMs((prev) => prev ?? performance.now() - startedAt)
  }, [crumple.shown, readyAtRef, setMountMs])

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

  const applyConfig = useCallback(
    (next: DemoConfig) => {
      setConfig(next)
    },
    [setConfig],
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
  }, [resetKnobs, setConfig, setDraft, setStatus])

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
