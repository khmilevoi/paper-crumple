import type { ReactNode } from 'react'
import type { BucketName } from '../config'
import { BUCKET_NAMES } from '../config'
import { SAMPLES } from '../samples'
import { Segmented } from './primitives'

/**
 * The mockup's own sample labels (`Paper Crumple Control Panel v2.dc.html`'s `SAMPLES` constant),
 * which read slightly differently from `samples.ts`'s `.label` ("garment — trench" vs "garment —
 * trench coat", etc.) — this table is what "01 Source" renders, keyed by the same real ids
 * `samples.ts` already exports, so the visible copy matches the design literally without forking
 * which asset actually loads.
 */
const MOCKUP_SAMPLE_LABEL: ReadonlyMap<string, string> = new Map([
  ['sweater', 'garment — sweater (top)'],
  ['trench', 'garment — trench coat'],
  ['jeans', 'garment — jeans (has a leg gap)'],
  ['sneakers', 'garment — sneakers (two islands)'],
  ['avatar', 'avatar — full figure'],
  ['camel-coat', 'photo — camel wool coat (has background)'],
])

export const BROKEN_ID = 'broken'
const BROKEN_LABEL = 'broken URL (rollback demo)'

export function sampleLabel(id: string): string {
  return MOCKUP_SAMPLE_LABEL.get(id) ?? id
}

/**
 * `auto` bakes every real bucket (`DEFAULT_CONFIG.packs`); the other three are single-bucket
 * selections. "synthetic" is in the design's segmented control but has no backing here —
 * `packages/motion/src/source.ts` has no synthetic source — so it never changes the packs;
 * clicking it reports the limitation instead of silently doing nothing.
 */
const BUCKET_SEGMENTS = ['auto', '2x3', '1x1', '3x2', 'synthetic'] as const
type BucketSegment = (typeof BUCKET_SEGMENTS)[number]

export function packsForBucket(id: string): readonly BucketName[] | null {
  if (id === 'auto') return BUCKET_NAMES
  if ((BUCKET_NAMES as readonly string[]).includes(id)) return [id as BucketName]
  return null
}

/**
 * The reverse, for the segmented control's active state: `auto` when all three are baked, the
 * bucket name when exactly one is, and no highlighted segment for any other combination
 * (reachable only via a hand-edited URL fragment — this control cannot produce one).
 */
export function bucketForPacks(packs: readonly BucketName[]): BucketSegment | null {
  if (packs.length === BUCKET_NAMES.length) return 'auto'
  if (packs.length === 1) return packs[0]
  return null
}

export interface SourceSectionProps {
  readonly sampleId: string
  readonly packs: readonly BucketName[]
  readonly swapTarget: string
  readonly busy: boolean
  readonly preparing: ReadonlySet<string>
  readonly onSampleChange: (id: string) => void
  readonly onPacksChange: (packs: readonly BucketName[]) => void
  readonly onSyntheticUnavailable: () => void
  readonly onSwapTargetChange: (id: string) => void
  readonly onSwap: () => void
}

export function SourceSection({
  sampleId,
  packs,
  swapTarget,
  busy,
  preparing,
  onSampleChange,
  onPacksChange,
  onSyntheticUnavailable,
  onSwapTargetChange,
  onSwap,
}: SourceSectionProps): ReactNode {
  const active = bucketForPacks(packs)
  const swapChoices = SAMPLES.filter((s) => s.id !== sampleId)
  const preparingTarget = preparing.has(swapTarget)

  return (
    <>
      <div className="row">
        <span className="row-label">sample</span>
        <select
          className="select"
          value={sampleId}
          aria-label="sample"
          onChange={(e) => {
            onSampleChange(e.target.value)
          }}
        >
          {SAMPLES.map((s) => (
            <option key={s.id} value={s.id} disabled={preparing.has(s.id)}>
              {sampleLabel(s.id)}
            </option>
          ))}
        </select>
      </div>

      <div className="row">
        <span className="row-label">bucket</span>
        <Segmented
          label="bucket"
          value={active}
          options={BUCKET_SEGMENTS.map((id) => ({
            id,
            label: id,
            title: id === 'synthetic' ? 'no synthetic bucket source in this build' : undefined,
          }))}
          onChange={(id) => {
            const next = packsForBucket(id)
            if (next === null) onSyntheticUnavailable()
            else onPacksChange(next)
          }}
        />
      </div>

      <div className="row row--tight">
        <span className="row-label">swap to</span>
        <select
          className="select"
          value={swapTarget}
          aria-label="swap target"
          onChange={(e) => {
            onSwapTargetChange(e.target.value)
          }}
        >
          {swapChoices.map((s) => (
            <option key={s.id} value={s.id}>
              {sampleLabel(s.id)}
            </option>
          ))}
          <option value={BROKEN_ID}>{BROKEN_LABEL}</option>
        </select>
        <button
          type="button"
          className="btn-inline"
          onClick={onSwap}
          disabled={busy || preparingTarget}
        >
          Swap
        </button>
      </div>

      <p className="note">
        {preparingTarget
          ? `${sampleLabel(swapTarget)} is being prepared for swapping.`
          : 'Swap runs the animated hero transition — fold to a ball, load, unfold. The sample picker above sets what loads at boot.'}
      </p>
    </>
  )
}
