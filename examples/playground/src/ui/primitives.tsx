import { useCallback, useRef } from 'react'
import type { ReactNode } from 'react'
import { decimals, pctOf } from '../knobs'

/**
 * The four controls `Paper Crumple Control Panel v2.dc.html` builds everything else out of, one
 * component each. Every class they render is defined in `styles.css` as a copy of the matching
 * inline `style` attribute in that file.
 */

// --- section ------------------------------------------------------------------------------------

export interface SectionProps {
  /** Zero-padded in the design ("01", "02", …); passed already formatted. */
  readonly number: string
  readonly title: string
  readonly summary?: string
  readonly open: boolean
  readonly onToggle: () => void
  readonly children: ReactNode
}

export function Section({
  number,
  title,
  summary,
  open,
  onToggle,
  children,
}: SectionProps): ReactNode {
  return (
    <section className="section">
      <button type="button" className="section-header" onClick={onToggle} aria-expanded={open}>
        <span className="section-number">{number}</span>
        <span className="section-title">{title}</span>
        {summary !== undefined && (
          <span className="section-summary" title={summary}>
            {summary}
          </span>
        )}
        <span className="section-chevron" aria-hidden="true">
          {open ? '▼' : '▶'}
        </span>
      </button>
      {open && <div className="section-body">{children}</div>}
    </section>
  )
}

// --- segmented ----------------------------------------------------------------------------------

export interface SegmentedOption<T extends string> {
  readonly id: T
  readonly label: string
  readonly title?: string
  readonly disabled?: boolean
}

export interface SegmentedProps<T extends string> {
  readonly options: readonly SegmentedOption<T>[]
  readonly value: T | null
  readonly onChange: (id: T) => void
  readonly label: string
  /** The design's Hull/Torn/Both toggle spreads its segments across the full width; the bucket
   *  and sync groups keep their intrinsic width. */
  readonly fill?: boolean
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  fill = false,
}: SegmentedProps<T>): ReactNode {
  return (
    <div
      className={fill ? 'segmented segmented--fill' : 'segmented'}
      role="radiogroup"
      aria-label={label}
    >
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={o.id === value}
          title={o.title}
          disabled={o.disabled}
          className={o.id === value ? 'segment segment--active' : 'segment'}
          onClick={() => {
            onChange(o.id)
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

// --- slider -------------------------------------------------------------------------------------

export interface SliderProps {
  readonly label: string
  readonly value: number
  readonly min: number
  readonly max: number
  readonly step: number
  /** The design reserves a fixed 16px column for it even when it is empty, so the tracks of a
   *  unit-carrying and a unit-less row still line up. */
  readonly unit?: string
  readonly onChange: (value: number) => void
  readonly disabled?: boolean
}

/**
 * The design's composite: an editable number field and a hand-drawn track that share one value.
 *
 * The track is divs rather than an `<input type="range">` because the design draws it that way —
 * a 4px rail, an accent fill, and a 14px thumb that overhangs the rail on both sides. The drag,
 * the keyboard steps and the rounding below are ports of the mockup's own `trackDown` /
 * `trackKey` / `numChange`, including its `Math.round(raw / step) * step` quantisation, so a
 * value dragged here lands exactly where the same drag lands in the design.
 */
export function Slider({
  label,
  value,
  min,
  max,
  step,
  unit,
  onChange,
  disabled = false,
}: SliderProps): ReactNode {
  const trackRef = useRef<HTMLDivElement>(null)
  const dec = decimals(step)
  const pct = `${pctOf(value, min, max).toFixed(2)}%`

  const commit = useCallback(
    (raw: number) => {
      const clamped = Math.max(min, Math.min(max, raw))
      onChange(Number((Math.round(clamped / step) * step).toFixed(dec)))
    },
    [min, max, step, dec, onChange],
  )

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (disabled) return
      const rect = trackRef.current?.getBoundingClientRect()
      if (rect === undefined) return
      const apply = (clientX: number): void => {
        const t = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
        commit(min + t * (max - min))
      }
      apply(e.clientX)
      const move = (ev: PointerEvent): void => {
        apply(ev.clientX)
      }
      const up = (): void => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
      e.preventDefault()
    },
    [commit, disabled, min, max],
  )

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (disabled) return
      const big = e.shiftKey ? 10 : 1
      const d =
        e.key === 'ArrowRight' || e.key === 'ArrowUp'
          ? step * big
          : e.key === 'ArrowLeft' || e.key === 'ArrowDown'
            ? -step * big
            : 0
      if (d === 0) return
      // The page's own ← / → step through poses; a focused track must keep those keys.
      e.preventDefault()
      e.stopPropagation()
      commit(value + d)
    },
    [commit, disabled, step, value],
  )

  return (
    <div className="slider">
      <span className="slider-label">{label}</span>
      <div className="slider-value">
        <input
          type="number"
          className="slider-number"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          aria-label={label}
          onChange={(e) => {
            const raw = e.target.value
            if (raw === '') return
            const n = Number(raw)
            if (Number.isNaN(n)) return
            commit(n)
          }}
        />
        <span className="slider-unit">{unit ?? ''}</span>
      </div>
      <div
        className="slider-track-wrap"
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-disabled={disabled}
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
      >
        <div className="slider-track" ref={trackRef}>
          <div className="slider-fill" style={{ width: pct }} />
          <div className="slider-thumb" style={{ left: pct }} />
        </div>
      </div>
    </div>
  )
}

// --- sub-card -----------------------------------------------------------------------------------

export interface SubCardProps {
  readonly title: string
  /** The design paints the "Shared" card's bullet grey and every edge-mode card's accent. */
  readonly muted?: boolean
  /** "Shared" also carries a little more bottom padding, because it ends on a colour row rather
   *  than on a slider's own track. */
  readonly padded?: boolean
  readonly children: ReactNode
}

export function SubCard({
  title,
  muted = false,
  padded = false,
  children,
}: SubCardProps): ReactNode {
  return (
    <div className={padded ? 'subcard subcard--padded' : 'subcard'}>
      <div className="subcard-head">
        <span className={muted ? 'subcard-dot subcard-dot--muted' : 'subcard-dot'} />
        {title}
      </div>
      {children}
    </div>
  )
}
