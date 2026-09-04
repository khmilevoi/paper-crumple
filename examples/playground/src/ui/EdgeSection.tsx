import type { ReactNode } from 'react'
import { SHARED_KNOBS } from '@paper-crumple/core'
import type { PaperEdgeMode } from '@paper-crumple/paper'
import type { Entry, KnobValues } from '../knobs'
import { isNumberLike, stepOf } from '../knobs'
import { Segmented, Slider, SubCard } from './primitives'

/** The three segments of the design's edge toggle are exactly the library's three edge modes. */
export type UiEdgeMode = PaperEdgeMode

/**
 * Literal labels + order from `Paper Crumple Control Panel v2.dc.html`'s `hullSliders` /
 * `tornSliders`, mapped onto the real descriptors that back them (`HULL_KNOBS` / `TORN_KNOBS`,
 * `packages/paper/src/paper-knobs.ts`) — confirmed by matching defaults: min distance 22, max
 * distance 72, angularity 0.7, thickness 22, looseness 0.5, amplitude 44, deckle width 7, every
 * one identical to the mockup's own `DEFAULTS`. `sheet.deckleWidth`, not `sheet.deckleTex`.
 */
const HULL_ROWS: readonly { readonly key: string; readonly label: string }[] = [
  { key: 'sheet.minDist', label: 'min distance' },
  { key: 'sheet.maxDist', label: 'max distance' },
  { key: 'sheet.angularity', label: 'angularity' },
]

const TORN_ROWS: readonly { readonly key: string; readonly label: string }[] = [
  { key: 'sheet.thickness', label: 'thickness' },
  { key: 'sheet.looseness', label: 'looseness' },
  { key: 'sheet.tearAmp', label: 'amplitude' },
  { key: 'sheet.deckleWidth', label: 'deckle width' },
]

/** `sheet.sheetCrumple` → the mockup's "sheet relief"; `sheet.seed` gets a Reroll button rather
 *  than a slider, exactly as the mockup's own seed row does. */
const SHEET_RELIEF_KEY = 'sheet.sheetCrumple'
const SEED_KEY = 'sheet.seed'
/** `paperColor` / `paperBack` are the core-declared shared knobs
 *  (`packages/core/src/shared-knobs.ts`) → the mockup's "paper" / "paper reverse" colour rows.
 *  They are set through the bare key but are never listed in `built.sheet.knobs` /
 *  `built.motion.knobs` (`descriptorsFor()` excludes them by design), so they are read straight
 *  off `SHARED_KNOBS` rather than looked up in `entries`. */
const PAPER_KEY = 'paperColor'
const PAPER_BACK_KEY = 'paperBack'

/** The design's units column: the three distance-like knobs carry `px`, the rest nothing. */
const UNIT: ReadonlyMap<string, string> = new Map([
  ['sheet.minDist', 'px'],
  ['sheet.maxDist', 'px'],
  ['sheet.thickness', 'px'],
  ['sheet.tearAmp', 'px'],
  ['sheet.deckleWidth', 'px'],
])

export interface EdgeSectionProps {
  readonly entries: readonly Entry[]
  readonly knobs: KnobValues
  readonly mode: UiEdgeMode
  readonly onModeChange: (mode: UiEdgeMode) => void
  readonly onSet: (key: string, value: string | number | boolean) => Error | undefined
}

/**
 * "02 Edge", built to match the design literally: a Hull/Torn/Both toggle over two edge-mode
 * sub-cards plus an always-visible Shared sub-card.
 *
 * `edgeMode` is a factory option (`paperSheet({ edgeMode })`), so each segment rebuilds the
 * stage rather than writing a knob. Which sub-cards carry sliders follows from
 * `descriptorsFor()` (`packages/paper/src/paper-knobs.ts`): `hull` -> `HULL_KNOBS`, `torn` ->
 * `TORN_KNOBS`, `both` -> both lists, so the section grows from three sliders to seven. The
 * "not available" note is the fallback for a build whose descriptors do not match the picked
 * segment - a state the toggle itself no longer produces.
 */
export function EdgeSection({
  entries,
  knobs,
  mode,
  onModeChange,
  onSet,
}: EdgeSectionProps): ReactNode {
  const byKey = (key: string): Entry | undefined => entries.find((e) => e.key === key)
  const valueOf = (key: string, fallback: number): number => {
    const v = knobs[key]
    return typeof v === 'number' ? v : fallback
  }

  function sliders(list: readonly { readonly key: string; readonly label: string }[]): ReactNode {
    const rows: ReactNode[] = []
    let missing = false
    for (const { key, label } of list) {
      const entry = byKey(key)
      if (entry === undefined || !isNumberLike(entry.k)) {
        missing = true
        continue
      }
      const k = entry.k
      rows.push(
        <Slider
          key={key}
          label={label}
          value={valueOf(key, k.default)}
          min={k.min}
          max={k.max}
          step={stepOf(k)}
          unit={UNIT.get(key)}
          onChange={(v) => {
            onSet(key, v)
          }}
        />,
      )
    }
    if (missing) {
      rows.push(
        <p className="note" key="missing">
          not available — this build&apos;s sheet is not in a mode that carries these knobs
        </p>,
      )
    }
    return rows
  }

  // Narrowed once, out here: TypeScript cannot carry a narrowing on `entry.k` into the event
  // handlers below, which are closures over it.
  const seedEntry = byKey(SEED_KEY)
  const seedKnob = seedEntry !== undefined && isNumberLike(seedEntry.k) ? seedEntry.k : null
  const reliefEntry = byKey(SHEET_RELIEF_KEY)
  const reliefKnob = reliefEntry !== undefined && isNumberLike(reliefEntry.k) ? reliefEntry.k : null
  const paper = SHARED_KNOBS.find((d) => d.key === PAPER_KEY)
  const paperBack = SHARED_KNOBS.find((d) => d.key === PAPER_BACK_KEY)

  const colorOf = (key: string, fallback: string): string => {
    const v = knobs[key]
    return typeof v === 'string' ? v : fallback
  }

  return (
    <>
      <Segmented
        fill
        label="edge mode"
        value={mode}
        onChange={onModeChange}
        options={[
          { id: 'hull', label: 'Hull', title: 'hull — polygon cut sheet' },
          { id: 'torn', label: 'Torn', title: 'torn — procedural tear' },
          { id: 'both', label: 'Both', title: 'hull + torn — cut sheet, torn edge' },
        ]}
      />

      {mode !== 'torn' && <SubCard title="Hull — polygon cut sheet">{sliders(HULL_ROWS)}</SubCard>}
      {mode !== 'hull' && <SubCard title="Torn — procedural tear">{sliders(TORN_ROWS)}</SubCard>}

      <SubCard title="Shared" muted padded>
        {reliefKnob !== null && (
          <Slider
            label="sheet relief"
            value={valueOf(SHEET_RELIEF_KEY, reliefKnob.default)}
            min={reliefKnob.min}
            max={reliefKnob.max}
            step={stepOf(reliefKnob)}
            onChange={(v) => {
              onSet(SHEET_RELIEF_KEY, v)
            }}
          />
        )}

        {seedKnob !== null && (
          <div className="seed-row">
            <span className="seed-label">seed</span>
            <input
              type="number"
              className="seed-number"
              aria-label="seed"
              min={seedKnob.min}
              max={seedKnob.max}
              step={1}
              value={valueOf(SEED_KEY, seedKnob.default)}
              onChange={(e) => {
                const n = Number(e.target.value)
                if (Number.isNaN(n)) return
                onSet(SEED_KEY, Math.max(seedKnob.min, Math.min(seedKnob.max, Math.round(n))))
              }}
            />
            <button
              type="button"
              className="btn-small btn-small--push"
              onClick={() => {
                onSet(
                  SEED_KEY,
                  seedKnob.min + Math.floor(Math.random() * (seedKnob.max - seedKnob.min + 1)),
                )
              }}
            >
              Reroll
            </button>
          </div>
        )}

        {paper !== undefined && paper.kind === 'color' && (
          <div className="color-row">
            <span className="seed-label">paper</span>
            <div className="color-value">
              <span className="color-hex">{colorOf(PAPER_KEY, paper.default)}</span>
              <input
                type="color"
                className="color-input"
                aria-label="paper"
                value={colorOf(PAPER_KEY, paper.default)}
                onChange={(e) => {
                  onSet(PAPER_KEY, e.target.value)
                }}
              />
            </div>
          </div>
        )}

        {paperBack !== undefined && paperBack.kind === 'color' && (
          <div className="color-row color-row--joined">
            <span className="seed-label">paper reverse</span>
            <div className="color-value">
              <span className="color-hex">{colorOf(PAPER_BACK_KEY, paperBack.default)}</span>
              <input
                type="color"
                className="color-input"
                aria-label="paper reverse"
                value={colorOf(PAPER_BACK_KEY, paperBack.default)}
                onChange={(e) => {
                  onSet(PAPER_BACK_KEY, e.target.value)
                }}
              />
            </div>
          </div>
        )}
      </SubCard>
    </>
  )
}
