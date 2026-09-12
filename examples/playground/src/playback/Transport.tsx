import type { ReactNode } from 'react'

export interface PoseStep {
  /** The stored frame this pose slot shows — the design's big mono number. */
  readonly top: string
  readonly title: string
}

export interface TransportProps {
  readonly steps: readonly PoseStep[]
  readonly pose: number
  readonly readout: string
  readonly busy: boolean
  readonly onFold: () => void
  readonly onUnfold: () => void
  readonly onStepBack: () => void
  readonly onStepForward: () => void
  readonly onGoto: (pose: number) => void
}

/**
 * The design's transport card: the two run buttons, the pose stepper, the readout, the strip of
 * pose slots, and the keyboard hint.
 *
 * Clicking a slot in the strip is a `view.draw(...)` — a redraw at that pose with no run and no
 * events, which is why every one of them stays clickable while a run is in flight would be wrong:
 * `busy` disables them, because a draw underneath a running scheduler fights it for the same
 * view. The two arrow buttons are the same draw-only step and are disabled for the same reason.
 */
export function Transport({
  steps,
  pose,
  readout,
  busy,
  onFold,
  onUnfold,
  onStepBack,
  onStepForward,
  onGoto,
}: TransportProps): ReactNode {
  const last = steps.length - 1

  return (
    <div className="transport">
      <div className="transport-row">
        <button type="button" className="btn-primary" onClick={onFold} disabled={busy}>
          Fold
        </button>
        <button type="button" className="btn-large" onClick={onUnfold} disabled={busy}>
          Unfold
        </button>
        <div className="transport-steps">
          <button
            type="button"
            className="btn-step"
            title="previous pose (←)"
            aria-label="previous pose"
            onClick={onStepBack}
            disabled={busy || pose <= 0}
          >
            ◀
          </button>
          <button
            type="button"
            className="btn-step"
            title="next pose (→)"
            aria-label="next pose"
            onClick={onStepForward}
            disabled={busy || pose >= last}
          >
            ▶
          </button>
        </div>
        <span className="transport-readout">{readout}</span>
      </div>

      <div className="pose-strip">
        {steps.map((s, i) => (
          <button
            key={i}
            type="button"
            title={s.title}
            disabled={busy}
            className={i === pose ? 'pose-step pose-step--active' : 'pose-step'}
            onClick={() => {
              onGoto(i)
            }}
          >
            <span className="pose-step-top">{s.top}</span>
            <span className="pose-step-bottom">frm</span>
          </button>
        ))}
      </div>

      <span className="transport-hint">← → step through poses · space plays fold / unfold</span>
    </div>
  )
}
