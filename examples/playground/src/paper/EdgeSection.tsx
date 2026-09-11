import type { ReactNode } from 'react'
import { SHARED_KNOBS } from '@paper-crumple/core'
import type { IntKnob, NumberKnob } from '@paper-crumple/core'
import type { Knobs } from '@paper-crumple/core'
import type { EdgeSpec } from '@paper-crumple/paper'
import type { Entry } from '../controls/knobs'
import { isNumberLike, stepOf } from '../controls/knobs'
import { ceilingsFor } from './edge-ceilings'
import { Segmented, Slider, SubCard } from '../controls/primitives'

/**
 * design 2026-09-05 §2.2's shape-only knobs, one array per `edgeSpec.shape` — `HULL_ROWS` /
 * `TORN_ROWS` keyed off the old three-way `edgeMode`, these are keyed off the new `spec.shape`.
 * `angularity` is unchanged from the old `HULL_ROWS`; the other five replace it under `torn`.
 */
const SMOOTH_SHAPE_ROWS: readonly { readonly key: string; readonly label: string }[] = [
  { key: 'sheet.angularity', label: 'angularity' },
]

const TORN_SHAPE_ROWS: readonly { readonly key: string; readonly label: string }[] = [
  { key: 'sheet.tearFreq', label: 'tear frequency' },
  { key: 'sheet.tearAngular', label: 'tear angularity' },
  { key: 'sheet.looseness', label: 'looseness' },
  { key: 'sheet.tearMix', label: 'tear mix' },
  { key: 'sheet.chew', label: 'chew' },
]

/** design §2.3 — the six finish knobs, present only under `edgeFinish: 'paper'`. */
const FINISH_ROWS: readonly { readonly key: string; readonly label: string }[] = [
  { key: 'sheet.deckleWidth', label: 'deckle width' },
  { key: 'sheet.deckleLight', label: 'deckle highlight' },
  { key: 'sheet.deckleTex', label: 'deckle texture' },
  { key: 'sheet.fibers', label: 'fibre density' },
  { key: 'sheet.fiberLen', label: 'fibre length' },
  { key: 'sheet.tearShadow', label: 'tear shadow' },
]

const WIDTH_KEY = 'sheet.edgeWidth'
const VARIANCE_KEY = 'sheet.edgeVariance'

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

/**
 * The design's units column: no more hard-coded per-key map. A descriptor's own `reference`
 * already says whether it is quoted in sprite px, a percent of the artwork, or neither — the only
 * descriptor either of the first two ever appears on today is `edgeWidth` itself.
 */
const unitOf = (k: NumberKnob | IntKnob): string | undefined =>
  k.kind === 'number' && k.reference === 'sprite-px'
    ? 'px'
    : k.kind === 'number' && k.reference === 'artwork-pct'
      ? '%'
      : undefined

export interface EdgeSectionProps {
  readonly entries: readonly Entry[]
  readonly knobs: Knobs
  readonly spec: EdgeSpec
  readonly onSpecChange: (spec: EdgeSpec) => void
  /** A knob write is declarative now: it moves React state and `usePaperScene` writes the stage.
   *  A refusal arrives asynchronously through the scene's `onError`, so there is no Error to
   *  return. Every call site already ignored the return value. */
  readonly onSet: (key: string, value: string | number | boolean) => void
  /**
   * NOT in the brief's own `EdgeSectionProps` (task-9 brief, "Produces"): computing the live
   * ceiling below needs it and it is not otherwise derivable from `entries` / `knobs` / `spec`.
   * Flagged as a deviation in the task-9 report.
   */
  readonly overscanHeadroom: number
}

/**
 * "02 Edge": three segmented toggles (shape / finish / width unit) over two always-visible
 * sliders (`edgeWidth`, `edgeVariance`), a shape sub-card, a finish sub-card and the unchanged
 * Shared sub-card.
 *
 * Each segment calls `onSpecChange` with the WHOLE spec and rebuilds the stage — `edgeShape`,
 * `edgeFinish` and `edgeWidthUnit` are all factory options (design 2026-09-05 §6.5), exactly as
 * the deleted `edgeMode` segment did. The `missing` / "not available" fallback the old
 * `HULL_ROWS` / `TORN_ROWS` renderer carried is gone: the knob set now always matches the picked
 * `spec` exactly (`descriptorsFor`), so an absent descriptor is a bug, not a state this component
 * papers over — a row whose descriptor is absent renders nothing, silently, rather than a
 * reassuring note.
 */
export function EdgeSection({
  entries,
  knobs,
  spec,
  onSpecChange,
  onSet,
  overscanHeadroom,
}: EdgeSectionProps): ReactNode {
  const byKey = (key: string): Entry | undefined => entries.find((e) => e.key === key)
  const valueOf = (key: string, fallback: number): number => {
    const v = knobs[key]
    return typeof v === 'number' ? v : fallback
  }

  function sliders(list: readonly { readonly key: string; readonly label: string }[]): ReactNode {
    return list.map(({ key, label }) => {
      const entry = byKey(key)
      if (entry === undefined || !isNumberLike(entry.k)) return null
      const k = entry.k
      return (
        <Slider
          key={key}
          label={label}
          value={valueOf(key, k.default)}
          min={k.min}
          max={k.max}
          step={stepOf(k)}
          unit={unitOf(k)}
          onChange={(v) => {
            onSet(key, v)
          }}
        />
      )
    })
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

  const widthEntry = byKey(WIDTH_KEY)
  const widthKnob = widthEntry !== undefined && isNumberLike(widthEntry.k) ? widthEntry.k : null
  const varianceEntry = byKey(VARIANCE_KEY)
  const varianceKnob =
    varianceEntry !== undefined && isNumberLike(varianceEntry.k) ? varianceEntry.k : null

  // The live ceiling (task 9 brief): §8.6's frozen reserve bounds `edgeWidth` and `edgeVariance`
  // on any given sheet, past which `build()` answers `SheetError` "re-add required" rather than
  // rendering. Computed fresh every render — it is cheap, pure arithmetic (`edge-ceilings.ts`) —
  // from the CURRENT spec, headroom and live knob values, so it tracks every drag on either
  // slider and on the finish knobs that feed it (`fiberLen`, `deckleWidth`).
  const ceilings = ceilingsFor(spec, overscanHeadroom, knobs)
  const widthValue = valueOf(WIDTH_KEY, widthKnob?.default ?? 0)
  const varianceValue = valueOf(VARIANCE_KEY, varianceKnob?.default ?? 0)

  /**
   * The raw ceiling (`edge-ceilings.ts`) is almost never step-aligned. `Slider`'s own `commit`
   * (`primitives.tsx`) clamps to `max` FIRST and quantises to the descriptor's `step` SECOND
   * (`Math.round(clamped / step) * step`) — quantising a ceiling that sits mid-step can round the
   * committed value back UP past it (observed: a `torn`/`paper` ceiling of 67.96 with `step: 1`
   * let a drag land on 68, which the reserve then refused). Snapping the ceiling DOWN to the
   * nearest value the descriptor's own step can land on closes that gap: everything at or below
   * `widthMax` / `varianceMax` is both within the reserve AND a value `commit` can produce exactly.
   */
  const clampedMax = (
    declaredMax: number,
    declaredMin: number,
    step: number,
    ceiling: number | undefined,
  ): number => {
    if (ceiling === undefined) return declaredMax
    const bounded = Math.max(declaredMin, Math.min(declaredMax, ceiling))
    const steps = Math.floor((bounded - declaredMin) / step)
    return declaredMin + steps * step
  }

  const widthMax =
    widthKnob === null
      ? 0
      : clampedMax(widthKnob.max, widthKnob.min, stepOf(widthKnob), ceilings.widthMax)
  const varianceMax =
    varianceKnob === null
      ? 0
      : clampedMax(varianceKnob.max, varianceKnob.min, stepOf(varianceKnob), ceilings.varianceMax)

  return (
    <>
      <Segmented
        fill
        label="edge shape"
        value={spec.shape}
        onChange={(shape) => {
          if (shape !== spec.shape) onSpecChange({ ...spec, shape })
        }}
        options={[
          { id: 'smooth', label: 'Smooth', title: 'smooth — polygon cut sheet' },
          { id: 'torn', label: 'Torn', title: 'torn — procedural tear' },
        ]}
      />
      <Segmented
        fill
        label="edge finish"
        value={spec.finish}
        onChange={(finish) => {
          if (finish !== spec.finish) onSpecChange({ ...spec, finish })
        }}
        options={[
          { id: 'clean', label: 'Clean', title: 'clean — no paper decoration' },
          { id: 'paper', label: 'Paper', title: 'paper — deckle, fibres and tear shadow' },
        ]}
      />
      <Segmented
        fill
        label="edge width unit"
        value={spec.widthUnit}
        onChange={(widthUnit) => {
          if (widthUnit !== spec.widthUnit) onSpecChange({ ...spec, widthUnit })
        }}
        options={[
          { id: 'px', label: 'px', title: 'px — a fixed sprite-px width' },
          { id: 'percent', label: '%', title: '% — a percent of the artwork' },
        ]}
      />

      {widthKnob !== null && (
        <>
          <Slider
            label="edge width"
            value={widthValue}
            min={widthKnob.min}
            max={widthMax}
            step={stepOf(widthKnob)}
            unit={unitOf(widthKnob)}
            onChange={(v) => {
              onSet(WIDTH_KEY, v)
            }}
          />
          {widthValue === 0 && <p className="note">no edge — the sheet renders with no border</p>}
          {ceilings.widthMax === undefined ? (
            <p className="note">
              this build's exact reachable ceiling is not shown under the % unit — see the task-9
              report; dragging past it still reports the refusal on the status pill
            </p>
          ) : (
            widthMax < widthKnob.max && (
              <p className="note">
                capped at {widthMax.toFixed(1)} of its {widthKnob.max} — past this the sheet's
                frozen reserve refuses (design §8.6)
              </p>
            )
          )}
        </>
      )}

      {varianceKnob !== null && (
        <>
          <Slider
            label="edge variance"
            value={varianceValue}
            min={varianceKnob.min}
            max={varianceMax}
            step={stepOf(varianceKnob)}
            unit={unitOf(varianceKnob)}
            onChange={(v) => {
              onSet(VARIANCE_KEY, v)
            }}
          />
          {ceilings.varianceMax !== undefined &&
            Number.isFinite(ceilings.varianceMax) &&
            varianceMax < varianceKnob.max && (
              <p className="note">
                capped at {varianceMax.toFixed(2)} of its {varianceKnob.max} — past this the sheet's
                frozen reserve refuses (design §8.6)
              </p>
            )}
        </>
      )}

      <SubCard title={spec.shape === 'smooth' ? 'Shape — smooth' : 'Shape — torn'}>
        {sliders(spec.shape === 'smooth' ? SMOOTH_SHAPE_ROWS : TORN_SHAPE_ROWS)}
      </SubCard>

      {spec.finish === 'paper' && <SubCard title="Finish — paper">{sliders(FINISH_ROWS)}</SubCard>}

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
