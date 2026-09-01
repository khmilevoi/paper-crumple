/**
 * The level-2 harness for `@paper-crumple/motion` (§11, §11.1).
 *
 * **Test-only source.** Reachable from neither `index.ts` nor any `./packs/*` subpath, so tsdown
 * bundles none of it and it ships in no tarball. It is a plain `.ts` file rather than a
 * `.gl.test.ts` one so several suites can import it without Vitest collecting it as a suite.
 *
 * It duplicates core's own `testing/gl-fixture.ts` on purpose: that file is unexported test-only
 * source and there is no package boundary across which it could be shared.
 *
 * **Every context this module hands out must be released.** The browser caps live WebGL2 contexts
 * at roughly sixteen (§4.0) and Vitest opens one page per test file; a suite that leaks fails from
 * the seventeenth test onward with a message that reads as a library bug. Release in `afterEach`,
 * never by re-running.
 */
import { createGlContext, GL_ATTRIBUTES } from '@paper-crumple/core/unstable'
import type { CoreGlContext } from '@paper-crumple/core/unstable'

export interface GlFixture {
  readonly canvas: HTMLCanvasElement
  readonly gl: WebGL2RenderingContext
  readonly ctx: CoreGlContext
  dispose(): void
}

/**
 * A canvas, a WebGL2 context with §7.3's attribute bag, and the `GlContext` over it.
 *
 * A `null` context here is the SwiftShader launch triple and never a library bug:
 * `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader` (§11). Fix the flags,
 * never re-run. The assertion is left to the caller so the failure names the suite.
 */
export function createGlFixture(width = 64, height = 64): GlFixture {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  document.body.append(canvas)
  const gl = canvas.getContext('webgl2', GL_ATTRIBUTES) as WebGL2RenderingContext | null
  const ctx = createGlContext(gl as WebGL2RenderingContext)
  return {
    canvas,
    gl: gl as WebGL2RenderingContext,
    ctx,
    dispose() {
      ctx.dispose()
      gl?.getExtension('WEBGL_lose_context')?.loseContext()
      canvas.remove()
    },
  }
}
