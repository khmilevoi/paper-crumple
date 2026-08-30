import { afterEach, expect, it } from 'vitest'

let canvas: HTMLCanvasElement | null = null
let gl: WebGL2RenderingContext | null = null

afterEach(() => {
  // The browser caps live WebGL2 contexts at roughly sixteen (spec 4.0). Every level-2 test
  // releases its context here; a suite that does not fails from the seventeenth test onward.
  gl?.getExtension('WEBGL_lose_context')?.loseContext()
  gl = null
  canvas?.remove()
  canvas = null
})

it('grants a WebGL2 context, which proves the SwiftShader launch flags are right', () => {
  canvas = document.createElement('canvas')
  canvas.width = 4
  canvas.height = 4
  document.body.append(canvas)
  gl = canvas.getContext('webgl2')
  // A null here is the flag triple, not a library bug: --use-gl=angle --use-angle=swiftshader
  // --enable-unsafe-swiftshader. Fix the flags, never re-run.
  expect(gl).not.toBeNull()
  expect(gl!.getParameter(gl!.MAX_TEXTURE_SIZE)).toBeGreaterThanOrEqual(4096)
})

it('reads back exactly the bytes it wrote, which is what the tier claims', () => {
  canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  document.body.append(canvas)
  gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true })
  expect(gl).not.toBeNull()

  gl!.viewport(0, 0, 1, 1)
  gl!.clearColor(1, 0, 0, 1)
  gl!.clear(gl!.COLOR_BUFFER_BIT)

  const pixel = new Uint8Array(4)
  gl!.readPixels(0, 0, 1, 1, gl!.RGBA, gl!.UNSIGNED_BYTE, pixel)
  expect(Array.from(pixel)).toEqual([255, 0, 0, 255])
})
