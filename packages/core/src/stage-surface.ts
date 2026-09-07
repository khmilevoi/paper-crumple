import { attempt } from './attempt.js'
import { GlError } from './errors.js'
import { GL_ATTRIBUTES } from './gl-context.js'
import type { Surface } from './stage-types.js'
import { gradeAttributes } from './surface-grade.js'

/**
 * # The surface, and who owns it (§4.0)
 *
 * A stage has exactly one WebGL2 context and exactly one drawing surface, and **it creates both
 * on a canvas of its own**. `present: 'blit'` puts that canvas offscreen, where the consumer
 * never reaches it at all; `present: 'direct'` makes it a detached `HTMLCanvasElement` the
 * consumer appends — so under `direct` the consumer *does* hold the element carrying the
 * context, and the element alone is theirs: it is theirs to append, place and style, and the
 * context on it stays the stage's. **The consumer must not call `getContext` on it**, because
 * both owned modes create the context with `GlContextOptions.owned` true and its baseline
 * restore assumes nothing outside the library ever touches that context. An injected context
 * has no owned surface at all.
 */
export interface SurfaceHost {
  readonly surface: Surface
  readonly gl: WebGL2RenderingContext
  /** §4.0.2's grading result, which becomes `stage.warnings`. */
  readonly warnings: readonly string[]
  /**
   * Raise the backing store to at least `w x h`. **Monotonic**: it never shrinks, so the surface
   * is a high-water mark and a draw never reallocates the backing store of a neighbour. A no-op
   * on a surface the stage does not own.
   *
   * **The stage itself never calls it**: it creates its surface at `maxSize x maxSize` up front,
   * which already fits every view it will grant. This is the entry point for a host driving the
   * surface itself, and the monotonic guarantee is what makes that safe.
   */
  grow(w: number, h: number): InstanceType<typeof GlError> | undefined
  /**
   * The consumer's own resize, which **may** shrink. Present on `BlitStage` and `DirectStage`;
   * `HostedStage` does not expose it at all, because the stage owns nothing about an injected
   * context, its canvas's size included (amendment 8).
   */
  resize(w: number, h: number): InstanceType<typeof GlError> | undefined
  /** Idempotent. Calls `loseContext()` **only** when the surface is owned (§4.6). */
  dispose(): void
}

/** Injected so a level-1 test needs neither a DOM nor `OffscreenCanvas`. */
export interface SurfaceEnv {
  readonly makeOffscreen?: (w: number, h: number) => HTMLCanvasElement | OffscreenCanvas
  readonly makeElement?: (w: number, h: number) => HTMLCanvasElement
}

type Canvas = HTMLCanvasElement | OffscreenCanvas

function defaultOffscreen(w: number, h: number): Canvas | Error {
  // `paper-fold/src/bench.js:27-32` and `paper-crumple-3d/src/stress.js:34-38` both build an
  // OffscreenCanvas with a detached <canvas> fallback; three of the five spike entry points
  // already use this scheme.
  if (typeof OffscreenCanvas === 'function') {
    return attempt(() => new OffscreenCanvas(w, h))
  }
  return defaultElement(w, h)
}

function defaultElement(w: number, h: number): HTMLCanvasElement | Error {
  return attempt(() => {
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    return c
  })
}

function positive(n: number): boolean {
  return Number.isFinite(n) && n >= 1
}

function mutable(canvas: Canvas): { width: number; height: number } {
  return canvas as unknown as { width: number; height: number }
}

function makeHost(gl: WebGL2RenderingContext, canvas: Canvas, owned: boolean): SurfaceHost | Error {
  const attrs = attempt(() => gl.getContextAttributes())
  const grade = gradeAttributes(
    attrs instanceof Error ? null : attrs,
    // Grading is done once, at mount, for the framebuffer case. A view that later targets the
    // default framebuffer is re-graded by the stage at `view()` time against `presentable`,
    // which is what this call computes.
    { defaultFramebufferView: false },
  )
  if (grade.error !== undefined) return grade.error

  let disposed = false
  const box = mutable(canvas)

  const surface: Surface = {
    canvas,
    owned,
    get width() {
      return box.width
    },
    get height() {
      return box.height
    },
    presentable: grade.presentable,
  }

  const setSize = (w: number, h: number): InstanceType<typeof GlError> | undefined => {
    const done = attempt(() => {
      box.width = Math.floor(w)
      box.height = Math.floor(h)
    })
    return done instanceof Error
      ? new GlError(`the stage surface refused a ${w}x${h} backing store`, { cause: done })
      : undefined
  }

  return {
    surface,
    gl,
    warnings: grade.warnings,
    grow(w, h) {
      if (!owned) return undefined
      if (!positive(w) || !positive(h)) {
        return new GlError(`grow() needs finite positive dimensions, got ${w}x${h}`)
      }
      const nextW = Math.max(box.width, Math.floor(w))
      const nextH = Math.max(box.height, Math.floor(h))
      if (nextW === box.width && nextH === box.height) return undefined
      return setSize(nextW, nextH)
    },
    resize(w, h) {
      // amendment 8 — the stage owns nothing about an injected context, its canvas's size
      // included. `HostedStage` omits `resize` statically; this is the runtime half of the same
      // refusal, for a JavaScript consumer or a cast that reaches the method anyway.
      if (!owned) {
        return new GlError(
          'resize() is refused on an injected context: surface.owned is false, so the canvas ' +
            "is the host application's to size",
        )
      }
      if (!positive(w) || !positive(h)) {
        return new GlError(`resize() needs finite positive dimensions, got ${w}x${h}`)
      }
      return setSize(w, h)
    },
    dispose() {
      if (disposed) return
      disposed = true
      // Only on a canvas the stage created and no one else can reach (§4.6). Losing an injected
      // context would kill a host application's renderer.
      if (!owned) return
      const ext = attempt(() => gl.getExtension('WEBGL_lose_context'))
      if (ext instanceof Error || ext === null) return
      attempt(() => (ext as { loseContext(): void }).loseContext())
    },
  }
}

export function createOwnedSurface(o: {
  present: 'blit' | 'direct'
  maxSize: number
  env?: SurfaceEnv
}): SurfaceHost | InstanceType<typeof GlError> {
  if (!positive(o.maxSize)) {
    return new GlError(`paperStage() needs a finite positive size, got ${o.maxSize}`)
  }
  const size = Math.floor(o.maxSize)
  const make =
    o.present === 'direct'
      ? (o.env?.makeElement ?? defaultElement)
      : (o.env?.makeOffscreen ?? defaultOffscreen)

  const canvas = attempt(() => make(size, size))
  if (canvas instanceof Error) {
    return new GlError('the stage could not create its own canvas', { cause: canvas })
  }
  mutable(canvas).width = size
  mutable(canvas).height = size

  const gl = attempt(() => canvas.getContext('webgl2', GL_ATTRIBUTES))
  if (gl instanceof Error) {
    return new GlError('getContext("webgl2") on the stage canvas failed', { cause: gl })
  }
  if (gl === null) {
    return new GlError(
      'this browser did not grant a WebGL2 context on the stage canvas; under a headless ' +
        'Chromium this usually means --enable-unsafe-swiftshader is missing (§11)',
    )
  }
  const host = makeHost(gl as WebGL2RenderingContext, canvas, true)
  return GlError.is(host) ? host : host instanceof Error ? new GlError(host.message) : host
}

/**
 * §4.0's third case. **The library never calls `getContext('webgl2')` on an element it did not
 * create** — a second call returns the first call's context and silently discards the attribute
 * bag it was handed — so an injected context is taken as given and graded, never re-obtained.
 */
export function hostInjected(
  gl: WebGL2RenderingContext,
): SurfaceHost | InstanceType<typeof GlError> {
  const canvas = attempt(() => gl.canvas)
  if (canvas instanceof Error) return new GlError('the injected context exposes no canvas')
  const host = makeHost(gl, canvas as Canvas, false)
  return GlError.is(host) ? host : host instanceof Error ? new GlError(host.message) : host
}
