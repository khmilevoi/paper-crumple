import { ABORTED, type Aborted } from '../abort.js'
import { GlError, MotionError, SheetError } from '../errors.js'
import type { DrawResult, KnobDescriptor, Knobs } from '../forward.js'
import type { Rect, Size } from '../geometry.js'
import type { DrawScope, GlCaps, GlContext } from '../gl.js'
import { knobs } from '../knobs.js'
import type { DrawArgs, MotionClip, MotionFit, MotionSource } from '../motion.js'
import type { BuildError, LoadError, SourceError } from '../results.js'
import type { SheetFront, SheetHandle, SheetRenderer, SourceOptions } from '../sheet.js'
import type { StageEnv } from '../stage.js'
import { asBitmap, fakeBitmap } from './fake-source.js'
import { createFakeTimers } from './fake-timers.js'

/**
 * # The fakes P9 drives (§4, "against fake slots")
 *
 * These implement the two contracts and **nothing else**: no GL, no fetch, no packs. That is the
 * point. If a real slot disagrees with one of these at sync 4, it disagrees with §5.2 or §5.3,
 * because there is nothing else here to disagree with.
 */

function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

/** A `GlContext` that allocates nothing and records that it was used. */
export interface FakeGlContext extends GlContext {
  dispose(): void
  readonly scopes: number
  readonly disposed: boolean
}

export function fakeGlContext(caps?: Partial<GlCaps>): FakeGlContext {
  let scopes = 0
  let disposed = false
  const scope: DrawScope = {
    bindTarget: () => {},
    enable: () => {},
  }
  const gl = {
    COLOR_BUFFER_BIT: 0x4000,
    DEPTH_BUFFER_BIT: 0x100,
    STENCIL_TEST: 0x0b90,
    scissor: () => {},
    clearColor: () => {},
    clear: () => {},
    disable: () => {},
    enable: () => {},
  } as unknown as WebGL2RenderingContext

  return {
    caps: { floatRT: true, maxTextureSize: 4096, timer: false, ...caps },
    exactByteFetch: true,
    program: () => new GlError('fakeGlContext compiles no programs'),
    texture: () => new GlError('fakeGlContext allocates no textures'),
    target: () => new GlError('fakeGlContext allocates no targets'),
    scope(fn) {
      scopes += 1
      return fn(scope)
    },
    gl,
    dispose() {
      disposed = true
    },
    get scopes() {
      return scopes
    },
    get disposed() {
      return disposed
    },
  }
}

export interface FakeSheetHandle extends SheetHandle {
  readonly id: number
  readonly src: Size
}

export interface FakeSheetOptions {
  /** Returned from `source()` instead of a handle. */
  readonly sourceFails?: InstanceType<typeof SheetError>
  /** Returned from `build()` instead of a front. */
  readonly buildFails?: InstanceType<typeof SheetError>
  /** Suspends `source()` until the returned resolver is called, for abort and park tests. */
  readonly gate?: () => Promise<void>
  readonly knobs?: readonly KnobDescriptor[]
  readonly overscan?: number
}

export interface FakeSheet extends SheetRenderer<Knobs, FakeSheetHandle> {
  readonly calls: {
    readonly source: Array<{ bitmap: ImageBitmap; o: SourceOptions }>
    readonly build: Array<{ handle: FakeSheetHandle; size: Size }>
    readonly release: FakeSheetHandle[]
    readonly releaseFront: SheetFront[]
  }
  /** Method names in call order — the whole of D3's `replace()` ordering assertion. */
  readonly order: readonly string[]
  readonly disposed: boolean
}

/** Two descriptors, one per invalidation class the stage branches on. */
const FAKE_SHEET_KNOBS = knobs([
  { key: 'sheetTint', kind: 'number', invalidates: 'draw', default: 0, min: 0, max: 1 },
  { key: 'sheetEdge', kind: 'number', invalidates: 'front', default: 0.5, min: 0, max: 1 },
])

export function fakeSheet(o: FakeSheetOptions = {}): FakeSheet {
  let nextId = 1
  let disposed = false
  const order: string[] = []
  const calls: FakeSheet['calls'] = { source: [], build: [], release: [], releaseFront: [] }

  return {
    knobs: o.knobs ?? FAKE_SHEET_KNOBS,
    overscan: o.overscan ?? 0.08,
    mount: () => undefined,
    async source(bitmap, opts): Promise<SourceError | Aborted | FakeSheetHandle> {
      order.push('source')
      calls.source.push({ bitmap, o: opts })
      if (aborted(opts.signal)) return ABORTED
      if (o.gate !== undefined) await o.gate()
      if (aborted(opts.signal)) return ABORTED
      if (o.sourceFails !== undefined) return o.sourceFails
      const src = { w: bitmap.width, h: bitmap.height }
      return {
        id: nextId++,
        src,
        rect: { x: 0, y: 0, w: src.w, h: src.h },
        // A handle holds no image data at all (§8.5): this is the declared model, not a heap
        // measurement, and it is independent of source size.
        bytes: 1712,
      }
    },
    build(handle, size): BuildError | SheetFront {
      order.push('build')
      calls.build.push({ handle, size })
      if (o.buildFails !== undefined) return o.buildFails
      return {
        texture: {} as WebGLTexture,
        width: size.w,
        height: size.h,
        rect: { x: 0, y: 0, w: size.w, h: size.h },
        bytes: size.w * size.h * 4,
      }
    },
    releaseFront(front) {
      order.push('releaseFront')
      calls.releaseFront.push(front)
    },
    release(handle) {
      order.push('release')
      calls.release.push(handle)
    },
    dispose() {
      order.push('dispose')
      disposed = true
    },
    calls,
    order,
    get disposed() {
      return disposed
    },
  }
}

export interface FakeFit extends MotionFit {
  readonly override: string | null
}

export interface FakeClip extends MotionClip {
  readonly id: number
}

export interface FakeMotionOptions {
  readonly fitFails?: InstanceType<typeof MotionError>
  readonly loadFails?: LoadError
  readonly drawFails?: InstanceType<typeof GlError>
  readonly gate?: () => Promise<void>
  readonly poseCount?: number
  readonly knobs?: readonly KnobDescriptor[]
}

export interface FakeMotion extends MotionSource<Knobs, FakeFit, FakeClip> {
  readonly calls: {
    readonly fit: Array<{ rect: Rect; override: string | null | undefined }>
    readonly load: FakeFit[]
    readonly draw: Array<DrawArgs<FakeFit, FakeClip, Knobs>>
    readonly release: FakeClip[]
  }
  readonly disposed: boolean
}

const FAKE_MOTION_KNOBS = knobs([
  { key: 'motionTilt', kind: 'number', invalidates: 'draw', default: 0, min: -1, max: 1 },
])

export function fakeMotion(o: FakeMotionOptions = {}): FakeMotion {
  const poseCount = o.poseCount ?? 6
  let nextId = 1
  let disposed = false
  const calls: FakeMotion['calls'] = { fit: [], load: [], draw: [], release: [] }

  return {
    knobs: o.knobs ?? FAKE_MOTION_KNOBS,
    mount: () => undefined,
    fit(rect, override) {
      calls.fit.push({ rect, override })
      if (o.fitFails !== undefined) return o.fitFails
      // The bucket a real slot picks is opaque to the core; a long-side band plus the override is
      // enough to make two sprites share a sortKey or not, which is all §8.4 batches on.
      const band = rect.w >= rect.h ? 'wide' : 'tall'
      return {
        frontSize: { w: rect.w, h: rect.h },
        sortKey: `${band}:${override ?? 'none'}`,
        override: override ?? null,
      }
    },
    async load(fit, opts): Promise<LoadError | Aborted | FakeClip> {
      calls.load.push(fit)
      if (aborted(opts?.signal)) return ABORTED
      if (o.gate !== undefined) await o.gate()
      if (aborted(opts?.signal)) return ABORTED
      if (o.loadFails !== undefined) return o.loadFails
      return {
        id: nextId++,
        frameCount: poseCount * 2,
        keyFrames: Array.from({ length: poseCount }, (_, i) => i * 2),
      }
    },
    draw(a): InstanceType<typeof GlError> | DrawResult {
      calls.draw.push(a)
      return o.drawFails ?? ({} as DrawResult)
    },
    release(clip) {
      calls.release.push(clip)
    },
    dispose() {
      disposed = true
    },
    calls,
    get disposed() {
      return disposed
    },
  }
}

/** A `StageEnv` with no DOM, no GL and a fake clock. Every level-1 stage test uses this. */
export function stageEnv(over: Partial<StageEnv> = {}): StageEnv {
  const canvas = (w: number, h: number) =>
    ({
      width: w,
      height: h,
      getContext: () => ({
        canvas: { width: w, height: h },
        getContextAttributes: () => ({
          alpha: true,
          antialias: false,
          depth: true,
          premultipliedAlpha: false,
          preserveDrawingBuffer: true,
          stencil: false,
          powerPreference: 'high-performance',
        }),
        getExtension: () => ({ loseContext: () => {} }),
      }),
    }) as unknown as HTMLCanvasElement
  return {
    surface: { makeOffscreen: canvas, makeElement: canvas },
    // A fresh context per stage. One env handed to two stages would otherwise share `scopes` and
    // `disposed`, so one stage's `dispose()` would make the other look torn down. A test that
    // needs to reach the context passes its own `makeContext` override.
    makeContext: () => fakeGlContext(),
    timers: createFakeTimers(),
    dpr: 2,
    onContextLost: () => () => {},
    sourceEnv: {
      fetch: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        blob: async () => new Blob(['png'], { type: 'image/png' }),
      }),
      createImageBitmap: async () => asBitmap(fakeBitmap({ width: 40, height: 30 })),
    },
    ...over,
  }
}
