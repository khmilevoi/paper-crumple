import * as pc from '@paper-crumple/core'

/**
 * Sound for the fold, ported from the spike's `src/audio.js`. Everything audio lives in this
 * file; the transport only asks it for a `duration` and hands it the direction.
 *
 * The spike's three shaping constraints survive the port, two of them changed by the port:
 *
 * 1. THE SPIKE OWNED ITS OWN STEP TIMER and had to keep the sound from drifting away from it,
 *    which is what `audio.nextDelay(dwell)` was for: `deadline += dwell; max(0, deadline - now())`.
 *    The library owns the scheduler now, and `stepper.ts` is that same absolute-deadline loop with
 *    one refinement (a backgrounded tab's accumulated deficit is capped at one gap). So there is
 *    no `nextDelay` here and there must not be one — re-adding it would be a second scheduler
 *    fighting the library's.
 *
 * 2. THE DWELL SCHEDULE IS NOT COPIED. `pc.DWELL_MS` is imported and only ever read, and the
 *    rescale is expressed the only way the library accepts it: one `duration` for the whole run.
 *    `playPlan` turns that into `(duration * cumulative) / authored` per step, so the authored
 *    uneven stop-motion rhythm survives and retuning the library retunes the sound with it. The
 *    step arithmetic repeated below is for the *readout* only — it mirrors the library's exact
 *    form so the printed schedule is the one that will actually run, not an approximation of it.
 *
 * 3. THE CLIP LENGTH IS KNOWN BEFORE THE CONTEXT EXISTS. `manifest.json` carries the measured
 *    `durationSec` of every trimmed clip, so a schedule can be computed without an
 *    `AudioContext` — which matters because a context created before a user gesture starts
 *    suspended. The context here is created by the "enable sound" checkbox, which is the gesture.
 *
 * One constraint the spike did not have: **the assets are gitignored**, because they are not this
 * repository's to redistribute. Anyone who clones has no `public/audio/`, so every load path here
 * degrades to silence and reports itself — through the inspector and through one visible line in
 * the control strip — rather than failing. That is also why nothing is fetched at boot: the
 * probe happens on the opt-in, so a clean clone's console stays as empty as it is today.
 */

/** Vite serves `public/` at the root, so this is `examples/playground/public/audio/`. */
const AUDIO_DIR = '/audio/'
const MANIFEST_URL = `${AUDIO_DIR}manifest.json`
const STORAGE_KEY = 'paperCrumple.playground.audio.v1'

/** Where a reader who has no `public/audio/` gets one. Rendered verbatim in the UI. */
export const ASSETS_ORIGIN =
  'examples/playground/public/audio/ is gitignored — copy manifest.json and the five .wav files ' +
  'from the spike (spikes/paper-fold/assets/audio/) to hear the fold; see the demo README.'

export const NO_CLIP = 'none'

/** A crumple, for a crumple animation — the spike's own default, once a reader opts in. */
const DEFAULT_CLIP = 'mixkit-quick-paper-crumple-sound-2996'

type SyncMode = 'scale' | 'fixed'

// `short` is what the button shows — the sidebar is only 396px wide, and the full `label` wraps
// onto two lines there. `label` is not lost: it goes on the button's `title` (a hover tooltip)
// and still describes the mode everywhere else (the inspector's `rows()`, for one).
const SYNC_MODES: ReadonlyArray<{ id: SyncMode; short: string; label: string }> = [
  { id: 'scale', short: 'scale to clip', label: 'scale the run to the clip' },
  { id: 'fixed', short: 'fixed', label: 'fixed run, clip plays over it' },
]

const FLAT_POSE = 0
const BALL_POSE = pc.DWELL_MS.length - 1

// --- manifest ---------------------------------------------------------------------------------

interface Clip {
  readonly id: string
  readonly file: string
  readonly label: string
  readonly durationSec: number
  readonly sampleRate: number | null
  readonly channels: number | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * A missing `public/audio/` is not always a 404: Vite's dev server answers some unmatched paths
 * with `index.html`, and `response.json()` then rejects on the leading `<`. Either way the result
 * is an Error the caller renders — the manifest is never trusted to be shaped correctly just
 * because a response arrived.
 */
function parseManifest(value: unknown): Clip[] | Error {
  if (!Array.isArray(value)) return new Error('manifest.json is not an array of clips')
  const clips: Clip[] = []
  for (const entry of value as unknown[]) {
    if (!isRecord(entry)) return new Error('manifest.json holds an entry that is not an object')
    const { id, file, label, durationSec } = entry
    if (typeof id !== 'string' || typeof file !== 'string' || typeof label !== 'string') {
      return new Error('manifest.json holds an entry without a string id / file / label')
    }
    if (typeof durationSec !== 'number' || !(durationSec > 0)) {
      return new Error(`manifest.json entry "${id}" has no positive durationSec`)
    }
    clips.push({
      id,
      file,
      label,
      durationSec,
      sampleRate: optionalNumber(entry.sampleRate),
      channels: optionalNumber(entry.channels),
    })
  }
  if (clips.length === 0) return new Error('manifest.json lists no clips')
  return clips
}

function toError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason))
}

/**
 * `fetch` rejects rather than returning, and `examples/` returns its errors. Handling the
 * rejection in `then`'s second argument — the shape `main.ts`'s clipboard guard already uses —
 * keeps that true without a `try` and without a `throw`.
 */
async function fetchOr(url: string): Promise<Response | Error> {
  const res = await fetch(url, { cache: 'no-store' }).then(
    (r) => r,
    (reason: unknown) => toError(reason),
  )
  if (res instanceof Error) return res
  if (!res.ok) return new Error(`${url} → HTTP ${String(res.status)} ${res.statusText}`)
  return res
}

// --- schedule arithmetic ------------------------------------------------------------------------

/** What a run is asked to fit into, and what it is called in the readout. */
export interface SequenceSpec {
  readonly label: string
  /**
   * The authored wall time the library rescales — every traversed dwell **excluding the last
   * pose's**. Including it is the 15 % error `dwell.ts` names by hand.
   */
  readonly authored: number
  /** The authored gaps, in order, for the printed per-step schedule. */
  readonly dwells: readonly number[]
  /** Uncrumpling really does sound like a crumple played backwards, and reversing is a memcpy. */
  readonly reverse: boolean
}

/**
 * The gaps a `play(from, to)` spends: `schedule[from..to)`, walked in the run's direction.
 * `schedule` defaults to `pc.DWELL_MS` but a caller bound to a custom pose schedule (`poses.ts`,
 * via `transport.ts`'s own `currentDwells`) passes its actual dwells instead — the authored
 * six-pose cadence is one instance of a dwell table, not the only one.
 */
function traversedDwells(from: number, to: number, schedule: readonly number[]): number[] {
  const direction = to >= from ? 1 : -1
  const out: number[] = []
  for (let p = from; p !== to; p += direction) out.push(schedule[p])
  return out
}

export function playSpec(
  from: number,
  to: number,
  prefix = '',
  schedule: readonly number[] = pc.DWELL_MS,
): SequenceSpec {
  const dwells = traversedDwells(from, to, schedule)
  return {
    label: `${prefix}${to < from ? 'unfold' : 'fold'} ${String(from)} → ${String(to)}`,
    authored: dwells.reduce((a, b) => a + b, 0),
    dwells,
    reverse: to < from,
  }
}

/**
 * A swap's basis, mirroring `authoredSwapTotal`: the rise's gaps, the ball's own dwell as the
 * hold — the gap no ordinary traversal ever spends — and the fall's gaps. The library does not
 * export the helper, so the demo repeats the ten-gap shape rather than guessing at it. `schedule`
 * defaults to `pc.DWELL_MS`; its own last index is the ball pose, whatever the schedule's length.
 */
export function swapSpec(from: number, schedule: readonly number[] = pc.DWELL_MS): SequenceSpec {
  const ballPose = schedule.length - 1
  const rise = traversedDwells(from, ballPose, schedule)
  const fall = traversedDwells(ballPose - 1, FLAT_POSE, schedule)
  const dwells = [...rise, schedule[ballPose], ...fall]
  return {
    label: `swap from ${String(from)}`,
    authored: dwells.reduce((a, b) => a + b, 0),
    dwells,
    reverse: false,
  }
}

/**
 * The gaps the library will actually run, computed the library's way:
 * `offset[i] = (duration * cumulative[i]) / authored`, and the gap is the difference of two
 * offsets. Multiplying each dwell by `duration / authored` instead drifts by a fraction of a
 * millisecond per step and would make the readout disagree with the run it describes.
 */
export function scaledGaps(spec: SequenceSpec, duration: number): number[] {
  if (spec.authored === 0) return [...spec.dwells]
  let cumulative = 0
  let previous = 0
  const gaps: number[] = []
  for (const dwell of spec.dwells) {
    cumulative += dwell
    const offset = (duration * cumulative) / spec.authored
    gaps.push(offset - previous)
    previous = offset
  }
  return gaps
}

// --- preferences ---------------------------------------------------------------------------------

interface Prefs {
  clipId: string
  volume: number
  sync: SyncMode
}

// Storage throws in private mode, with cookies blocked, and inside some embedded viewers. None of
// that should stop the demo from folding, so every access is a no-op on failure. `enabled` is
// deliberately *not* persisted: sound is opt-in on every load, so a page never makes a sound —
// or a network request for audio — that this visit did not ask for.
function loadPrefs(): Partial<Prefs> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) return {}
    const parsed: unknown = JSON.parse(raw)
    return isRecord(parsed) ? (parsed as Partial<Prefs>) : {}
  } catch {
    return {}
  }
}

function savePrefs(prefs: Prefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
  } catch {
    /* ignore — a lost preference is not worth a broken page */
  }
}

// --- the controller -------------------------------------------------------------------------------

export interface AudioHandle {
  /** The control strip. The transport appends it into its own row stack. */
  readonly element: HTMLElement
  /**
   * Starts the clip and returns the `duration` the run should be given, or `undefined` to keep
   * the caller's own. Call it *synchronously* from the click handler: that is what lets
   * `resume()` succeed under the autoplay policy.
   */
  beginSequence(spec: SequenceSpec): number | undefined
  /** Called when the run settles, so the readout can print measured against requested. */
  endSequence(): void
  /** Stop the clip — the transport's Stop button, and every rebind. */
  cancel(): void
  /** The numbers the inspector prints. A sound cannot be seen in a screenshot. */
  rows(): ReadonlyArray<readonly [string, string]>
}

const ms = (v: number): string => `${v.toFixed(1)} ms`

export function createAudio(
  observed: (where: string, error: Error) => void,
  onChange: () => void,
): AudioHandle {
  const stored = loadPrefs()
  const state = {
    enabled: false,
    clipId: typeof stored.clipId === 'string' ? stored.clipId : DEFAULT_CLIP,
    volume:
      typeof stored.volume === 'number' && Number.isFinite(stored.volume)
        ? Math.min(1, Math.max(0, stored.volume))
        : 0.8,
    sync: SYNC_MODES.some((m) => m.id === stored.sync) ? (stored.sync as SyncMode) : 'scale',
  }

  let clips: readonly Clip[] = []
  /** Bytes, fetched once. Decoding needs a context and the context waits for the gesture. */
  const raw = new Map<string, ArrayBuffer>()
  const decoded = new Map<string, AudioBuffer>()
  const reversed = new Map<string, AudioBuffer>()
  /** Per-clip load failures: a manifest can outlive one of the files it names. */
  const missing = new Map<string, string>()

  let ctx: AudioContext | null = null
  let gain: GainNode | null = null
  let source: AudioBufferSourceNode | null = null
  let loading = false
  let loadError: Error | null = null
  let lastRun: string = '—'
  let pending: { spec: SequenceSpec; duration: number | undefined; startedAt: number } | null = null

  // --- DOM ---------------------------------------------------------------------------------

  const element = document.createElement('div')
  element.className = 'transport-audio'

  const row = document.createElement('div')
  row.className = 'transport-row'

  const enableLabel = document.createElement('label')
  enableLabel.className = 'transport-audio-enable'
  const enableInput = document.createElement('input')
  enableInput.type = 'checkbox'
  const enableText = document.createElement('span')
  enableText.textContent = 'sound'
  enableLabel.append(enableInput, enableText)

  const clipSelect = document.createElement('select')
  clipSelect.className = 'transport-input'
  clipSelect.disabled = true

  // The sync mode is a two-way choice ("scale the run to the clip" vs. "fixed run, clip plays
  // over it"), so in the v2 design it is a `.segmented` control rather than a `<select>` — same
  // `SYNC_MODES` list and the same `state.sync`/`persist`/`paint` wiring underneath, just a
  // different widget on top of it.
  const syncGroup = document.createElement('div')
  syncGroup.className = 'segmented'
  const syncButtons = new Map<SyncMode, HTMLButtonElement>()
  for (const mode of SYNC_MODES) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'segmented-btn'
    button.textContent = mode.short
    button.title = mode.label
    button.disabled = true
    button.addEventListener('click', () => {
      if (state.sync === mode.id) return
      state.sync = mode.id
      persist()
      paint()
      onChange()
      updateSyncButtons()
    })
    syncGroup.append(button)
    syncButtons.set(mode.id, button)
  }

  function updateSyncButtons(): void {
    for (const [id, button] of syncButtons) {
      button.classList.toggle('segmented-btn--active', id === state.sync)
    }
  }

  const volumeInput = document.createElement('input')
  volumeInput.type = 'range'
  volumeInput.className = 'transport-input transport-audio-volume'
  volumeInput.min = '0'
  volumeInput.max = '1'
  volumeInput.step = '0.01'
  volumeInput.value = String(state.volume)
  volumeInput.disabled = true
  const volumeOut = document.createElement('span')
  volumeOut.className = 'transport-readout'
  volumeOut.textContent = `vol ${state.volume.toFixed(2)}`

  // Mirrors `poseInput`'s treatment in transport.ts: `--fill-pct` (styles.css) paints the track up
  // to the thumb and has to be recomputed on init and on every `input` event.
  function refreshVolumeFill(): void {
    const min = Number(volumeInput.min)
    const max = Number(volumeInput.max)
    const value = Number(volumeInput.value)
    const pct = max > min ? ((value - min) / (max - min)) * 100 : 0
    volumeInput.style.setProperty('--fill-pct', `${String(pct)}%`)
  }
  refreshVolumeFill()

  row.append(enableLabel, clipSelect, syncGroup, volumeInput, volumeOut)

  const readout = document.createElement('p')
  readout.className = 'transport-readout transport-audio-readout'

  // The one line requirement (2) asks for: where the assets come from, always visible, and what
  // actually happened to them once a probe has run.
  const note = document.createElement('p')
  note.className = 'transport-audio-note'
  note.textContent = `sound is off until you tick it — ${ASSETS_ORIGIN}`

  element.append(row, readout, note)

  // --- clip data ------------------------------------------------------------------------------

  const clipById = (id: string): Clip | null => clips.find((c) => c.id === id) ?? null

  /** Trimmed length in ms: the decoded buffer once there is one, the manifest before that. */
  function clipMs(id: string): number {
    const buffer = decoded.get(id)
    if (buffer !== undefined) return buffer.duration * 1000
    const clip = clipById(id)
    return clip === null ? 0 : clip.durationSec * 1000
  }

  const haveClip = (id: string): boolean => id !== NO_CLIP && clipById(id) !== null

  /**
   * `state.clipId` is what the reader *asked* for and survives a reload; this is what the page
   * can actually act on. Before the probe, and after one that found nothing, they differ — which
   * is the whole absent-assets case: the preference is kept, the behaviour is silence.
   */
  const activeClipId = (): string => (haveClip(state.clipId) ? state.clipId : NO_CLIP)

  // --- loading ---------------------------------------------------------------------------------

  async function loadManifest(): Promise<void> {
    if (loading || clips.length > 0) return
    loading = true
    loadError = null
    paint()

    const res = await fetchOr(MANIFEST_URL)
    if (res instanceof Error) {
      loading = false
      loadError = res
      observed('audio manifest', res)
      fillClipSelect()
      paint()
      onChange()
      return
    }

    const body = await res.json().then(
      (v: unknown) => v,
      (reason: unknown) => toError(reason),
    )
    // A 404 is not the only shape "the folder is absent" takes: Vite's dev server answers an
    // unmatched path with the app shell, so the response is 200 and it is `json()` that rejects,
    // on the leading `<`. Naming that here is the difference between a legible absence and a
    // stray SyntaxError.
    const parsed =
      body instanceof Error
        ? new Error(
            `${MANIFEST_URL} did not parse as JSON — the dev server answered with the app shell, ` +
              `which is what a missing public/audio/ looks like (${body.message})`,
          )
        : parseManifest(body)
    if (parsed instanceof Error) {
      loading = false
      loadError = parsed
      observed('audio manifest', parsed)
      fillClipSelect()
      paint()
      onChange()
      return
    }

    clips = parsed
    // Bytes only, in parallel. A clip the manifest names but the folder does not hold is recorded
    // and left selectable: its schedule still works, because the length came from the manifest.
    await Promise.all(
      clips.map(async (clip) => {
        const file = await fetchOr(AUDIO_DIR + clip.file)
        if (file instanceof Error) {
          missing.set(clip.id, file.message)
          observed(`audio clip ${clip.id}`, file)
          return
        }
        const bytes = await file.arrayBuffer().then(
          (b) => b,
          (reason: unknown) => toError(reason),
        )
        if (bytes instanceof Error) {
          missing.set(clip.id, bytes.message)
          observed(`audio clip ${clip.id}`, bytes)
          return
        }
        raw.set(clip.id, bytes)
      }),
    )
    loading = false
    fillClipSelect()
    await decodeAll()
    paint()
    onChange()
  }

  // --- context ----------------------------------------------------------------------------------

  function ensureContext(): AudioContext | null {
    if (ctx !== null) return ctx
    if (typeof AudioContext === 'undefined') {
      const err = new Error('playground: this browser has no AudioContext — sound stays silent')
      if (loadError === null) loadError = err
      observed('AudioContext', err)
      return null
    }
    const next = new AudioContext()
    const node = next.createGain()
    node.gain.value = state.volume
    node.connect(next.destination)
    ctx = next
    gain = node
    return next
  }

  function resumeContext(): void {
    if (ctx === null || ctx.state !== 'suspended') return
    void ctx.resume().then(undefined, (reason: unknown) => {
      observed('AudioContext.resume', toError(reason))
    })
  }

  /** Decodes every fetched clip once and caches it. Safe to call repeatedly. */
  async function decodeAll(): Promise<void> {
    const context = ensureContext()
    if (context === null) return
    await Promise.all(
      clips.map(async (clip) => {
        if (decoded.has(clip.id)) return
        const bytes = raw.get(clip.id)
        if (bytes === undefined) return
        // decodeAudioData detaches its input, so hand it a copy or the second decode fails.
        const buffer = await context.decodeAudioData(bytes.slice(0)).then(
          (b) => b,
          (reason: unknown) => toError(reason),
        )
        if (buffer instanceof Error) {
          missing.set(clip.id, buffer.message)
          observed(`audio decode ${clip.id}`, buffer)
          return
        }
        decoded.set(clip.id, buffer)
      }),
    )
    paint()
    onChange()
  }

  function reverseBuffer(context: AudioContext, buffer: AudioBuffer): AudioBuffer {
    const out = context.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate)
    for (let c = 0; c < buffer.numberOfChannels; c += 1) {
      const src = buffer.getChannelData(c)
      const dst = out.getChannelData(c)
      for (let i = 0, n = src.length; i < n; i += 1) dst[i] = src[n - 1 - i]
    }
    return out
  }

  function bufferFor(id: string, backwards: boolean): AudioBuffer | null {
    const forward = decoded.get(id)
    if (forward === undefined) return null
    if (!backwards) return forward
    const cached = reversed.get(id)
    if (cached !== undefined) return cached
    const context = ensureContext()
    if (context === null) return forward
    const flipped = reverseBuffer(context, forward)
    reversed.set(id, flipped)
    return flipped
  }

  // The spike's warm-up, kept: the pointer press that precedes the click on Fold is a real
  // gesture, so by the time the button is released the context is running and every clip is
  // decoded — which is what makes the FIRST fold as tightly synced as the tenth.
  function warm(): void {
    if (!state.enabled || activeClipId() === NO_CLIP) return
    if (decoded.size >= clips.length && ctx?.state === 'running') return
    if (ensureContext() === null) return
    resumeContext()
    void decodeAll()
  }
  document.addEventListener('pointerdown', warm, { capture: true })
  document.addEventListener('keydown', warm, { capture: true })

  // --- playback ------------------------------------------------------------------------------

  function stop(): void {
    if (source === null) return
    // Always started before it is stopped, and `stop()` on a source that has already ended is a
    // documented no-op — so this needs no guard of its own.
    source.stop()
    source.disconnect()
    source = null
  }

  function beginSequence(spec: SequenceSpec): number | undefined {
    stop()
    pending = null
    const clipId = activeClipId()
    if (!state.enabled || clipId === NO_CLIP) {
      paint(spec)
      return undefined
    }

    ensureContext()
    resumeContext()

    // Sound and schedule are independent: a clip that has not finished decoding — or whose file
    // never arrived — still yields the right duration, because the length came from the manifest.
    const buffer = bufferFor(clipId, spec.reverse)
    if (buffer !== null && ctx !== null && gain !== null) {
      const node = ctx.createBufferSource()
      node.buffer = buffer
      node.connect(gain)
      node.start()
      source = node
    } else {
      void decodeAll()
    }

    const length = clipMs(clipId)
    const duration = state.sync === 'scale' && length > 0 && spec.authored > 0 ? length : undefined
    pending = { spec, duration, startedAt: performance.now() }
    paint(spec)
    onChange()
    return duration
  }

  function endSequence(): void {
    if (pending === null) return
    const measured = performance.now() - pending.startedAt
    const length = clipMs(activeClipId())
    const requested = pending.duration
    lastRun =
      `${pending.spec.label}: requested ${requested === undefined ? 'authored/fixed' : ms(requested)}` +
      ` · measured ${ms(measured)}` +
      (state.enabled && activeClipId() !== NO_CLIP && length > 0
        ? ` · clip ${ms(length)} · ${measured - length >= 0 ? '+' : ''}${(measured - length).toFixed(1)} ms vs clip`
        : '')
    const spec = pending.spec
    pending = null
    paint(spec)
    onChange()
  }

  function cancel(): void {
    stop()
    pending = null
  }

  // --- readout ---------------------------------------------------------------------------------

  /** The run the readout describes when nothing has run yet: the transport's own Fold button. */
  const DEFAULT_SPEC = playSpec(FLAT_POSE, BALL_POSE)

  function scheduleText(spec: SequenceSpec): string {
    const length = clipMs(activeClipId())
    if (!state.enabled || activeClipId() === NO_CLIP || length <= 0 || state.sync !== 'scale') {
      return (
        `${spec.label}: authored ${spec.dwells.map((d) => String(Math.round(d))).join('/')}` +
        ` = ${ms(spec.authored)} (the run keeps the transport's own duration)`
      )
    }
    const gaps = scaledGaps(spec, length)
    const total = gaps.reduce((a, b) => a + b, 0)
    return (
      `${spec.label}: ${gaps.map((g) => String(Math.round(g))).join('/')} = ${ms(total)}` +
      ` · ×${(length / spec.authored).toFixed(3)} from ${ms(spec.authored)}`
    )
  }

  function assetsText(): string {
    if (loading) return 'loading…'
    if (loadError !== null) return `absent — ${loadError.message}`
    if (clips.length === 0) return 'not probed yet (tick "sound")'
    return (
      `${String(clips.length)} clips, ${String(clips.length - missing.size)} loaded, ` +
      `${String(decoded.size)} decoded`
    )
  }

  // The sidebar's "04 Sound" header carries a short mono summary, same as every `panel.ts`-
  // generated section's own `.accordion-summary` — mirrors `stage-bg.ts`'s own direct
  // `document.getElementById` for its slot, since `main.ts` is off-limits for this change.
  function updateSummary(): void {
    const el = document.getElementById('sound-summary')
    if (el === null) return
    if (!state.enabled) {
      el.textContent = 'off'
      return
    }
    const clipId = activeClipId()
    el.textContent = clipId === NO_CLIP ? 'on · silent' : (clipById(clipId)?.label ?? clipId)
  }

  function paint(spec: SequenceSpec = DEFAULT_SPEC): void {
    const clipId = activeClipId()
    const length = clipMs(clipId)
    if (!state.enabled || clipId === NO_CLIP) {
      readout.textContent =
        `sound off — ${scheduleText(spec)}. ` +
        `pc.DWELL_MS is read, never copied; the rescale is one duration for the whole run.`
    } else {
      const clip = clipById(clipId)
      const lengthFrom = decoded.has(clipId) ? 'decoded' : 'manifest'
      const format =
        clip === null || clip.channels === null
          ? ''
          : ` · ${String(clip.channels)} ch ${String(clip.sampleRate ?? 0)} Hz`
      const missingWhy = missing.get(clipId)
      readout.textContent =
        `clip ${ms(length)} (${lengthFrom})${format} · ${scheduleText(spec)}` +
        (missingWhy === undefined ? '' : ` · SILENT: ${missingWhy}`)
    }

    if (loadError !== null) {
      note.textContent = `audio assets absent (${loadError.message}) — ${ASSETS_ORIGIN}`
    } else if (missing.size > 0) {
      note.textContent = `${String(missing.size)} clip(s) in the manifest did not load — ${ASSETS_ORIGIN}`
    } else if (!state.enabled) {
      note.textContent = `sound is off until you tick it — ${ASSETS_ORIGIN}`
    } else {
      note.textContent = `audio assets present (${assetsText()}) — ${ASSETS_ORIGIN}`
    }

    updateSummary()
  }

  function rows(): ReadonlyArray<readonly [string, string]> {
    const spec = DEFAULT_SPEC
    const unfold = playSpec(BALL_POSE, FLAT_POSE)
    const swap = swapSpec(FLAT_POSE)
    const clipId = activeClipId()
    const length = clipMs(clipId)
    const scaling = state.enabled && clipId !== NO_CLIP && state.sync === 'scale' && length > 0

    const durationFor = (s: SequenceSpec): string =>
      scaling
        ? `authored ${ms(s.authored)} → duration ${ms(length)} (×${(length / s.authored).toFixed(3)})`
        : `authored ${ms(s.authored)} → the transport's fixed duration`

    return [
      ['audio assets', `${AUDIO_DIR} — ${assetsText()}`],
      ['audio origin', ASSETS_ORIGIN],
      ['audio enabled', String(state.enabled)],
      [
        'audio clip',
        clipId === NO_CLIP
          ? `none — silent${clips.length > 0 && state.clipId !== NO_CLIP ? ` (asked for "${state.clipId}", which this manifest does not name)` : ''}`
          : `${clipId} · ${ms(length)} (${decoded.has(clipId) ? 'decoded' : 'manifest'})`,
      ],
      ['audio sync', SYNC_MODES.find((m) => m.id === state.sync)?.label ?? state.sync],
      ['audio volume', state.volume.toFixed(2)],
      [
        'AudioContext',
        ctx === null
          ? 'not created (no gesture yet)'
          : `${ctx.state} · currentTime ${ctx.currentTime.toFixed(3)} s · ${String(ctx.sampleRate)} Hz`,
      ],
      [spec.label, durationFor(spec)],
      [unfold.label, durationFor(unfold)],
      [swap.label, durationFor(swap)],
      ['next fold steps', scheduleText(spec)],
      ['last run', lastRun],
    ]
  }

  // --- ui ---------------------------------------------------------------------------------------

  function fillClipSelect(): void {
    clipSelect.replaceChildren()
    const none = document.createElement('option')
    none.value = NO_CLIP
    none.textContent = clips.length === 0 ? 'none — silent (no clips)' : 'none — silent'
    clipSelect.append(none)
    for (const clip of clips) {
      const option = document.createElement('option')
      option.value = clip.id
      option.textContent =
        `${clip.label} — ${String(Math.round(clip.durationSec * 1000))} ms` +
        (missing.has(clip.id) ? ' (missing file)' : '')
      clipSelect.append(option)
    }
    // A stored id can outlive the file it names — a renamed clip must not leave the `<select>`
    // pointing at nothing. `activeClipId` keeps the preference itself intact.
    clipSelect.value = activeClipId()
  }

  const persist = (): void =>
    savePrefs({ clipId: state.clipId, volume: state.volume, sync: state.sync })

  function setControlsEnabled(): void {
    clipSelect.disabled = !state.enabled
    for (const button of syncButtons.values()) button.disabled = !state.enabled
    volumeInput.disabled = !state.enabled
  }

  enableInput.addEventListener('change', () => {
    state.enabled = enableInput.checked
    setControlsEnabled()
    if (state.enabled) {
      // This handler runs inside a real click, which is the gesture the autoplay policy wants —
      // so the context created here starts `running` rather than `suspended`.
      ensureContext()
      resumeContext()
      void loadManifest()
    } else {
      cancel()
    }
    paint()
    onChange()
  })

  clipSelect.addEventListener('change', () => {
    state.clipId = clipSelect.value
    persist()
    if (state.clipId !== NO_CLIP) void decodeAll()
    paint()
    onChange()
  })

  volumeInput.addEventListener('input', () => {
    state.volume = Number(volumeInput.value)
    volumeOut.textContent = `vol ${state.volume.toFixed(2)}`
    refreshVolumeFill()
    if (gain !== null) gain.gain.value = state.volume
    persist()
    onChange()
  })

  fillClipSelect()
  setControlsEnabled()
  updateSyncButtons()
  paint()

  return { element, beginSequence, endSequence, cancel, rows }
}
