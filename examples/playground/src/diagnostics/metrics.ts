import type { Sprite } from '@paper-crumple/core'
import type { SheetFit } from '@paper-crumple/motion'
import type { BuiltStage } from '../scene/config'
import type { Metric } from './Diagnostics'

interface MetricsInput {
  built: BuiltStage | null
  sprite: Sprite | null
  fit: SheetFit | null
  lastDrawMs: number | null
  lastStepMs: number | null
  mountMs: number | null
}

/** Use two decimals until the value needs more room in the diagnostics tile. */
const msText = (v: number): string => (v < 10 ? v.toFixed(2) : v.toFixed(1))

export function diagnosticsMetrics({
  built,
  sprite,
  fit,
  lastDrawMs,
  lastStepMs,
  mountMs,
}: MetricsInput): Metric[] {
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
}
