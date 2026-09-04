import { useState } from 'react'
import type { ReactNode, RefObject } from 'react'

export interface StageProps {
  /** Where `stage.ts` puts the canvas the library paints into. */
  readonly slotRef: RefObject<HTMLDivElement | null>
  readonly poseChip: string
  readonly sampleChip: string
  readonly edgeChip: string
  /** `null` in the design's own default background; the two others are the debug backdrops. */
  readonly background: 'dark' | 'light' | 'checker'
  /** A dropped PNG is loaded for real — the hint below is not decoration. */
  readonly onDropImage: (file: File) => void
}

const BACKGROUND_CLASS: Readonly<Record<StageProps['background'], string>> = {
  dark: '',
  light: ' stage--bg-light',
  checker: ' stage--bg-checker',
}

/**
 * The design's stage: three chips over a centred sheet, the drop hint along the bottom, and the
 * pulsing "Release to bake" overlay while a file is over it.
 *
 * `dragActive` is local state and deliberately not lifted: nothing outside this component reacts
 * to a drag in progress, and a drag that ends anywhere else must leave no trace behind.
 */
export function Stage({
  slotRef,
  poseChip,
  sampleChip,
  edgeChip,
  background,
  onDropImage,
}: StageProps): ReactNode {
  const [dragActive, setDragActive] = useState(false)

  return (
    <div
      className={`stage${BACKGROUND_CLASS[background]}`}
      onDragOver={(e) => {
        e.preventDefault()
        if (!dragActive) setDragActive(true)
      }}
      onDragLeave={() => {
        setDragActive(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        setDragActive(false)
        const file = [...e.dataTransfer.files].find((f) => f.type.startsWith('image/'))
        if (file !== undefined) onDropImage(file)
      }}
    >
      <div className="stage-chips">
        <span className="stage-chip stage-chip--accent">{poseChip}</span>
        <span className="stage-chip">{sampleChip}</span>
      </div>
      <span className="stage-chip stage-chip--edge">{edgeChip}</span>

      {/* The artwork's own rectangle, sized from `stage.ts` off `View.frame`. The canvas hangs
          off it absolutely and reaches as far past it as the paper does, so no edge parameter
          can move the picture — see `framing.ts`. */}
      <div className="stage-frame" ref={slotRef} />

      <span className="stage-hint">drop a PNG anywhere on the stage to load it</span>

      {dragActive && (
        <div className="stage-drop">
          <span className="stage-drop-badge">Release to bake</span>
        </div>
      )}
    </div>
  )
}
