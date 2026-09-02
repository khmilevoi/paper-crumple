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
import { AssetError, GlError, KNOB_REFERENCE_PX } from '@paper-crumple/core'
import type {
  Aborted,
  DrawArgs,
  DrawResult,
  LoadError,
  MotionSource,
  Rect,
  Size,
} from '@paper-crumple/core'
import { hexToRgb, uploadBytes } from '@paper-crumple/core/unstable'
import type {
  GlContext,
  MotionClip,
  MotionFit,
  Program,
  Texture,
} from '@paper-crumple/core/unstable'

import { fitSheet } from './buckets.js'
import { FIBRE_TILE_PX, MOTION_KNOBS } from './knobs.js'
import type { MotionLookKnobs } from './knobs.js'
import { createSheetMesh } from './mesh.js'
import type { SheetMesh } from './mesh.js'
import type { Pack } from './pack.js'
import type { PackModule } from './pack-module.js'
import { createPackStore } from './pack-store.js'
import type { PackStore } from './pack-store.js'
import { DEBUG_VIEWS, SHEET_FS, SHEET_VS } from './shaders.js'

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

  /**
   * The bucket's twelve VAOs, built on first use. `load()` cannot build them: §5.3 types it
   * `Promise<LoadError | Aborted | C>` and `LoadError` carries no `GlError`, so a failed build
   * would have to be reported as a `PackError`, which is a lie about the taxonomy. One build per
   * bucket, never per pose — §8.4's twelve preconfigured VAOs are unchanged; only *when* they are
   * built moves.
   */
  function meshFor(m: Mounted, bucket: string): InstanceType<typeof GlError> | SheetMesh {
    const existing = meshes.get(bucket)
    if (existing) return existing
    const pack = store.get(bucket)
    if (!pack) {
      return new GlError(`bakedMotion: bucket '${bucket}' is not loaded; call load(fit) first`)
    }
    const mesh = createSheetMesh(m.ctx.gl, pack)
    if (mesh instanceof Error) return mesh
    meshes.set(bucket, mesh)
    return mesh
  }

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

    draw(
      a: DrawArgs<BakedFit, BakedClip, MotionLookKnobs>,
    ): InstanceType<typeof GlError> | DrawResult {
      if (disposed) return new GlError('bakedMotion: drawn after dispose')
      const m = mounted
      if (!m) return new GlError('bakedMotion: drawn before mount')

      const { clip, fit, frame, front, out, knobs } = a
      const pack: Pack | undefined = store.get(clip.bucket)
      if (!pack) {
        return new GlError(
          `bakedMotion: bucket '${clip.bucket}' is not loaded; call load(fit) first`,
        )
      }
      if (!Number.isInteger(frame) || frame < 0 || frame >= pack.frameCount) {
        return new GlError(
          `bakedMotion: stored frame ${frame} out of 0..${pack.frameCount - 1} for bucket '${clip.bucket}'`,
        )
      }
      if (front.width <= 0 || front.height <= 0) {
        return new GlError(`bakedMotion: front is ${front.width}x${front.height}`)
      }
      if (clip.bucket !== fit.bucket) {
        return new GlError(
          `bakedMotion: clip bucket '${clip.bucket}' does not match fit bucket '${fit.bucket}'`,
        )
      }

      // Both narrowed before use: `hexToRgb` reports a malformed knob as a `KnobError`, which has
      // no legal slot in `GlError | DrawResult` (§5.3). The knob registry validates `paperColor`
      // and `paperBack` with `isHex` at `set()` time (§6.1), so this branch is unreachable through
      // the stage; it is defence for a hand-built `DrawArgs`.
      const front3 = hexToRgb(knobs.paperColor)
      if (front3 instanceof Error) {
        return new GlError(`bakedMotion: paperColor ${knobs.paperColor} is not a hex colour`, {
          cause: front3,
        })
      }
      const back3 = hexToRgb(knobs.paperBack)
      if (back3 instanceof Error) {
        return new GlError(`bakedMotion: paperBack ${knobs.paperBack} is not a hex colour`, {
          cause: back3,
        })
      }

      const stored = pack.frames[frame]!
      const { gl } = m.ctx
      const u = (name: string): WebGLUniformLocation | null => m.program.uniformLocation(name)

      // The front texture maps onto the view's box with ONE uniform scale, so the sheet keeps its
      // aspect whatever box the view gives it.
      const k = Math.min(out.dest.w / front.width, out.dest.h / front.height)
      const halfW = (fit.sheetW / 2) * k
      const halfH = (fit.sheetH / 2) * k
      // dest and viewport are GL coordinates — origin bottom-left, y up — because bindTarget feeds
      // viewport to gl.viewport() and dest to gl.scissor(). gl_Position is relative to the
      // viewport, so the centre is offset by the viewport's origin.
      const cxPx = out.dest.x - out.viewport.x + out.dest.w / 2
      const cyPx = out.dest.y - out.viewport.y + out.dest.h / 2
      // The sheet's box inside the front texture, centred on the paper's box.
      const fcx = front.rect.x + front.rect.w / 2
      const fcy = front.rect.y + front.rect.h / 2

      const result = m.ctx.scope((s): InstanceType<typeof GlError> | DrawResult => {
        // Built inside the scope, because it churns the VAO binding (mesh.ts's own header) and
        // §5.1 only saves and restores VERTEX_ARRAY_BINDING for the window this scope opens.
        const mesh = meshFor(m, clip.bucket)
        if (mesh instanceof Error) return mesh

        s.bindTarget(out)
        // No clear, ever: §7.3 forbids clearing the default framebuffer and the view has already
        // performed a scissored clear over its own rect. DrawScope has no clear() at all.
        // draw() relies on the scissor test remaining enabled by the view, because it never
        // enables SCISSOR_TEST itself.
        s.enable('DEPTH_TEST', true)
        s.enable('BLEND', false)
        s.enable('CULL_FACE', false)
        gl.depthFunc(gl.LEQUAL)
        gl.depthMask(true)
        gl.useProgram(m.program.handle)

        // Unit 1 first, unit 0 last, so the active unit is 0 when the scope restores: §5.1 puts
        // back the active unit's bindings only, and unit 1's binding leaks by design.
        gl.activeTexture(gl.TEXTURE1)
        gl.bindTexture(gl.TEXTURE_2D, m.fibre.handle)
        gl.uniform1i(u('uFibre'), 1)
        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, front.texture)
        gl.uniform1i(u('uFront'), 0)

        gl.uniform4f(u('uSheetPx'), cxPx, cyPx, halfW, halfH)
        gl.uniform2f(u('uViewPx'), out.viewport.w, out.viewport.h)
        gl.uniform1f(u('uDepthPx'), 4 * halfH)
        gl.uniform4f(
          u('uUvRect'),
          (fcx - fit.sheetW / 2) / front.width,
          (fcy - fit.sheetH / 2) / front.height,
          fit.sheetW / front.width,
          fit.sheetH / front.height,
        )
        // uLight is the manifest's baked vector, which is why lightAngle is not a knob (§6.2, §9.3).
        gl.uniform3f(u('uLight'), pack.light[0], pack.light[1], pack.light[2])
        gl.uniform1f(u('uAlphaFloor'), stored.alphaFloor)
        // Pose 0 is the untouched sprite: shade forced to exactly 1 (§7.4.2).
        gl.uniform1i(u('uIdentity'), stored.index === 0 ? 1 : 0)

        gl.uniform3f(u('uPaperColor'), front3[0], front3[1], front3[2])
        gl.uniform3f(u('uPaperBack'), back3[0], back3[1], back3[2])
        gl.uniform1f(u('uAmbient'), knobs.ambient)
        gl.uniform1f(u('uAoStrength'), knobs.aoStrength)
        gl.uniform1f(u('uAoGamma'), knobs.aoGamma)
        gl.uniform1f(u('uBackShade'), knobs.backShade)
        gl.uniform1f(u('uGrain'), knobs.grain)
        // Quoted against a 1000 px-tall sprite, like every px figure in the registry (§6.4).
        gl.uniform1f(
          u('uFibreScale'),
          fit.sheetW / (FIBRE_TILE_PX * (front.height / KNOB_REFERENCE_PX)),
        )
        const debug = DEBUG_VIEWS.indexOf(knobs.debug)
        gl.uniform1i(u('uDebug'), debug < 0 ? 0 : debug)

        const drawn = mesh.draw(frame)
        if (drawn instanceof Error) return drawn
        return { sortKey: fit.sortKey, frame }
      })

      return result
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
