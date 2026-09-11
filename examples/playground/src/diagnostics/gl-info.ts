import type { BuiltStage } from '../scene/config'

/**
 * The renderer string the design's diagnostics footer prints.
 *
 * `getContext('webgl2')` on a canvas that already has a WebGL2 context returns that same context
 * — it does not create a second one — so this reads the live stage's own driver rather than
 * standing up a throwaway context to ask. `WEBGL_debug_renderer_info` is absent in browsers that
 * mask it, and the unmasked string is the whole point of the line, so its absence is said out
 * loud instead of being papered over with the masked generic value.
 */
export function glInfo(built: BuiltStage): string {
  const canvas: unknown = built.stage.surface.canvas
  const gl =
    canvas instanceof HTMLCanvasElement
      ? canvas.getContext('webgl2')
      : canvas instanceof OffscreenCanvas
        ? canvas.getContext('webgl2')
        : null
  if (gl === null) return 'renderer unavailable — no WebGL2 context on the surface'
  const ext = gl.getExtension('WEBGL_debug_renderer_info')
  if (ext === null) return 'renderer masked by the browser (WEBGL_debug_renderer_info withheld)'
  const renderer: unknown = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)
  return typeof renderer === 'string' ? renderer : 'renderer unavailable'
}
