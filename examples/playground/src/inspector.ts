import * as pc from '@paper-crumple/core'
import type { BuiltStage } from './config'

const INSPECTOR_ROOT_ID = 'inspector'

/** §10.6's cap: a `step` stream runs at animation-frame cadence and must not grow the log
 *  without bound. Oldest lines drop first. */
const EVENT_LOG_CAP = 200

/** No cap is named for the two error columns in the brief, but an unbounded list is the same
 *  hazard `EVENT_LOG_CAP` guards against for a demo left running — bounded for the same reason. */
const CHANNEL_CAP = 200

export interface Inspector {
  /** An Error the demo narrowed out of a return value. */
  observed(where: string, error: Error): void
  /** An `onError` payload. `observed: false` is the orphan §10.6 exists for. */
  fromChannel(e: pc.StageEvent<'error'>): void
  attach(built: BuiltStage, budgetBytes?: number): void
  refreshUsage(): void
  line(text: string): void
}

interface ObservedEntry {
  readonly where: string
  readonly message: string
}

/** `view === null` marks a stage-originated event; otherwise the re-emission is labelled with
 *  the view's own `tag` (§7.1's `StageEvent<E>.view`). */
function originOf(view: pc.View | null): string {
  return view === null ? 'stage' : (view.tag ?? '(untagged)')
}

function formatBytes(n: number): string {
  return `${(n / (1024 * 1024)).toFixed(2)} MiB`
}

function appendCapped<T>(list: T[], entry: T, cap: number): void {
  list.push(entry)
  while (list.length > cap) list.shift()
}

export function createInspector(): Inspector {
  let built: BuiltStage | null = null
  let budgetBytes: number | undefined
  let unsubscribers: Array<() => void> = []

  const eventLines: string[] = []
  const observedEntries: ObservedEntry[] = []
  // Orphans only ever hold `observed: false` payloads (§10.6) — `fromChannel` filters before
  // this array ever sees an entry, so nothing here needs a second `observed` flag.
  const orphanMessages: string[] = []

  const root = document.getElementById(INSPECTOR_ROOT_ID)

  // --- Facts -------------------------------------------------------------------------------
  const factsSection = document.createElement('section')
  factsSection.className = 'inspector-section'
  const factsHeading = document.createElement('h3')
  factsHeading.textContent = 'Facts'
  const factsList = document.createElement('dl')
  factsList.className = 'inspector-facts'
  factsSection.append(factsHeading, factsList)

  // --- Warnings ------------------------------------------------------------------------------
  const warningsSection = document.createElement('section')
  warningsSection.className = 'inspector-section'
  const warningsHeading = document.createElement('h3')
  const warningsList = document.createElement('ul')
  warningsList.className = 'inspector-warnings'
  warningsSection.append(warningsHeading, warningsList)

  // --- Events --------------------------------------------------------------------------------
  const eventsSection = document.createElement('section')
  eventsSection.className = 'inspector-section'
  const eventsHeading = document.createElement('h3')
  eventsHeading.textContent = `Events (capped at ${String(EVENT_LOG_CAP)} lines)`
  const eventsLog = document.createElement('pre')
  eventsLog.className = 'inspector-events'
  eventsSection.append(eventsHeading, eventsLog)

  // --- Usage ---------------------------------------------------------------------------------
  const usageSection = document.createElement('section')
  usageSection.className = 'inspector-section'
  const usageHeading = document.createElement('h3')
  usageHeading.textContent = 'Usage'
  const usageList = document.createElement('dl')
  usageList.className = 'inspector-usage'
  usageSection.append(usageHeading, usageList)

  // --- The two error channels, side by side ---------------------------------------------------
  const channelsSection = document.createElement('section')
  channelsSection.className = 'inspector-section'
  const channelsHeading = document.createElement('h3')
  channelsHeading.textContent = 'Error channels'
  const channelsNote = document.createElement('p')
  channelsNote.className = 'inspector-note'
  channelsNote.textContent =
    '`onError` exists for the error raised inside a scheduled step, with no caller on the stack ' +
    'and no return value to become. `observed: true` means the error is, or will be, a return ' +
    'value someone can narrow — reporting it here as well double-counts every handled failure, ' +
    'which is why telemetry filters on `!observed`. `ABORTED` is never emitted on this channel ' +
    'at all.'

  const channelsGrid = document.createElement('div')
  channelsGrid.className = 'inspector-channels'

  const observedColumn = document.createElement('div')
  observedColumn.className = 'inspector-channel'
  const observedHeading = document.createElement('h4')
  const observedList = document.createElement('ul')
  observedColumn.append(observedHeading, observedList)

  const orphanColumn = document.createElement('div')
  orphanColumn.className = 'inspector-channel'
  const orphanHeading = document.createElement('h4')
  const orphanList = document.createElement('ul')
  orphanColumn.append(orphanHeading, orphanList)

  channelsGrid.append(observedColumn, orphanColumn)
  channelsSection.append(channelsHeading, channelsNote, channelsGrid)

  if (root !== null) {
    root.replaceChildren(
      factsSection,
      warningsSection,
      eventsSection,
      usageSection,
      channelsSection,
    )
  }

  function setRows(dl: HTMLDListElement, rows: ReadonlyArray<readonly [string, string]>): void {
    dl.replaceChildren()
    for (const [k, v] of rows) {
      const dt = document.createElement('dt')
      dt.textContent = k
      const dd = document.createElement('dd')
      dd.textContent = v
      dl.append(dt, dd)
    }
  }

  function renderFacts(): void {
    const dup = pc.assertSingleCore()
    const rows: Array<readonly [string, string]> = [
      ['pc.VERSION', pc.VERSION],
      ['assertSingleCore()', dup instanceof Error ? dup.message : 'ok — single core in this realm'],
    ]
    if (built !== null) {
      rows.push(
        ['caps.maxTextureSize', String(built.stage.caps.maxTextureSize)],
        ['caps.floatRT', String(built.stage.caps.floatRT)],
        ['caps.timer', String(built.stage.caps.timer)],
        ['stage.lost', String(built.stage.lost)],
        ['surface.presentable', String(built.stage.surface.presentable)],
        ['stage.views.length', String(built.stage.views.length)],
      )
    }
    setRows(factsList, rows)
  }

  function renderWarnings(): void {
    const warnings = built?.stage.warnings ?? []
    warningsHeading.textContent = `Warnings (${String(warnings.length)})`
    warningsList.replaceChildren()
    for (const w of warnings) {
      const li = document.createElement('li')
      li.textContent = w.message
      warningsList.append(li)
    }
  }

  function renderEvents(): void {
    eventsLog.textContent = eventLines.join('\n')
    eventsLog.scrollTop = eventsLog.scrollHeight
  }

  function renderUsage(): void {
    const rows: Array<readonly [string, string]> = []
    if (built !== null) {
      const u = built.stage.usage()
      const budgetText =
        budgetBytes === undefined
          ? formatBytes(u.bytes)
          : `${formatBytes(u.bytes)} / ${formatBytes(budgetBytes)} ` +
            `(${((u.bytes / budgetBytes) * 100).toFixed(1)}%)`
      rows.push(
        ['front bytes / budget', budgetText],
        ['reclaimable', formatBytes(u.reclaimable)],
        ['unreclaimable', formatBytes(u.unreclaimable)],
        ['fronts', String(u.fronts)],
        ['pinned', String(u.pinned)],
        ['attached', String(u.attached)],
        ['handles', String(u.handles)],
      )
      const hero = built.stage.views[0]
      if (hero !== undefined) {
        rows.push(
          ['hero.idealSize', `${String(hero.idealSize.w)} × ${String(hero.idealSize.h)}`],
          ['hero.state', hero.state],
          ['hero.pose', String(hero.pose)],
        )
      }
    }
    setRows(usageList, rows)
  }

  function renderChannels(): void {
    observedHeading.textContent = `observed (${String(observedEntries.length)})`
    observedList.replaceChildren()
    for (const entry of observedEntries) {
      const li = document.createElement('li')
      li.textContent = `${entry.where}: ${entry.message}`
      observedList.append(li)
    }

    orphanHeading.textContent = `orphans (${String(orphanMessages.length)})`
    orphanList.replaceChildren()
    for (const message of orphanMessages) {
      const li = document.createElement('li')
      li.textContent = message
      orphanList.append(li)
    }
  }

  function pushEventLine(text: string): void {
    appendCapped(eventLines, text, EVENT_LOG_CAP)
    renderEvents()
  }

  function refreshUsage(): void {
    renderUsage()
  }

  function onStart(e: pc.StageEvent<'start'>): void {
    const via = e.via !== undefined ? ` via=${String(e.via)}` : ''
    const duration = e.duration !== undefined ? ` duration=${String(e.duration)}ms` : ''
    pushEventLine(
      `start  ${originOf(e.view)} from=${String(e.from)} to=${String(e.to)}${via}${duration}`,
    )
  }

  function onStep(e: pc.StageEvent<'step'>): void {
    pushEventLine(
      `step   ${originOf(e.view)} pose=${String(e.pose)} frame=${String(e.frame)} ms=${e.ms.toFixed(1)}`,
    )
  }

  function onEnd(e: pc.StageEvent<'end'>): void {
    pushEventLine(
      `end    ${originOf(e.view)} from=${String(e.from)} to=${String(e.to)} completed=${String(e.completed)}`,
    )
    // A run's end is exactly the moment §10.6's usage figures may have moved — a swap can add a
    // sprite, an unfold can release one. Never on a timer; only on events that can actually change it.
    refreshUsage()
  }

  function onErrorEvent(e: pc.StageEvent<'error'>): void {
    pushEventLine(`error  ${originOf(e.view)} observed=${String(e.observed)} ${e.error.message}`)
  }

  function onLost(e: pc.StageEvent<'lost'>): void {
    pushEventLine(`lost   ${originOf(e.view)}`)
    refreshUsage()
  }

  function attach(nextBuilt: BuiltStage, nextBudgetBytes?: number): void {
    for (const off of unsubscribers) off()
    unsubscribers = []

    built = nextBuilt
    budgetBytes = nextBudgetBytes

    unsubscribers.push(built.stage.on('start', onStart))
    unsubscribers.push(built.stage.on('step', onStep))
    unsubscribers.push(built.stage.on('end', onEnd))
    unsubscribers.push(built.stage.on('error', onErrorEvent))
    unsubscribers.push(built.stage.on('lost', onLost))

    renderFacts()
    renderWarnings()
    refreshUsage()
  }

  function observed(where: string, error: Error): void {
    appendCapped(observedEntries, { where, message: error.message }, CHANNEL_CAP)
    renderChannels()
  }

  function fromChannel(e: pc.StageEvent<'error'>): void {
    // `observed: true` means this same failure is, or will be, a return value someone narrows —
    // that path already calls `observed()` above. Counting it here too would double it, which is
    // exactly what the note above the two columns says telemetry must not do.
    if (e.observed) return
    appendCapped(orphanMessages, `${originOf(e.view)}: ${e.error.message}`, CHANNEL_CAP)
    renderChannels()
  }

  function line(text: string): void {
    pushEventLine(`status ${text}`)
  }

  renderFacts()
  renderWarnings()
  renderUsage()
  renderChannels()
  renderEvents()

  return { observed, fromChannel, attach, refreshUsage, line }
}
