import type { ReactNode } from 'react'

export interface Metric {
  readonly label: string
  readonly value: string
  /** What the number actually is, for the tiles whose design label is shorter than the fact. */
  readonly title?: string
}

export interface DiagnosticsProps {
  readonly metrics: readonly Metric[]
  readonly keyFrameLine: string
  readonly glInfo: string
}

/** The design's six-tile strip under the transport, plus its two-part footer line. */
export function Diagnostics({ metrics, keyFrameLine, glInfo }: DiagnosticsProps): ReactNode {
  return (
    <div className="diagnostics">
      <div className="metrics">
        {metrics.map((m) => (
          <div className="metric" key={m.label} title={m.title}>
            <span className="metric-label">{m.label}</span>
            <span className="metric-value">{m.value}</span>
          </div>
        ))}
      </div>
      <div className="diagnostics-foot">
        <span>{keyFrameLine}</span>
        <span className="diagnostics-foot-right" title={glInfo}>
          {glInfo}
        </span>
      </div>
    </div>
  )
}
