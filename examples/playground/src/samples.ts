/**
 * The six bundled samples, copied from the throwaway spike this library grew out of. Each one
 * exercises a different geometry path, which is why all six are kept: `jeans` has a gap between
 * the legs that the loose field has to bridge rather than walk into, `sneakers` is two disjoint
 * islands, and `camel-coat` is a photo that still carries its background.
 */
export interface Sample {
  readonly id: string
  readonly label: string
  readonly url: string
}

export const SAMPLES: readonly Sample[] = [
  { id: 'sweater', label: 'garment — sweater', url: '/samples/garment-sweater.png' },
  { id: 'trench', label: 'garment — trench coat', url: '/samples/garment-trench.png' },
  { id: 'jeans', label: 'garment — jeans (leg gap)', url: '/samples/garment-jeans.png' },
  {
    id: 'sneakers',
    label: 'garment — sneakers (two islands)',
    url: '/samples/garment-sneakers.png',
  },
  { id: 'avatar', label: 'avatar — full figure', url: '/samples/avatar-full.png' },
  {
    id: 'camel-coat',
    label: 'photo — camel coat (has a background)',
    url: '/samples/garment-camel-coat.webp',
  },
]

export const DEFAULT_SAMPLE_ID = 'sweater'

/** Deliberately absent. The swap panel offers it so the rollback path can be seen, not described. */
export const BROKEN_URL = '/samples/does-not-exist.png'
