/**
 * The six bundled samples, copied from the throwaway spike this library grew out of. Each one
 * exercises a different geometry path, which is why all six are kept: `jeans` has a gap between
 * the legs that the loose field has to bridge rather than walk into, `sneakers` is two disjoint
 * islands, and `camel-coat` is a photo that still carries its background.
 */
import type { SpriteSource } from '@paper-crumple/core'

export interface Sample {
  readonly id: string
  readonly label: string
  readonly src: SpriteSource
}

export const SAMPLES: readonly Sample[] = [
  { id: 'sweater', label: 'garment — sweater', src: '/samples/garment-sweater.png' },
  { id: 'trench', label: 'garment — trench coat', src: '/samples/garment-trench.png' },
  { id: 'jeans', label: 'garment — jeans (leg gap)', src: '/samples/garment-jeans.png' },
  {
    id: 'sneakers',
    label: 'garment — sneakers (two islands)',
    src: '/samples/garment-sneakers.png',
  },
  { id: 'avatar', label: 'avatar — full figure', src: '/samples/avatar-full.png' },
  {
    id: 'camel-coat',
    label: 'photo — camel coat (has a background)',
    src: '/samples/garment-camel-coat.webp',
  },
]

export const DEFAULT_SAMPLE_ID = 'sweater'

export function nextLibrarySample(current: Sample, target: Sample): Sample {
  return SAMPLES.some((sample) => sample.id === target.id) ? target : current
}

/** Deliberately absent. The swap panel offers it so the rollback path can be seen, not described. */
export const BROKEN_URL = '/samples/does-not-exist.png'

/**
 * A dropped file, as a sample.
 *
 * `seq` is in the key and is not decoration: `useCrumple` keeps a `Map<spriteKey, src>` and refuses
 * a key it has already seen bound to a different source, comparing by identity — *"a key names a
 * PICTURE, not a slot"*. Two files of one name would otherwise collide, and the second drop would
 * be reported instead of shown.
 */
export function droppedSample(file: File, seq: number): Sample {
  return { id: `dropped-${String(seq)}`, label: file.name, src: file }
}

export const BROKEN_ID = 'broken'
