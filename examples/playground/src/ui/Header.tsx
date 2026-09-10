import type { ReactNode } from 'react'

export interface StageStatus {
  readonly ok: boolean
  readonly text: string
}

export interface HeaderProps {
  readonly status: StageStatus
  /** The design's single trailing chip: `bucket <b> · <n> poses`. */
  readonly chip: string
  readonly onReset: () => void
}

/**
 * `Paper Crumple Control Panel v2.dc.html`'s header, node for node: brand, the live status pill,
 * then one chip and Reset pinned right by the wrapper's own `margin-left: auto`.
 *
 * The status pill's text is whatever the page last reported and can be long, so the full string
 * also goes on `title`; the design's own pill is a single fixed line and never wraps, which is
 * what `white-space: nowrap` on `.status` preserves here.
 */
export function Header({ status, chip, onReset }: HeaderProps): ReactNode {
  return (
    <header className="header">
      <div className="brand">
        <div className="brand-mark" aria-hidden="true" />
        <div className="brand-titles">
          <h1 className="brand-name">Paper Crumple</h1>
          <span className="brand-sub">3D bake · baked cloth sheet</span>
        </div>
      </div>

      <div
        className={status.ok ? 'status status--ok' : 'status status--bad'}
        title={status.text}
        role="status"
      >
        <span className="status-dot" />
        {status.text}
      </div>

      <div className="header-actions">
        <span className="header-chip">{chip}</span>
        <button type="button" className="header-reset" onClick={onReset}>
          Reset
        </button>
      </div>
    </header>
  )
}
