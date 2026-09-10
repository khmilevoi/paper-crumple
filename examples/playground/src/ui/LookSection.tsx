import type { ReactNode } from 'react'
import type { Knobs } from '@paper-crumple/core'
import type { Entry } from '../knobs'
import { isNumberLike, stepOf } from '../knobs'
import { Segmented, Slider } from './primitives'

/**
 * The design's five look sliders, in its order and under its labels — which are also the labels
 * the motion slot itself ships (`packages/motion/src/knobs.ts` declares `ui.label` on all five),
 * and whose defaults and ranges match the mockup's `DEFAULTS` exactly: ambient 0.86, baked AO
 * 0.48, AO gamma 0.3 over 0.1–2, reverse shade 0.94 over 0.3–1, fibre grain 0.18 over 0–0.6.
 */
const LOOK_ROWS: readonly { readonly key: string; readonly label: string }[] = [
  { key: 'motion.ambient', label: 'ambient' },
  { key: 'motion.aoStrength', label: 'baked AO' },
  { key: 'motion.aoGamma', label: 'AO gamma' },
  { key: 'motion.backShade', label: 'reverse shade' },
  { key: 'motion.grain', label: 'fibre grain' },
]

const DEBUG_KEY = 'motion.debug'

/**
 * The design's six debug chips and their swatch colours. The ids are `DEBUG_VIEWS`
 * (`packages/motion/src/shaders.ts`) verbatim — the same six values, in the same order, that the
 * `motion.debug` enum knob accepts — so a chip writes its own label straight through.
 */
const DEBUG_SWATCH: ReadonlyMap<string, string> = new Map([
  ['composite', '#d9ff62'],
  ['normals', '#6ea8ff'],
  ['ao', '#8a8a80'],
  ['uv', '#ff9f6e'],
  ['sheet alpha', '#c9c4b2'],
  ['facing', '#86e2a6'],
])

export type StageBackground = 'dark' | 'light' | 'checker'

export interface LookSectionProps {
  readonly entries: readonly Entry[]
  readonly knobs: Knobs
  /** A knob write is declarative now: it moves React state and `usePaperScene` writes the stage.
   *  A refusal arrives asynchronously through the scene's `onError`, so there is no Error to
   *  return. Every call site already ignored the return value. */
  readonly onSet: (key: string, value: string | number | boolean) => void
  readonly background: StageBackground
  readonly onBackgroundChange: (background: StageBackground) => void
}

export function LookSection({
  entries,
  knobs,
  onSet,
  background,
  onBackgroundChange,
}: LookSectionProps): ReactNode {
  const byKey = (key: string): Entry | undefined => entries.find((e) => e.key === key)
  const debug = byKey(DEBUG_KEY)
  const debugValue =
    typeof knobs[DEBUG_KEY] === 'string'
      ? (knobs[DEBUG_KEY] as string)
      : debug?.k.kind === 'enum'
        ? debug.k.default
        : 'composite'

  return (
    <>
      <div className="look-sliders">
        {LOOK_ROWS.map(({ key, label }) => {
          const entry = byKey(key)
          if (entry === undefined || !isNumberLike(entry.k)) return null
          const k = entry.k
          const value = typeof knobs[key] === 'number' ? (knobs[key] as number) : k.default
          return (
            <Slider
              key={key}
              label={label}
              value={value}
              min={k.min}
              max={k.max}
              step={stepOf(k)}
              onChange={(v) => {
                onSet(key, v)
              }}
            />
          )
        })}
      </div>

      {debug !== undefined && debug.k.kind === 'enum' && (
        <div className="debug-block">
          <span className="debug-title">Debug view</span>
          <div className="debug-grid" role="radiogroup" aria-label="debug view">
            {debug.k.values.map((id) => (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={id === debugValue}
                className={id === debugValue ? 'debug-chip debug-chip--active' : 'debug-chip'}
                onClick={() => {
                  onSet(DEBUG_KEY, id)
                }}
              >
                <span
                  className="debug-swatch"
                  style={{ background: DEBUG_SWATCH.get(id) ?? '#9b9b8b' }}
                />
                {id}
              </button>
            ))}
          </div>
        </div>
      )}

      {/*
        NO counterpart in the mockup, and kept deliberately: the canvas-background presets are how
        a reader sees whether the canvas itself is transparent rather than taking it on faith.
        'dark' is the page's own backdrop (so nothing to see), 'light' is the same solid-colour
        test at the other end, and 'checker' is the alpha checkerboard an opaque canvas can never
        blend into. It sits here because this is already the section for seeing what the renderer
        did, and it is drawn with the design's own row + segmented primitives.
      */}
      <div className="row">
        <span className="row-label">canvas background</span>
        <Segmented
          label="canvas background"
          value={background}
          onChange={onBackgroundChange}
          options={[
            { id: 'dark', label: 'dark' },
            { id: 'light', label: 'light' },
            { id: 'checker', label: 'checker' },
          ]}
        />
      </div>
    </>
  )
}
