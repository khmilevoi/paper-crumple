/**
 * The level-2 harness (§11, §11.1).
 *
 * **Test-only source.** Reachable from neither `index.ts` nor `unstable.ts`, so `tsdown` bundles
 * none of it and it ships in no tarball — exactly like `testing/fake-timers.ts`. It is a plain
 * `.ts` file rather than a `.gl.test.ts` one so that several suites can import it without Vitest
 * collecting it as a suite of its own.
 *
 * **Every context this module hands out must be released.** The browser caps live WebGL2 contexts
 * at roughly sixteen (§4.0) and Vitest opens one page per test file; a suite that leaks fails from
 * the seventeenth test onward with a message that reads as a library bug. Release in `afterEach`,
 * never by re-running.
 */

export interface RawGl {
  readonly canvas: HTMLCanvasElement
  readonly gl: WebGL2RenderingContext
  dispose(): void
}

/**
 * A canvas and a WebGL2 context with §7.3's attribute bag.
 *
 * A `null` context here is the SwiftShader launch triple and never a library bug:
 * `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader` (§11). Fix the flags,
 * never re-run. The assertion is left to the caller so that the failure names the suite.
 */
export function createRawGl(width = 4, height = 4): RawGl {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  document.body.append(canvas)
  const ATTRIBUTES: WebGLContextAttributes = {
    alpha: true,
    antialias: false,
    depth: true,
    stencil: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: true,
    powerPreference: 'high-performance',
  }
  const gl = canvas.getContext('webgl2', ATTRIBUTES) as WebGL2RenderingContext | null
  return {
    canvas,
    // Narrowed by the caller's expect(); a null here fails the very first assertion.
    gl: gl as WebGL2RenderingContext,
    dispose() {
      gl?.getExtension('WEBGL_lose_context')?.loseContext()
      canvas.remove()
    },
  }
}
