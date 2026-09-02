import * as pc from '@paper-crumple/core'
import type { BuiltStage } from './config'
import type { AudioHandle } from './audio'
import { playSpec, swapSpec } from './audio'
import { BROKEN_URL, SAMPLES } from './samples'

const TRANSPORT_SLOT = 'transport'
const FOLD_DURATION_MS = 900
const SWAP_DURATION_MS = 900
const BROADCAST_STAGGER_MS = 40
const BROKEN_KEY = 'broken'

const FLAT_POSE = 0
const BALL_POSE = pc.DWELL_MS.length - 1

/**
 * `PoseRef` is an input type: `'flat'` and `'ball'` resolve to indices on the way into the
 * library and nothing it reports ever carries the names back. The audio schedule is computed
 * from `pc.DWELL_MS` by index, so the same resolution has to happen here first.
 */
function poseIndex(ref: pc.PoseRef): number {
  if (ref === 'flat') return FLAT_POSE
  if (ref === 'ball') return BALL_POSE
  return ref
}

export interface TransportHandle {
  /**
   * `hero` is nullable because a stage whose hero failed to mount still goes live (see
   * `main.ts`'s `rebuild`): the transport re-points at it and disables itself rather than
   * disappearing, so a reader can still see which stage is bound.
   */
  bind(built: BuiltStage, hero: pc.View | null, gridViews: ReadonlyMap<string, pc.View>): void
  setStatus(text: string): void
}

function renderPlayReport(el: HTMLElement, report: pc.StagePlayReport<pc.View>): void {
  const lines: string[] = [
    `started ${String(report.started.length)} · skipped ${String(report.skipped.length)} · ` +
      `failed ${String(report.failed.length)} · completed ${String(report.completed)}`,
  ]
  // Skipping is never silent (§4.4): every skip's reason and correlating tag, not just a count.
  for (const s of report.skipped) lines.push(`  skip ${s.tag ?? '(untagged)'}: ${s.reason}`)
  for (const f of report.failed) lines.push(`  fail ${f.tag ?? '(untagged)'}: ${f.error.message}`)
  el.textContent = lines.join('\n')
}

/**
 * The pose scrubber, the two run entry points (`play` for fold/unfold, `swapTo` for the
 * headline exchange), and the broadcast. One `<div id="transport">` built once; `bind()` re-points
 * every control at the stage a rebuild just produced, exactly as `panel.rebuild` does.
 */
export function createTransport(
  report: (line: string) => void,
  audio: AudioHandle,
): TransportHandle {
  let built: BuiltStage | null = null
  let hero: pc.View | null = null
  let gridViews: ReadonlyMap<string, pc.View> = new Map()
  let currentSampleId: string | null = null
  // Step 3's module-level slot, scoped to this factory instead: whichever run — fold, unfold or
  // swap — started most recently. `hero.run` reaches the same object; this is what makes Stop
  // reachable from a button that does not otherwise hold a reference to it.
  let currentRun: pc.Run<pc.PlayResult | pc.SwapResult> | null = null
  let runController: AbortController | null = null
  let unsubscribers: Array<() => void> = []

  const root = document.createElement('div')
  root.className = 'transport'

  const summaryLine = document.createElement('p')
  summaryLine.className = 'transport-summary'
  root.append(summaryLine)

  const statusLine = document.createElement('p')
  statusLine.className = 'transport-status'
  root.append(statusLine)

  // --- Step 2: the pose scrubber ---------------------------------------------------------
  const poseRow = document.createElement('div')
  poseRow.className = 'transport-row'
  const poseLabel = document.createElement('span')
  poseLabel.textContent = 'pose (draw only — no run, no events)'
  const poseInput = document.createElement('input')
  poseInput.type = 'range'
  poseInput.className = 'transport-input'
  poseInput.min = '0'
  poseInput.max = String(pc.DWELL_MS.length - 1)
  poseInput.step = '1'
  const poseReadout = document.createElement('span')
  poseReadout.className = 'transport-readout'

  function refreshPoseReadout(): void {
    if (hero === null) {
      poseReadout.textContent = ''
      return
    }
    poseReadout.textContent = `hero.pose ${String(hero.pose)} · hero.state ${hero.state}`
  }

  poseInput.addEventListener('input', () => {
    if (hero === null) return
    hero.draw(Number(poseInput.value))
    refreshPoseReadout()
  })
  poseRow.append(poseLabel, poseInput, poseReadout)
  root.append(poseRow)

  // --- Step 3: fold, unfold, stop ---------------------------------------------------------
  const foldRow = document.createElement('div')
  foldRow.className = 'transport-row'
  const foldButton = document.createElement('button')
  foldButton.type = 'button'
  foldButton.textContent = 'fold (flat → ball)'
  const unfoldButton = document.createElement('button')
  unfoldButton.type = 'button'
  unfoldButton.textContent = 'unfold (ball → flat)'
  const stopButton = document.createElement('button')
  stopButton.type = 'button'
  stopButton.textContent = 'stop'

  async function runFold(from: pc.PoseRef, to: pc.PoseRef): Promise<void> {
    if (hero === null) return
    // Synchronous, inside the click: that is what lets the AudioContext resume under the
    // autoplay policy, and it hands back the clip's length as the run's `duration` (or
    // `undefined` when sound is off, silent, or in "fixed run" mode). One `duration` is the whole
    // of the sync — `playPlan` spreads it over the traversed dwells as
    // `(duration × cumulative) / authored`, so the authored uneven cadence survives and the run
    // ends when the clip does.
    const duration = audio.beginSequence(playSpec(poseIndex(from), poseIndex(to)))
    // `start` is already emitted, synchronously, before this line returns.
    const run = hero.play(from, to, { duration: duration ?? FOLD_DURATION_MS })
    currentRun = run
    const r = await run
    audio.endSequence()
    if (r === pc.ABORTED) return
    if (r instanceof Error) {
      report(`fold failed: ${r.message}`)
      return
    }
    refreshPoseReadout()
  }

  foldButton.addEventListener('click', () => void runFold('flat', 'ball'))
  unfoldButton.addEventListener('click', () => void runFold('ball', 'flat'))
  stopButton.addEventListener('click', () => {
    currentRun?.stop()
    audio.cancel()
  })
  foldRow.append(foldButton, unfoldButton, stopButton)
  root.append(foldRow)

  // --- Step 4: the broadcast ---------------------------------------------------------------
  const broadcastRow = document.createElement('div')
  broadcastRow.className = 'transport-row'
  const broadcastFoldButton = document.createElement('button')
  broadcastFoldButton.type = 'button'
  broadcastFoldButton.textContent = 'broadcast fold (all views)'
  const broadcastUnfoldButton = document.createElement('button')
  broadcastUnfoldButton.type = 'button'
  broadcastUnfoldButton.textContent = 'broadcast unfold (all views)'
  const broadcastReportEl = document.createElement('pre')
  broadcastReportEl.className = 'transport-report'

  async function runBroadcast(from: pc.PoseRef, to: pc.PoseRef): Promise<void> {
    if (built === null) return
    // One clip for the whole broadcast, not one per view: `duration` is *per view*, so the last
    // tile still finishes `(views − 1) × stagger` after the clip ends. That overhang is real and
    // is printed below rather than hidden — the clip cannot be stretched to cover it without
    // desynchronising every individual tile from it.
    const duration = audio.beginSequence(playSpec(poseIndex(from), poseIndex(to), 'broadcast '))
    // `stage.play` never returns an Error and never rejects — it keeps the §4.4 report instead
    // of a `Run`, because one settled value cannot say tile 3 was busy while tile 5 had no sprite.
    const r = await built.stage.play(from, to, {
      duration: duration ?? FOLD_DURATION_MS,
      stagger: BROADCAST_STAGGER_MS,
    })
    audio.endSequence()
    renderPlayReport(broadcastReportEl, r)
    const overhang = Math.max(0, r.started.length - 1) * BROADCAST_STAGGER_MS
    broadcastReportEl.textContent +=
      `\n  stagger overhang ${String(overhang)} ms ` +
      `(${String(Math.max(0, r.started.length - 1))} gaps × ${String(BROADCAST_STAGGER_MS)} ms) — ` +
      'the last view outlasts the clip by this much; duration is per view.'
  }

  broadcastFoldButton.addEventListener('click', () => void runBroadcast('flat', 'ball'))
  broadcastUnfoldButton.addEventListener('click', () => void runBroadcast('ball', 'flat'))
  broadcastRow.append(broadcastFoldButton, broadcastUnfoldButton)
  root.append(broadcastRow, broadcastReportEl)

  // --- Step 5 + 6: swap through the ball, honouring reduced motion -----------------------
  const swapRow = document.createElement('div')
  swapRow.className = 'transport-row'
  const swapSelect = document.createElement('select')
  swapSelect.className = 'transport-input'
  const swapButton = document.createElement('button')
  swapButton.type = 'button'
  swapButton.textContent = 'swap'
  const reduceIndicator = document.createElement('span')
  reduceIndicator.className = 'transport-readout'

  const reduceQuery = matchMedia('(prefers-reduced-motion: reduce)')
  function refreshReduceIndicator(): void {
    reduceIndicator.textContent =
      `prefers-reduced-motion: ${reduceQuery.matches ? 'reduce' : 'no-preference'}` +
      (reduceQuery.matches ? ' — swap degrades to show(), no run' : '')
  }
  reduceQuery.addEventListener('change', refreshReduceIndicator)

  function populateSwapSelect(): void {
    swapSelect.replaceChildren()
    for (const sample of SAMPLES) {
      if (sample.id === currentSampleId) continue
      const opt = document.createElement('option')
      opt.value = sample.id
      opt.textContent = sample.label
      swapSelect.append(opt)
    }
    const broken = document.createElement('option')
    broken.value = BROKEN_KEY
    broken.textContent = 'broken URL (rollback demo)'
    swapSelect.append(broken)
  }

  async function runSwap(): Promise<void> {
    if (hero === null || built === null) return
    const targetId = swapSelect.value

    runController?.abort()
    const controller = new AbortController()
    runController = controller

    if (reduceQuery.matches) {
      // The whole reduced-motion accommodation (docs/USAGE.md §2): one draw at 'flat', no run,
      // nothing to stop — and therefore nothing to sound, because a crumple sound over a single
      // instantaneous draw is the same unrequested motion cue in another channel.
      audio.cancel()
      if (targetId === BROKEN_KEY) {
        const sprite = await built.stage.add(BROKEN_URL, {
          key: BROKEN_KEY,
          signal: controller.signal,
        })
        if (sprite === pc.ABORTED) return
        if (sprite instanceof Error) {
          report(`reduced-motion swap target failed to load: ${sprite.message}`)
          return
        }
        hero.show(sprite)
      } else {
        // Already mounted as a grid tile under this exact key — reuse it rather than re-`add()`,
        // which `add()` would refuse as a live key.
        const existing = built.stage.get(targetId)
        if (existing === undefined) {
          report(`playground: reduced-motion swap target "${targetId}" is not mounted`)
          return
        }
        hero.show(existing)
        currentSampleId = targetId
      }
      refreshPoseReadout()
      populateSwapSelect()
      return
    }

    const src =
      targetId === BROKEN_KEY ? BROKEN_URL : (SAMPLES.find((s) => s.id === targetId)?.url ?? null)
    if (src === null) {
      report(`playground: unknown swap target "${targetId}"`)
      return
    }

    // A swap's basis is the ten-gap rise / ball-hold / fall, not a play's five — `swapSpec`
    // mirrors `authoredSwapTotal` so the printed factor is the one `swapPlan` will use. Its
    // `total` is `duration` verbatim, so a scaled swap ends with the clip — *except* that the
    // park at the ball is never rescaled below the time the new sprite takes to load, so a first,
    // uncached swap runs longer than the clip by that load. The inspector's `last run` row
    // measures it rather than hiding it.
    const duration = audio.beginSequence(swapSpec(hero.pose))
    // `start` has already been emitted, synchronously, before this line — `swapTo` mints its own
    // internal key from the source, so it never collides with the grid's `sample.id` keys.
    const run = hero.swapTo(src, {
      duration: duration ?? SWAP_DURATION_MS,
      signal: controller.signal,
    })
    currentRun = run
    const r = await run
    audio.endSequence()
    if (r === pc.ABORTED) return
    if (r instanceof Error) {
      report(`swap failed, rolled back to the previous sprite: ${r.message}`)
      refreshPoseReadout()
      return
    }
    if (targetId !== BROKEN_KEY) currentSampleId = targetId
    refreshPoseReadout()
    populateSwapSelect()
  }

  swapButton.addEventListener('click', () => void runSwap())
  swapRow.append(swapSelect, swapButton, reduceIndicator)
  root.append(swapRow)

  // --- Sound ---------------------------------------------------------------------------------
  // Off until ticked, and the clips are only fetched on that tick. Everything else about it is
  // in `src/audio.ts`; the transport's whole share of it is the `duration` above.
  root.append(audio.element)

  // --- Step 6: the cadence ------------------------------------------------------------------
  const cadenceLine = document.createElement('p')
  cadenceLine.className = 'transport-cadence'
  cadenceLine.textContent =
    `pc.DWELL_MS = ${JSON.stringify(pc.DWELL_MS)} — the authored cadence, frozen. Chaining two ` +
    "play() calls by hand (flat→ball, then ball→flat) does not reproduce crumpleTo's ball hold " +
    '(DWELL_MS[5]); swapTo holds it for you.'
  root.append(cadenceLine)

  function bind(
    nextBuilt: BuiltStage,
    nextHero: pc.View | null,
    nextGridViews: ReadonlyMap<string, pc.View>,
  ): void {
    for (const off of unsubscribers) off()
    unsubscribers = []

    runController?.abort()
    runController = null
    currentRun = null
    // A rebuild disposes the stage the running clip was started for; leaving it playing would be
    // a sound with nothing on screen making it.
    audio.cancel()

    built = nextBuilt
    hero = nextHero
    gridViews = nextGridViews
    currentSampleId = hero?.sprite?.key ?? null

    // No hero view means nothing to subscribe to and no pose to read back. Every control below
    // already guards `hero === null` on its own handler, so the transport renders in full and
    // simply does nothing when clicked — the same shape the panel takes in that state.
    if (hero !== null) {
      unsubscribers.push(hero.on('start', refreshPoseReadout))
      unsubscribers.push(hero.on('step', refreshPoseReadout))
      unsubscribers.push(hero.on('end', refreshPoseReadout))
      poseInput.value = String(hero.pose)
    }
    refreshPoseReadout()
    refreshReduceIndicator()
    populateSwapSelect()
    broadcastReportEl.textContent = ''
    summaryLine.textContent =
      `${hero === null ? 'no hero view (mount failed)' : 'hero'} + ` +
      `${String(gridViews.size)} grid tiles bound (${built.present} present)`
  }

  function setStatus(text: string): void {
    statusLine.textContent = text
  }

  const slot = document.getElementById(TRANSPORT_SLOT)
  if (slot !== null) {
    slot.replaceChildren()
    slot.append(root)
  }

  return { bind, setStatus }
}
