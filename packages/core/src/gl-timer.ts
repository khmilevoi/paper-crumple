/**
 * The GPU timer of §5.1's `caps.timer` — `EXT_disjoint_timer_query_webgl2`.
 *
 * **Timing is level 3 and never CI** (§11): SwiftShader numbers are meaningless, so nothing in
 * the test tiers depends on a measurement. What this module owes the design is that a stage on a
 * real GPU can take §17.1's draw-cost measurement without a slot reaching for the extension
 * itself, and that a stage without the extension degrades to `null` rather than to a stub that
 * reports plausible nonsense.
 *
 * WebGL2 permits exactly one `TIME_ELAPSED_EXT` query at a time, so this holds one in flight and
 * one finished result. A disjoint interval — the GPU was context-switched or clocked down mid
 * query — discards the result instead of reporting it, which is what the extension asks for.
 */
import type { GlContext } from './gl.js'

export interface GpuTimer {
  /** Open the one in-flight measurement. A no-op while one is already open. */
  begin(): void
  /** Close it. A no-op when none is open. */
  end(): void
  /**
   * Milliseconds for the finished measurement, or `undefined` when none is ready — which is the
   * normal answer for the first few frames after `end()`, and the permanent answer when the
   * interval was disjoint. Reading a result consumes it.
   */
  poll(): number | undefined
  dispose(): void
}

interface TimerExtension {
  readonly TIME_ELAPSED_EXT: number
  readonly GPU_DISJOINT_EXT: number
}

/** `null` when `ctx.caps.timer` is false. There is no fallback and no stub. */
export function createGpuTimer(ctx: GlContext): GpuTimer | null {
  if (!ctx.caps.timer) return null
  const gl = ctx.gl
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExtension | null
  if (ext === null) return null

  let open: WebGLQuery | null = null
  let pending: WebGLQuery | null = null
  let disposed = false

  return {
    begin() {
      if (disposed || open !== null || pending !== null) return
      const query: WebGLQuery | null = gl.createQuery()
      if (query === null) return
      open = query
      gl.beginQuery(ext.TIME_ELAPSED_EXT, query)
    },

    end() {
      if (disposed || open === null) return
      gl.endQuery(ext.TIME_ELAPSED_EXT)
      pending = open
      open = null
    },

    poll() {
      if (disposed || pending === null) return undefined
      const query = pending
      if (gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE) !== true) return undefined

      pending = null
      // The GPU was interrupted during the interval; the number is meaningless, so it is not
      // reported. The extension exists to be asked this.
      const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT) === true
      const nanoseconds = gl.getQueryParameter(query, gl.QUERY_RESULT) as number
      gl.deleteQuery(query)
      return disjoint ? undefined : nanoseconds / 1e6
    },

    dispose() {
      if (disposed) return
      disposed = true
      if (open !== null) {
        gl.endQuery(ext.TIME_ELAPSED_EXT)
        gl.deleteQuery(open)
        open = null
      }
      if (pending !== null) {
        gl.deleteQuery(pending)
        pending = null
      }
    },
  }
}
