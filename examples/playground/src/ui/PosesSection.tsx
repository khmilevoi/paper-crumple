import type { ReactNode } from 'react'

/** The library's own floor — `setKeyFrames` wants at least one key frame — and the design's
 *  ceiling: past twelve the selects stop being a grid. Slots may repeat, so the ceiling does not
 *  depend on the pack's frame count. */
export const MIN_POSES = 1
export const MAX_POSES = 12

export interface PosesSectionProps {
  /** The pack's stored frames, as simulation indices — what each select lists. */
  readonly frames: readonly number[]
  /** One stored-slot index per pose. */
  readonly keyFrames: readonly number[]
  readonly onCountChange: (count: number) => void
  readonly onKeyFrameChange: (pose: number, slot: number) => void
  readonly onManifest: () => void
  readonly onEven: () => void
  readonly disabled: boolean
}

/**
 * "03 Poses": the pose count, one select per pose slot choosing which stored frame it shows, and
 * the two presets — the pack's own manifest, and an even spread over every stored frame.
 *
 * Everything applied here goes through `bakedMotion().setPoses`, which validates under the
 * parser's own rules ("pose 0 is stored frame 0, never decreasing") and reaches every clip the
 * stage already holds. A refused draft is refused by the library, and the library's message is
 * what the status pill then shows — the design's own note below says as much.
 */
export function PosesSection({
  frames,
  keyFrames,
  onCountChange,
  onKeyFrameChange,
  onManifest,
  onEven,
  disabled,
}: PosesSectionProps): ReactNode {
  const count = keyFrames.length

  return (
    <>
      <div className="row">
        <span className="row-label">pose count</span>
        <div className="stepper">
          <button
            type="button"
            className="btn-stepper"
            aria-label="one pose fewer"
            disabled={disabled || count <= MIN_POSES}
            onClick={() => {
              onCountChange(count - 1)
            }}
          >
            −
          </button>
          <span className="stepper-value">{disabled ? '–' : count}</span>
          <button
            type="button"
            className="btn-stepper"
            aria-label="one pose more"
            disabled={disabled || count >= MAX_POSES}
            onClick={() => {
              onCountChange(count + 1)
            }}
          >
            +
          </button>
        </div>
      </div>

      <div className="keyframes">
        <div className="keyframes-head">
          <span className="keyframes-title">Key frames</span>
          <span className="keyframes-hint">stored frame per pose</span>
        </div>

        <div className="keyframes-grid">
          {keyFrames.map((slot, pose) => (
            <label className="keyframe" key={pose}>
              <span className="keyframe-label">p{pose}</span>
              <select
                className="keyframe-select"
                value={slot}
                // Pose 0 is the untouched sprite in every pack (`setKeyFrames`); the select says
                // so rather than letting a reader pick something the library will refuse.
                disabled={disabled || pose === 0}
                onChange={(e) => {
                  onKeyFrameChange(pose, Number(e.target.value))
                }}
              >
                {frames.map((frame, i) => (
                  <option key={i} value={i}>
                    {frame}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>

        <div className="keyframes-buttons">
          <button type="button" className="btn-preset" onClick={onManifest} disabled={disabled}>
            Manifest
          </button>
          <button type="button" className="btn-preset" onClick={onEven} disabled={disabled}>
            Even spacing
          </button>
        </div>

        <p className="note note--wide">
          Key frames must start at slot 0 and never decrease — an invalid pick is rejected the way
          the player rejects it.
        </p>
      </div>
    </>
  )
}
