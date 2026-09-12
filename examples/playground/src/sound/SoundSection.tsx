import type { ReactNode } from 'react'
import type { AudioSnapshot, SyncMode } from './audio'
import { SYNC_MODES } from './audio'
import { Segmented, Slider } from '../controls/primitives'

export interface SoundSectionProps {
  readonly snapshot: AudioSnapshot
  readonly lines: readonly string[]
  readonly onClipChange: (id: string) => void
  readonly onVolumeChange: (volume: number) => void
  readonly onSyncChange: (mode: SyncMode) => void
}

/**
 * "04 Sound": the clip picker, the volume, the sync mode, and the three-line readout box.
 *
 * The design has no on/off switch, and neither does this: `none — silent` in the picker IS off,
 * which is also what keeps a clean clone quiet — `public/audio/` is gitignored, so the default is
 * `none` and the manifest is not fetched until this section is opened.
 */
export function SoundSection({
  snapshot,
  lines,
  onClipChange,
  onVolumeChange,
  onSyncChange,
}: SoundSectionProps): ReactNode {
  return (
    <>
      <div className="row">
        <span className="row-label">clip</span>
        <select
          className="select"
          aria-label="clip"
          value={snapshot.clipId}
          onChange={(e) => {
            onClipChange(e.target.value)
          }}
        >
          {snapshot.clips.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </div>

      <div className="slider-divider">
        <Slider
          label="volume"
          value={snapshot.volume}
          min={0}
          max={1}
          step={0.01}
          onChange={onVolumeChange}
        />
      </div>

      <div className="row">
        <span className="row-label">sync</span>
        <Segmented
          label="sync"
          value={snapshot.sync}
          onChange={onSyncChange}
          options={SYNC_MODES.map((m) => ({ id: m.id, label: m.label, title: m.title }))}
        />
      </div>

      <div className="sound-lines">
        {lines.map((text, i) => (
          <span className="sound-line" key={i}>
            {text}
          </span>
        ))}
      </div>
    </>
  )
}
