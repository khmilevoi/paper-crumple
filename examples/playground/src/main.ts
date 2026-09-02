import * as pc from '@paper-crumple/core'
import { SAMPLES } from './samples'

const line = document.getElementById('version-line')

function boot(): void {
  // A duplicate core is a startup failure, not a once-per-session console warning: two copies
  // give two `GlError` classes, and `instanceof` then narrows an Error as a success value.
  const dup = pc.assertSingleCore()
  if (dup instanceof Error) {
    if (line) line.textContent = `core duplicated: ${dup.message}`
    return
  }
  if (line)
    line.textContent = `core ${pc.VERSION} · ${SAMPLES.length} samples · ${pc.DWELL_MS.length} dwells`
}

boot()
