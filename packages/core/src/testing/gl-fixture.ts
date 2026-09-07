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
import { createGlContext, GL_ATTRIBUTES, type CoreGlContext } from '../gl-context.js'

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
  const gl = canvas.getContext('webgl2', GL_ATTRIBUTES) as WebGL2RenderingContext | null
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

export interface GlFixture extends RawGl {
  readonly ctx: CoreGlContext
}

/**
 * A canvas, a context with §7.3's bag, and the `CoreGlContext` over it. `dispose()` releases the
 * context's resources, loses the WebGL2 context and removes the canvas — all three, because only
 * the last two return the slot against §4.0's cap of roughly sixteen.
 */
export function createGlFixture(width = 4, height = 4): GlFixture {
  const raw = createRawGl(width, height)
  const ctx = createGlContext(raw.gl)
  return {
    canvas: raw.canvas,
    gl: raw.gl,
    ctx,
    dispose() {
      ctx.dispose()
      raw.dispose()
    },
  }
}
