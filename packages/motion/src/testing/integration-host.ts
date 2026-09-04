/**
 * # The minimal level-2 host — a test fixture, never an application (§3.4)
 *
 * **Test-only source.** Reachable from neither `index.ts` nor any pack subpath, so `tsdown` bundles
 * none of it and it ships in no tarball.
 *
 * A `HostedStage` over the test's own `WebGL2RenderingContext`, drawing into a framebuffer the test
 * created. **The destination is not part of any case built on this host** — §18 amendment 13's
 * managed backing store is a `BlitTarget` rule and there is no `BlitTarget` here, so a headless
 * page's zero or arbitrary CSS size cannot reach an assertion by construction rather than by
 * argument. The managed rule gets its own cases in `packages/core/src/blit-destination.gl.test.ts`.
 *
 * The sheet slot is a **stub**, and is named one: `@paper-crumple/paper` does not resolve from this
 * package and adding it would be a manifest edit. The motion source is real, because everything
 * built on this host is about the transition.
 *
 * **Dispose in `afterEach`.** The browser caps live WebGL2 contexts at roughly sixteen (§4.0).
 */
import { ABORTED, GlError, knobs, paperStage, isAborted } from '@paper-crumple/core'
import type {
  Aborted,
  HostedStage,
  KnobDescriptor,
  Knobs,
  Rect,
  SheetFront,
  SheetRenderer,
  Size,
  SourceOptions,
  View,
} from '@paper-crumple/core'
import type { SheetHandle } from '@paper-crumple/core/unstable'
import type { PackModule } from '../pack-module.js'
import { bakedMotion } from '../source.js'
import { createGlFixture, type GlFixture } from './gl-fixture.js'

export interface HostFront {
  readonly key: string
  /** RGBA, row 0 first, non-premultiplied. Raw bytes, never a PNG (§7.4.1). */
  readonly texels: Uint8Array
  readonly size: Size
  readonly rect: Rect
}

export interface StubHandle extends SheetHandle {
  readonly which: number
}

/** One descriptor per invalidation class the stage branches on; the stub needs no more. */
const STUB_KNOBS: readonly KnobDescriptor[] = knobs([
  { key: 'stubTint', kind: 'number', invalidates: 'draw', default: 0, min: 0, max: 1 },
  { key: 'stubEdge', kind: 'number', invalidates: 'front', default: 0.5, min: 0, max: 1 },
])

/**
 * A `SheetRenderer` that uploads one of the fronts it was given and hands it back. It runs no SDF,
 * traces no hull and reads no knob: everything built on it is about the motion path.
 *
 * `source()` picks the front whose byte length matches the bitmap's texel count, falling back to
 * the first — the stage decodes a `Blob` into an `ImageBitmap` before `source()` is called, so the
 * bitmap's dimensions are the only correlation available here.
 */
export function stubSheet(
  fronts: readonly HostFront[],
): SheetRenderer<Knobs, StubHandle> & { dispose(): void } {
  let gl: WebGL2RenderingContext | null = null
  const textures: WebGLTexture[] = []

  return {
    knobs: STUB_KNOBS,
    overscan: 0,
    mount(ctx) {
      gl = ctx.gl
      return undefined
    },
    async source(
      bitmap,
      o: SourceOptions,
    ): Promise<StubHandle | Aborted | InstanceType<typeof GlError>> {
      if (o.signal?.aborted === true) return ABORTED
      const which = Math.max(
        0,
        fronts.findIndex((f) => f.size.w === bitmap.width && f.size.h === bitmap.height),
      )
      const f = fronts[which]!
      // The stub's fronts are already in front texels, so the paper's box is the same rect in
      // both units (`SheetHandle.frontRect` is what the stage hands `motion.fit`).
      return { which, rect: f.rect, frontRect: f.rect, bytes: 256 }
    },
    build(handle, size, knobs): SheetFront | InstanceType<typeof GlError> {
      // The stub doesn't use size or knobs; everything built on it is about the motion path
      void size
      void knobs
      const g = gl
      if (g === null) return new GlError('stubSheet: build() before mount()')
      const f = fronts[handle.which]!
      const texture = g.createTexture()
      if (texture === null) return new GlError('stubSheet: createTexture returned null')
      textures.push(texture)
      g.bindTexture(g.TEXTURE_2D, texture)
      g.texImage2D(
        g.TEXTURE_2D,
        0,
        g.RGBA,
        f.size.w,
        f.size.h,
        0,
        g.RGBA,
        g.UNSIGNED_BYTE,
        f.texels,
      )
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR)
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR)
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE)
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE)
      g.bindTexture(g.TEXTURE_2D, null)
      return {
        texture,
        width: f.size.w,
        height: f.size.h,
        rect: f.rect,
        // A synthetic front has no separate picture inside its paper box; the box stands in.
        artwork: f.rect,
        bytes: f.size.w * f.size.h * 4,
      }
    },
    releaseFront() {},
    release() {},
    dispose() {
      for (const t of textures) gl?.deleteTexture(t)
      textures.length = 0
    },
  }
}

export interface IntegrationHost {
  readonly stage: HostedStage
  readonly gl: WebGL2RenderingContext
  readonly size: Size
  /** A view targeting the framebuffer this host owns. */
  view(tag?: string): View | Error
  /** The framebuffer's texels, RGBA, row 0 first. */
  read(): Uint8Array
  /** Back to fully transparent, so a comparison starts from a known state. */
  clear(): void
  dispose(): void
}

export async function createIntegrationHost(o: {
  readonly fronts: readonly HostFront[]
  /**
   * The packs `bakedMotion()` plays, supplied by the caller. This fixture cannot import
   * `../packs/*` itself — those are separately-loaded subpaths (§3.2, §14) that must never
   * become eagerly reachable, a rule `barrel.test.ts` pins.
   */
  readonly packs: readonly PackModule[]
  readonly size?: Size
}): Promise<IntegrationHost | Error> {
  const size = o.size ?? { w: 128, h: 128 }
  const fixture: GlFixture = createGlFixture(size.w, size.h)
  if (fixture.gl === null) {
    fixture.dispose()
    return new GlError(
      'no WebGL2 context — check the SwiftShader launch flags: ' +
        '--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader (§11)',
    )
  }
  const gl = fixture.gl
  const sheet = stubSheet(o.fronts)
  const motion = bakedMotion({ packs: o.packs })

  const texture = gl.createTexture()
  const framebuffer = gl.createFramebuffer()
  if (texture === null || framebuffer === null) {
    fixture.dispose()
    return new GlError('integration host: could not allocate its own render target')
  }
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, size.w, size.h)
  gl.bindTexture(gl.TEXTURE_2D, null)
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, framebuffer)
  gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null)

  const stage = await paperStage({ gl, sheet, motion, maxSize: Math.max(size.w, size.h) })
  if (stage instanceof Error) {
    gl.deleteFramebuffer(framebuffer)
    gl.deleteTexture(texture)
    sheet.dispose()
    fixture.dispose()
    return stage
  }
  if (isAborted(stage)) {
    gl.deleteFramebuffer(framebuffer)
    gl.deleteTexture(texture)
    sheet.dispose()
    fixture.dispose()
    return new GlError('integration host: paperStage returned ABORTED with no signal given')
  }

  const box: Rect = { x: 0, y: 0, w: size.w, h: size.h }
  let disposed = false

  return {
    stage,
    gl,
    size,
    view(tag) {
      return stage.view({ framebuffer, viewport: box, rect: box, tag })
    },
    read() {
      const out = new Uint8Array(size.w * size.h * 4)
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, framebuffer)
      gl.readPixels(0, 0, size.w, size.h, gl.RGBA, gl.UNSIGNED_BYTE, out)
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null)
      return out
    },
    clear() {
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, framebuffer)
      gl.disable(gl.SCISSOR_TEST)
      gl.colorMask(true, true, true, true)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null)
    },
    dispose() {
      if (disposed) return
      disposed = true
      stage.dispose()
      sheet.dispose()
      motion.dispose()
      gl.deleteFramebuffer(framebuffer)
      gl.deleteTexture(texture)
      fixture.dispose()
    },
  }
}
