/**
 * `bakedMotion()` — the `MotionSource` §5.3 specifies (§3.1, §5.3, §5.4, §8.4, §14).
 *
 * **Per-bucket state is a `Map`.** The original exposed `readonly frameCount` and
 * `readonly keyFrames` on the *source*; slots are declared on the stage and serve every bucket, so
 * two sprites in different buckets leave those two scalars describing whichever loaded last. They
 * live on the clip, one clip per bucket.
 *
 * **`load()` does no GL, and the contract forces that.** §5.3 types it
 * `Promise<LoadError | Aborted | C>` and `LoadError` is `PackError | AssetError` — a `GlError` has
 * nowhere legal to go. The twelve VAOs are therefore built on the first `draw` for that bucket,
 * where `GlError` *is* in the union, and cached for the rest of that pack's life: one build per
 * bucket, never per pose, so §8.4 is untouched.
 *
 * **The fibre tile is the neutral 1×1.** `uFibre` samples `.a` and 0.5 is "no grain" — the trick
 * `paper.js` uses, and `[128, 128, 255, 128]` is the spike's own constant. This package ships no
 * tile subpath; §14 puts the re-encoded tiles behind `@paper-crumple/paper/tiles`, itself
 * defaulting to `tiles: null`. The knob, the uniform and the sampler are wired throughout, so
 * supplying a tile later is a value change and not a redesign.
 */
import { AssetError, GlError } from '@paper-crumple/core'
import type { Aborted, LoadError, MotionSource, Rect, Size } from '@paper-crumple/core'
import { uploadBytes } from '@paper-crumple/core/unstable'
import type {
  GlContext,
  MotionClip,
  MotionFit,
  Program,
  Texture,
} from '@paper-crumple/core/unstable'

import { fitSheet } from './buckets.js'
import { MOTION_KNOBS } from './knobs.js'
import type { MotionLookKnobs } from './knobs.js'
import type { SheetMesh } from './mesh.js'
import type { PackModule } from './pack-module.js'
import { createPackStore } from './pack-store.js'
import type { PackStore } from './pack-store.js'
import { SHEET_FS, SHEET_VS } from './shaders.js'

/** Alpha 0.5 is "no grain": `grainK = 1 + (0.5 - 0.5) * uGrain` is exactly 1 (`material.js:120`). */
const NEUTRAL_FIBRE = new Uint8Array([128, 128, 255, 128])

export interface BakedFit extends MotionFit {
  readonly frontSize: Size
  readonly sortKey: string
  readonly bucket: string
  readonly sheetW: number
  readonly sheetH: number
  readonly stretch: number
  readonly clamped: boolean
}

export interface BakedClip extends MotionClip {
  readonly frameCount: number
  readonly keyFrames: readonly number[]
  readonly bucket: string
}

export interface BakedMotionOptions {
  /**
   * The packs this source may play, passed explicitly. §14: a template-literal `new URL()` over a
   * bucket name lands all three packs in every bundle, so there is no dynamic form.
   */
  readonly packs: readonly PackModule[]
  /**
   * Test injection only. Level-1 tests cannot `fetch` a `file://` URL on any current Node (§11).
   */
  readonly fetch?: typeof globalThis.fetch
}

interface Mounted {
  readonly ctx: GlContext
  readonly program: Program
  readonly fibre: Texture
}

export function bakedMotion(
  o: BakedMotionOptions,
): MotionSource<MotionLookKnobs, BakedFit, BakedClip> {
  const store: PackStore = createPackStore({
    packs: o.packs,
    ...(o.fetch ? { fetch: o.fetch } : {}),
  })
  const clips = new Map<string, BakedClip>()
  const meshes = new Map<string, SheetMesh>()
  let mounted: Mounted | null = null
  let disposed = false

  // A bucket losing its last reference takes its mesh and its clip with it.
  store.onEvict((bucket) => {
    meshes.get(bucket)?.dispose()
    meshes.delete(bucket)
    clips.delete(bucket)
  })

  return {
    knobs: MOTION_KNOBS,

    mount(ctx) {
      if (disposed) return new GlError('bakedMotion: mounted after dispose')
      if (mounted) return new GlError('bakedMotion: already mounted')

      const program = ctx.program(SHEET_VS, SHEET_FS, 'sheet')
      if (program instanceof Error) return program

      const fibre = ctx.texture({
        width: 1,
        height: 1,
        format: 'RGBA8',
        filter: 'LINEAR',
        wrap: 'REPEAT',
        label: 'motion.fibre',
      })
      if (fibre instanceof Error) {
        program.dispose()
        return fibre
      }

      // Inside a scope, because uploading binds TEXTURE_2D and §5.1 restores exactly that.
      const upload = ctx.scope(() => uploadBytes(ctx.gl, fibre, NEUTRAL_FIBRE))
      if (upload instanceof Error) {
        fibre.dispose()
        program.dispose()
        return upload
      }

      mounted = { ctx, program, fibre }
      return undefined
    },

    fit(rect: Rect, override: string | null = null) {
      const f = fitSheet(rect.w, rect.h, override)
      if (f instanceof Error) return f
      return {
        // §5.3 gives `fit` no `maxSize`, so `frontSize` is the bucket-shaped box that covers the
        // rect, in the rect's own units. §8.6's 256x384 / 384x384 / 384x256 at maxSize 384 falls
        // out when the caller hands in a rect already at the scale the front is to be built at.
        frontSize: { w: Math.ceil(f.sheetW), h: Math.ceil(f.sheetH) },
        // Opaque to the core, which sorts on it without interpreting it (§5.3, §8.4).
        sortKey: f.bucket,
        bucket: f.bucket,
        sheetW: f.sheetW,
        sheetH: f.sheetH,
        stretch: f.stretch,
        clamped: f.clamped,
      }
    },

    async load(fit, opts): Promise<LoadError | Aborted | BakedClip> {
      // An `AssetError` and not a `GlError`: `LoadError` is `PackError | AssetError`, and a pack
      // this source can no longer reach is exactly what `AssetError` says.
      if (disposed) return new AssetError('bakedMotion: loaded after dispose')
      const pack = await store.acquire(fit.bucket, opts)
      // Re-checked: `dispose()` may have run while `acquire` was in flight. The store's own
      // guard (pack-store.ts) means `acquire` can still resolve to a valid, non-`Error`,
      // non-`ABORTED` `Pack` with no ref taken — falling through would resurrect an entry in
      // the `clips` map `dispose()` just cleared.
      if (disposed) return new AssetError('bakedMotion: loaded after dispose')
      if (pack instanceof Error) return pack
      if (typeof pack === 'symbol') return pack

      const existing = clips.get(fit.bucket)
      if (existing) return existing
      const clip: BakedClip = {
        bucket: fit.bucket,
        frameCount: pack.frameCount,
        keyFrames: pack.keyFrames,
      }
      clips.set(fit.bucket, clip)
      return clip
    },

    draw() {
      return new GlError('bakedMotion: draw is not implemented yet')
    },

    release(clip) {
      store.release(clip.bucket)
    },

    dispose() {
      if (disposed) return
      disposed = true
      for (const mesh of meshes.values()) mesh.dispose()
      meshes.clear()
      clips.clear()
      store.dispose()
      mounted?.fibre.dispose()
      mounted?.program.dispose()
      mounted = null
    },
  }
}
