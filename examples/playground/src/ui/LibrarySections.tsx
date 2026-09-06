import type { ReactNode } from 'react'
import type { DemoConfig, PresentMode } from '../config'
import type { Entry, KnobValues } from '../knobs'
import { isNumberLike, stepOf } from '../knobs'
import { GROUP_ORDER, labelFor } from '../labels'
import { Segmented, Slider } from './primitives'

/**
 * Everything the design's curated sections leave out — NO counterpart in the mockup, and kept
 * deliberately.
 *
 * `Paper Crumple Control Panel v2.dc.html` shows roughly twenty controls; the engine declares
 * about forty. The other twenty are real, reachable knobs, and they keep a home in the numbered
 * sections after "05 Look & debug", grouped by the library's own taxonomy (`labels.ts`'s
 * `GROUP_ORDER`) and drawn with the same row primitives the curated sections use.
 *
 * The numbering is computed, not written down: only groups that still have knobs left after the
 * curated sections have claimed theirs get a section at all, and they take 06, 07, … in
 * `GROUP_ORDER` sequence. A group emptied by a future addition to a curated section therefore
 * disappears without leaving a hole in the sequence behind it.
 */

/**
 * Every patch key one of the design's own sections already renders.
 *
 * "02 Edge" now renders every shape and finish knob its rebuilt sub-cards carry (task 9,
 * `EdgeSection.tsx`'s `SHAPE_ROWS` / `FINISH_ROWS`), not only the small subset the old
 * `HULL_ROWS` / `TORN_ROWS` picked out — so this set grew past the brief's literal "drops the
 * five deleted keys and gains `sheet.edgeWidth`, `sheet.edgeVariance`" to also curate the shape-
 * and finish-only knobs the new sub-cards show, so they are not ALSO rendered a second time by
 * `libraryGroups` below. Flagged as a deviation in the task-9 report.
 */
export const CURATED_KEYS: ReadonlySet<string> = new Set([
  // 02 Edge — universal
  'sheet.edgeWidth',
  'sheet.edgeVariance',
  // 02 Edge — shape (smooth or torn)
  'sheet.angularity',
  'sheet.tearFreq',
  'sheet.tearAngular',
  'sheet.looseness',
  'sheet.tearMix',
  'sheet.chew',
  // 02 Edge — finish (paper only)
  'sheet.deckleWidth',
  'sheet.deckleLight',
  'sheet.deckleTex',
  'sheet.fibers',
  'sheet.fiberLen',
  'sheet.tearShadow',
  // 02 Edge — shared
  'sheet.sheetCrumple',
  'sheet.seed',
  'paperColor',
  'paperBack',
  // 05 Look & debug
  'motion.ambient',
  'motion.aoStrength',
  'motion.aoGamma',
  'motion.backShade',
  'motion.grain',
  'motion.debug',
])

export interface LibraryGroup {
  readonly group: string
  readonly entries: readonly Entry[]
}

/** The leftover knobs, grouped and ordered the way `labels.ts` groups and orders them. */
export function libraryGroups(entries: readonly Entry[]): LibraryGroup[] {
  const rest = entries.filter((e) => !CURATED_KEYS.has(e.key))
  const buckets = new Map<string, Entry[]>()
  for (const entry of rest) {
    const group = labelFor(entry.key)?.group ?? 'Unlabelled'
    const list = buckets.get(group)
    if (list === undefined) buckets.set(group, [entry])
    else list.push(entry)
  }
  for (const [group, list] of buckets) {
    list.sort((a, b) => (labelFor(a.key)?.order ?? 0) - (labelFor(b.key)?.order ?? 0))
    buckets.set(group, list)
  }
  return [...GROUP_ORDER, 'Unlabelled']
    .filter((g) => (buckets.get(g)?.length ?? 0) > 0)
    .map((group) => ({ group, entries: buckets.get(group) ?? [] }))
}

export interface KnobRowsProps {
  readonly entries: readonly Entry[]
  readonly knobs: KnobValues
  readonly onSet: (key: string, value: string | number | boolean) => Error | undefined
}

/** One row per descriptor, dispatched on `kind`. A descriptor `labels.ts` has no entry for is
 *  still rendered, under its raw patch key — which is what keeps that table from rotting. */
export function KnobRows({ entries, knobs, onSet }: KnobRowsProps): ReactNode {
  return (
    <>
      {entries.map(({ key, k }) => {
        const label = labelFor(key)?.label ?? key
        const dev = k.dev === true ? <span className="knob-dev">dev</span> : null

        if (isNumberLike(k)) {
          const value = typeof knobs[key] === 'number' ? (knobs[key] as number) : k.default
          return (
            <Slider
              key={key}
              label={label}
              value={value}
              min={k.min}
              max={k.max}
              step={stepOf(k)}
              unit={k.ui?.unit}
              onChange={(v) => {
                onSet(key, v)
              }}
            />
          )
        }

        if (k.kind === 'bool') {
          const value = typeof knobs[key] === 'boolean' ? (knobs[key] as boolean) : k.default
          return (
            <label className="knob-bool" key={key}>
              <input
                type="checkbox"
                checked={value}
                onChange={(e) => {
                  onSet(key, e.target.checked)
                }}
              />
              {label}
              {dev}
            </label>
          )
        }

        if (k.kind === 'color') {
          const value = typeof knobs[key] === 'string' ? (knobs[key] as string) : k.default
          return (
            <div className="color-row" key={key}>
              <span className="seed-label">{label}</span>
              <div className="color-value">
                <span className="color-hex">{value}</span>
                <input
                  type="color"
                  className="color-input"
                  aria-label={label}
                  value={value}
                  onChange={(e) => {
                    onSet(key, e.target.value)
                  }}
                />
              </div>
            </div>
          )
        }

        const value = typeof knobs[key] === 'string' ? (knobs[key] as string) : k.default
        return (
          <div className="row" key={key}>
            <span className="row-label">
              {label}
              {dev}
            </span>
            <select
              className="select"
              aria-label={label}
              value={value}
              onChange={(e) => {
                onSet(key, e.target.value)
              }}
            >
              {k.values.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </div>
        )
      })}
    </>
  )
}

// --- factory options ----------------------------------------------------------------------------

export interface FactorySectionProps {
  readonly config: DemoConfig
  readonly onChange: (next: DemoConfig) => void
}

/**
 * The `DemoConfig` factory options — also NO counterpart in the mockup, and also real: each one
 * changes the shape of the program rather than one draw, which is why every control here rebuilds
 * the stage (§6.5). `edgeShape` / `edgeFinish` / `edgeWidthUnit` are absent: the curated "02 Edge"
 * shape / finish / unit toggles own them, and two controls writing one option would only disagree.
 */
export function FactorySection({ config, onChange }: FactorySectionProps): ReactNode {
  return (
    <>
      <div className="row">
        <span className="row-label">present</span>
        <Segmented<PresentMode>
          label="present"
          value={config.present}
          onChange={(present) => {
            onChange({ ...config, present })
          }}
          options={[
            { id: 'blit', label: 'blit', title: 'one 2D canvas per view, blitted into' },
            { id: 'direct', label: 'direct', title: "the stage's own canvas, one rect per view" },
          ]}
        />
      </div>

      <label className="knob-bool">
        <input
          type="checkbox"
          checked={config.tiles}
          onChange={(e) => {
            onChange({ ...config, tiles: e.target.checked })
          }}
        />
        paper tiles
      </label>

      <div className="slider-divider">
        <Slider
          label="artwork css px"
          value={config.artworkCssPx}
          min={120}
          max={720}
          step={10}
          unit="px"
          onChange={(artworkCssPx) => {
            onChange({ ...config, artworkCssPx })
          }}
        />
        <Slider
          label="front budget"
          value={config.budgetMb}
          min={8}
          max={512}
          step={8}
          unit="MB"
          onChange={(budgetMb) => {
            onChange({ ...config, budgetMb })
          }}
        />
        <Slider
          label="overscan headroom"
          value={config.overscanHeadroom}
          min={0}
          max={1}
          step={0.01}
          onChange={(overscanHeadroom) => {
            onChange({ ...config, overscanHeadroom })
          }}
        />
      </div>

      <p className="note">
        Every option here is a factory option, not a knob: changing one rebuilds the stage and
        re-mounts the sheet, where a knob costs one draw.
      </p>
    </>
  )
}
