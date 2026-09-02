import type { Rect, Size } from './geometry.js'
import type { KnobDescriptor } from './forward.js'
import type { KnobSetter, SpriteKnobPatch } from './knob-patch.js'
import type { KnobValues } from './knob-registry.js'
import type { MotionClip, MotionFit } from './motion.js'
import type { SheetFront, SheetHandle } from './sheet.js'
import type { NormalizedSource } from './source.js'

type AnySlot = readonly KnobDescriptor[]

/**
 * §4.1 — **a registered asset**: a key, a front texture, a fit. Evictable from an LRU, shareable
 * between views, owner of front-class knobs. The original's `Instance` carried two unrelated jobs
 * — ownership of a sprite's GPU resources, and presence on the screen — and this is the first
 * half of that split. The pose belongs to the `View`, which is why one sprite may be shown by
 * several views sharing one front texture.
 */
export interface Sprite {
  readonly key: string
  /** Exposed rather than derived twice: `size: 'manual'` and any layout code need it (amend. 13). */
  readonly frontSize: Size
  /** The silhouette's box, in source pixels. */
  readonly rect: Rect
  readonly pinned: boolean
  /** §4.5 — attachment is a **refcount**, not a flag: with a flag the first view to detach would
   *  unpin a sprite the second is still drawing. */
  readonly attachCount: number
  /** §6.6 — a sprite takes the whole ladder, `'draw'` included (amendment 20). */
  set: KnobSetter<SpriteKnobPatch<AnySlot, AnySlot>>
}

/** The stage's own row. Never handed to a consumer; `Sprite` is the read-only face of it. */
export interface SpriteRecord {
  readonly key: string
  readonly sprite: Sprite
  source: NormalizedSource
  handle: SheetHandle
  fit: MotionFit
  clip: MotionClip
  /** `null` after an LRU eviction: the sprite survives, rebuildable through its re-supplier. */
  front: SheetFront | null
  exact: boolean
  pinned: boolean
  attachCount: number
  /** Namespaced paths, per §6.2's ground truth. */
  knobs: KnobValues
}
