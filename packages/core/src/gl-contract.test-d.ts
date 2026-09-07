import { expectTypeOf, test } from 'vitest'
import type { DrawScope, GlContext } from './gl.js'
import type { CoreGlContext } from './gl-context.js'

test('DrawScope has no clear() and no access to the canvas (§5.1, §7.3)', () => {
  // §7.3 forbids clearing the default framebuffer, and the view performs a scissored clear over
  // its own rect before calling draw. A slot cannot clear at all, and cannot reach the canvas to
  // resize it from inside a draw.
  expectTypeOf<keyof DrawScope>().toEqualTypeOf<'bindTarget' | 'enable'>()
})

test('the escape hatch is the raw context and nothing narrower (§5.1)', () => {
  expectTypeOf<GlContext['gl']>().toEqualTypeOf<WebGL2RenderingContext>()
})

test('exactByteFetch is on the seam a slot sees, not behind the concrete type (§8.5.3)', () => {
  expectTypeOf<GlContext['exactByteFetch']>().toEqualTypeOf<boolean>()
})

test('dispose is on the concrete context alone, because a slot never owns the surface (§4.0)', () => {
  expectTypeOf<CoreGlContext>().toExtend<GlContext>()
  expectTypeOf<CoreGlContext>().toHaveProperty('dispose')
  // A slot receives GlContext and must not be able to tear the stage down.
  expectTypeOf<GlContext>().not.toHaveProperty('dispose')
})
