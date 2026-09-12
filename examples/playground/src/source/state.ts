import type * as pc from '@paper-crumple/core'
import { BROKEN_ID, BROKEN_URL, DEFAULT_SAMPLE_ID, SAMPLES, type Sample } from './samples'

export const BROKEN_SAMPLE: Sample = {
  id: BROKEN_ID,
  label: 'broken URL (rollback demo)',
  src: BROKEN_URL,
}

export const BOOT_SAMPLE: Sample = SAMPLES.find((s) => s.id === DEFAULT_SAMPLE_ID) ?? SAMPLES[0]

export interface SourceState {
  readonly requested: Sample
  readonly retained: Sample | null
  readonly failed: string | null
}

export interface PrefetchState {
  readonly stage: pc.BlitStage
  readonly targets: ReadonlySet<string>
}

export const EMPTY_TARGETS: ReadonlySet<string> = new Set()

export function sourceForRebuild(source: SourceState): SourceState {
  if (source.failed !== source.requested.id || source.retained === null) return source
  return { requested: source.retained, retained: source.retained, failed: null }
}
