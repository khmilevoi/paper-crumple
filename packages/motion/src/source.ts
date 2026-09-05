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
import { ABORTED, AssetError, GlError, KNOB_REFERENCE_PX, PackError } from '@paper-crumple/core'
import type {
  Aborted,
  DrawArgs,
  DrawResult,
  LoadError,
  MotionSource,
  Rect,
  Size,
} from '@paper-crumple/core'
import { hexToRgb, raceAbort, uploadBytes } from '@paper-crumple/core/unstable'
import type {
  GlContext,
  MotionClip,
  MotionFit,
  Program,
  Texture,
} from '@paper-crumple/core/unstable'

import { BUCKETS, fitSheet } from './buckets.js'
import { FIBRE_TILE_PX, MOTION_KNOBS } from './knobs.js'
import type { MotionLookKnobs } from './knobs.js'
import { createSheetMesh } from './mesh.js'
import type { SheetMesh } from './mesh.js'
import type { Pack } from './pack.js'
import type { PackModule } from './pack-module.js'
import { createPackStore } from './pack-store.js'
import type { PackStore } from './pack-store.js'
import { resolveSchedule } from './schedule.js'
import type { PoseSchedule, PoseScheduleInput } from './schedule.js'
import { DEBUG_VIEWS, SHEET_FS, SHEET_VS } from './shaders.js'

/** One shape for the two places a schedule and a pack disagree: `setPoses` now, `load` later. */
function cannotPlay(
  bucket: string,
  cause: InstanceType<typeof PackError>,
): InstanceType<typeof PackError> {
  return new PackError(
    `bakedMotion: bucket '${bucket}' cannot play the pose schedule: ${cause.message}`,
    { cause },
  )
}

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
  /**
   * **Live.** The source's `poses` override while one is set, the manifest's own key frames
   * otherwise. The core reads it at every draw and every run (§5.3, `MotionClip`), so a
   * `setPoses` after `load()` reaches every clip already handed out without a re-`load`.
   */
  readonly keyFrames: readonly number[]
  /** Live too: the override's dwell table, or absent — `DWELL_MS` — for the manifest schedule. */
  readonly dwells?: readonly number[]
  readonly bucket: string
}

/**
 * What `bakedMotion()` returns: the `MotionSource` §5.3 specifies, plus the three members a
 * consumer editing the pose schedule at runtime needs. A consumer typing the source as
 * `MotionSource` sees none of them and loses nothing.
 */
export interface BakedMotion extends MotionSource<MotionLookKnobs, BakedFit, BakedClip> {
  /**
   * The packs resident right now, in the order they were supplied — what a pose editor reads
   * `frameCount`, `frames[].index` and the manifest's own `keyFrames` from. Empty until the first
   * `load()` resolves; a bucket leaves when its last clip is released.
   */
  packs(): readonly Pack[]
  /** The schedule every clip plays, or `null`: each pack's own manifest, at `DWELL_MS`. */
  readonly poses: PoseSchedule | null
  /**
   * Plays `input` on every clip — resident, and still to load — in place of the manifests' key
   * frames; `null` restores them. Validated now against every resident pack, under
   * `setKeyFrames`'s rules plus a dwell per pose, and again against each pack that arrives later,
   * whose `load()` then returns the `PackError` instead of a clip. A failed call changes nothing.
   *
   * The change is read at the next draw and the next run. A run in flight keeps the plan it
   * started with and renders its remaining poses through the new key frames, so a consumer
   * stops it first (`stage.stop({ all: true })`) and redraws at `'flat'`.
   */
  setPoses(input: PoseScheduleInput | null): InstanceType<typeof PackError> | undefined
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

export function bakedMotion(o: BakedMotionOptions): BakedMotion {
  const store: PackStore = createPackStore({
    packs: o.packs,
    ...(o.fetch ? { fetch: o.fetch } : {}),
  })
  const clips = new Map<string, BakedClip>()
  const meshes = new Map<string, SheetMesh>()
  let mounted: Mounted | null = null
  let disposed = false
  /** The override every clip's `keyFrames` and `dwells` getters read through. */
  let poses: PoseSchedule | null = null

  function residentPacks(): readonly Pack[] {
    const out: Pack[] = []
    for (const m of o.packs) {
      const pack = store.get(m.bucket)
      if (pack !== undefined) out.push(pack)
    }
    return out
  }

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
      // `override` conflates two concepts at the call site (core's stage.ts): a genuine bucket id,
      // which this source recognises and must honour, and an opaque fold-preset token minted by
      // `presetForImageId()` that this slot never authored (core preset.ts §4.1, §5.3: a slot must
      // map an unrecognised override deterministically onto one of its own presets and must not
      // error on it). Motion has exactly one preset per bucket, so "its own preset" for an
      // unrecognised token is the aspect-derived bucket — i.e. treat it exactly like `null`.
      const bucketOverride =
        override === null || BUCKETS.some((b) => b.id === override) ? override : null
      const f = fitSheet(rect.w, rect.h, bucketOverride)
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

      // P7 (spec 5.2 amendment): `mount()` issued the sheet program's compile and link without
      // waiting for the driver, and this is the slot's asynchronous path, so the link is waited
      // for here — before the program's first use in `draw`, whose `GlError` would otherwise be
      // the only place a broken shader could surface, and only on a draw. `LoadError` carries no
      // `GlError` (spec 5.3), so a failed link is an `AssetError` with the driver's message as
      // its `cause`. The wait is raced against the signal (`raceAbort`, §10.5's check point
      // "after a program-readiness wait"): an aborted caller leaves the moment the signal fires,
      // and the shared link carries on for the next one. A `dispose()` during the wait is honoured
      // first, and an abort that landed in the gap after the race is honoured too.
      const m = mounted
      if (m !== null) {
        const linked = await raceAbort(m.program.ready(), opts?.signal)
        if (disposed) return new AssetError('bakedMotion: loaded after dispose')
        if (linked === ABORTED || opts?.signal?.aborted === true) {
          store.release(fit.bucket)
          return ABORTED
        }
        if (linked !== undefined) {
          store.release(fit.bucket)
          return new AssetError('bakedMotion: the sheet program did not link', { cause: linked })
        }
      }

      // An override set while this pack was not resident is checked against it here, where a
      // `PackError` has a legal slot in `LoadError`. The reference `acquire` took is handed back:
      // a caller that receives an Error receives no clip, and will never call `release`.
      if (poses !== null) {
        const checked = resolveSchedule(poses, pack.frameCount)
        if (PackError.is(checked)) {
          store.release(fit.bucket)
          return cannotPlay(fit.bucket, checked)
        }
      }

      const existing = clips.get(fit.bucket)
      if (existing) return existing
      const clip: BakedClip = {
        bucket: fit.bucket,
        frameCount: pack.frameCount,
        // Getters, not snapshots: the core reads `keyFrames` at every draw and `dwells` at every
        // run, which is what lets `setPoses` reach a clip that is already in a sprite record.
        get keyFrames() {
          return poses?.keyFrames ?? pack.keyFrames
        },
        get dwells() {
          return poses?.dwells
        },
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
        // `uUvRect` is the ONE place the two y conventions in this library meet, so the flip
        // lives here and nowhere else.
        //
        // `paper`'s front is y-DOWN and says so everywhere: `artwork.ts` pins
        // `UNPACK_FLIP_Y_WEBGL` off ("not inherited from the spike's `true`"), so an artwork
        // texel row is a source image row; `PAPER_FS` assembles the front straight off
        // `gl_FragCoord` with no flip; `sheet.ts`'s `cpuFieldFallback` header proves, with a
        // measurement, that nothing in the field path flips either; and `SheetFront.rect` is
        // that same y-down row index, because `sourceRectToFrontRect` carries a source-pixel
        // rect into it unflipped.
        //
        // This shader's world is y-UP: `uSheetPx` is documented "target px, y up", `gl_Position`
        // maps `aPos.y = +1` to the top of the screen, and the baked packs put `aUv.y = 1`
        // there with it. Feeding a y-down front through a v that rises toward the top of the
        // screen therefore lands the image's first row at the framebuffer's first row — which a
        // GL framebuffer shows at the BOTTOM — and every sprite draws upside down.
        //
        // So v is inverted: `aUv.y = 1` (screen top) samples the sheet box's top edge in the
        // front, `aUv.y = 0` its bottom edge. `x` is untouched: neither convention disagrees
        // about which way x runs.
        gl.uniform4f(
          u('uUvRect'),
          (fcx - fit.sheetW / 2) / front.width,
          (fcy + fit.sheetH / 2) / front.height,
          fit.sheetW / front.width,
          -fit.sheetH / front.height,
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

    packs: residentPacks,

    get poses() {
      return poses
    },

    setPoses(input) {
      if (input === null) {
        poses = null
        return undefined
      }
      // No pack resident yet means no slot bound to check against, so the structural rules run
      // alone here — `load()` checks the bound against each pack as it arrives.
      const resolved = resolveSchedule(input, Number.POSITIVE_INFINITY)
      if (PackError.is(resolved)) return resolved
      for (const pack of residentPacks()) {
        const checked = resolveSchedule(input, pack.frameCount)
        if (PackError.is(checked)) return cannotPlay(pack.bucket, checked)
      }
      poses = resolved
      return undefined
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
