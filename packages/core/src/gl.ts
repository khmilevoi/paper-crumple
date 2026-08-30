import type { GlError } from './errors.js'
import type { Program, Target, Texture, TextureDesc } from './forward.js'
import type { Rect } from './geometry.js'

/**
 * What the context can do. Re-exported as `stage.caps` (amendment 14), because a consumer
 * choosing `maxSize` or `exact: true` needs `maxTextureSize` before the `add()` that would fail
 * on it. That is a re-export and not a second source: P9 reads this object.
 */
export interface GlCaps {
  readonly floatRT: boolean
  readonly maxTextureSize: number
  /** `EXT_disjoint_timer_query_webgl2`. */
  readonly timer: boolean
}

/**
 * The seam every slot binds to (§5.1). Slot-authoring surface, exported from
 * `@paper-crumple/core/unstable`. **P6 `core-gl-foundation` implements it**; nothing in wave 2
 * does.
 */
export interface GlContext {
  readonly caps: GlCaps
  program(vs: string, fs: string, label: string): InstanceType<typeof GlError> | Program
  texture(d: TextureDesc): InstanceType<typeof GlError> | Texture
  target(t: Texture): InstanceType<typeof GlError> | Target
  /** Runs `fn` with a scoped GL state; restores exactly what the scope touched. */
  scope<T>(fn: (s: DrawScope) => T): T
  /** Escape hatch. Legal only inside `scope()`; documented as unstable. */
  readonly gl: WebGL2RenderingContext
}

/**
 * `clear()` is absent on purpose (§5.1): §7.3 forbids clearing the default framebuffer, and the
 * view performs a scissored clear over its own rect before calling `draw`, so a slot cannot
 * clear at all. Access to the canvas is absent for the same reason — a slot never chooses its
 * destination.
 */
export interface DrawScope {
  bindTarget(t: DrawTarget): void
  enable(cap: 'DEPTH_TEST' | 'BLEND' | 'CULL_FACE' | 'SCISSOR_TEST', on: boolean): void
}

/** Where a slot draws. A view resolves its `ViewTarget` into one of these (§4.0.1). */
export interface DrawTarget {
  /** `null` = the stage's own output. A slot never chooses its destination. */
  readonly framebuffer: WebGLFramebuffer | null
  /** In target pixels. */
  readonly viewport: Rect
  /** The view's box inside that viewport. */
  readonly dest: Rect
}
