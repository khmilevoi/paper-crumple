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
  /**
   * §8.5.3 — true iff `uint(texelFetch(rgba8Tex, p, 0) * 255.0 + 0.5)` recovers the uploaded byte
   * on this driver. Probed once at context creation. With it true a slot may upload an
   * `ImageBitmap` straight into a normalised `RGBA8` texture and read the bytes back out of it,
   * dropping the `RGBA8UI` staging texture and its `ArrayBufferView` — 3.8 MB of heap. The
   * `usampler2D` form stays the **normative** definition and the fallback, so a `false` here
   * costs performance and never correctness.
   */
  readonly exactByteFetch: boolean
  /**
   * Compiles and links. The synchronous `GlError` covers what can be detected without waiting
   * for the driver (object creation); with `KHR_parallel_shader_compile` the link itself is
   * deferred and its outcome — a compile or link failure included — is `Program.ready()`'s
   * (§5.2 amendment, P7). Without the extension the link is checked here, as it always was.
   */
  program(vs: string, fs: string, label: string): InstanceType<typeof GlError> | Program
  /**
   * Immutable storage, one level (§8.7). Outside `allocations()` the sticky error flag is read
   * right after the storage call, so a `texStorage2D` the driver refused — §10.8's "any
   * allocation that can fail on GPU OOM" — is this call's own `GlError`. Inside `allocations()`
   * nothing is read here: the allocation is recorded as unchecked and `checkAllocations()`
   * settles it with the rest of its batch.
   */
  texture(d: TextureDesc): InstanceType<typeof GlError> | Texture
  /**
   * A framebuffer over `t`. Outside `allocations()` its completeness is queried once per
   * (format, size) combination and trusted after that; inside, the query is skipped and an
   * incomplete target is caught by the draws into it (`INVALID_FRAMEBUFFER_OPERATION`), at
   * `checkAllocations()`.
   */
  target(t: Texture): InstanceType<typeof GlError> | Target
  /**
   * §7.3, §8.1 — one sticky-flag read for a whole batch of allocations. `texture()` and
   * `target()` inside `fn` read no status of their own; each is recorded as **unchecked** until
   * `checkAllocations()` reads `getError` once for all of them. On ANGLE's D3D11 backend every
   * `getError` is a GPU-process round trip that waits for everything queued ahead of it, so a
   * slot that allocates seven textures for one sprite paid seven such waits — and the first one
   * after a burst of draws paid for the whole burst. Re-entrant: a batch opened inside another
   * joins it. `fn`'s value is passed through; nothing the batch handed out is to be trusted
   * before its check.
   */
  allocations<T>(fn: () => T): T
  /**
   * §7.3, §8.1, §10.8 — settle every unchecked allocation. Reads the error flag until it is clear
   * (an implementation may hold several — GL ES 3.0 §2.5). A flag only an allocation of the
   * batch can have raised — `OUT_OF_MEMORY` (storage refused), `INVALID_FRAMEBUFFER_OPERATION` (a
   * target of the batch is incomplete), a lost context — fails the batch: **every unchecked
   * allocation is released**, `alive()` answers false for each, and the `GlError` is returned,
   * so an OOM is never missed and nothing unbacked is ever used; a caller that found one of the
   * batch's textures in its own cache asks `alive()` before trusting it. Any other flag is not an
   * allocation's: the batch is proven, the allocations kept, and that flag is returned for the
   * caller's own purpose (a readback's refusal, say). `NO_ERROR` when the flag was clean.
   *
   * A `texture()` outside any batch settles the unchecked allocations with its own read: a clean
   * read proves them, a fatal one releases them and is reported once more by the next
   * `checkAllocations()`, so their owner still learns. Attribution across batches is by order,
   * not by allocation: a flag left by one batch is read by the next reader, and an OOM is then
   * blamed on that reader's batch — never lost.
   *
   * Place the check where the GPU has had a turn to drain (after a yield, once the batch's work
   * was `flush`ed): the read waits for the queue ahead of it, and after a burst of draws that
   * queue is the whole burst (§8.10).
   */
  checkAllocations(): InstanceType<typeof GlError> | number
  /**
   * Whether this context still holds `t`: false once its `dispose()` ran, whoever ran it — its
   * owner, `checkAllocations()` failing the batch it was in, or the context's own `dispose()`.
   * What a pool asks before handing back a resident it did not release itself.
   */
  alive(t: Texture): boolean
  /**
   * Runs `fn` with a scoped GL state. The outermost scope restores §5.1's enumerated set at its
   * exit; a scope entered while another is live on this context restores **nothing** at its own
   * exit — the outermost one restores everything, the way §7.3's nested `batch` is a no-op rather
   * than a double save. So a slot sets every piece of state it relies on inside its own body and
   * never counts on a sibling's scope having put it back.
   */
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
