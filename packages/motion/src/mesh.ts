/**
 * The sheet mesh: twelve preconfigured VAOs per bucket, thirty-six in total (§8.4).
 *
 * The spike kept one dynamic buffer and uploaded the pose's frame block with a `bufferSubData` on
 * every swap. That is removed here, and it is the one place this port deliberately diverges from
 * `sheetMesh.js`. Twelve frames is 456 336 B per bucket and 1.37 MB for all three, plus 82 952 B
 * of UV and indices per bucket — negligible against a 64 MiB budget. WebGL2 has no `baseVertex`,
 * but it is not needed. What disappears is a whole class of mutable state, which is what makes N
 * sprites cheap.
 *
 * Per bucket: one UV buffer, one index buffer, twelve frame buffers, twelve VAOs. Each VAO binds
 * `uv` from the shared UV buffer, `position` / `normal` / `ao` from its own frame buffer, and the
 * shared index buffer as its element array — element-array binding is VAO state, so it is
 * captured once per VAO rather than rebound per draw.
 *
 * **Call this inside `ctx.scope()`.** It churns the VAO binding, which §5.1 saves; it also churns
 * `ARRAY_BUFFER`, which §5.1 does **not** save, so it unbinds that itself before returning.
 */
import { GlError } from '@paper-crumple/core'

import { frameBytes } from './pack.js'
import type { Pack } from './pack.js'
import { ATTR } from './shaders.js'

export interface SheetMesh {
  readonly indexCount: number
  readonly frameCount: number
  /** GPU bytes this mesh holds: twelve frame blocks plus one UV block and one index block. */
  readonly bytes: number
  /** Binds the VAO preconfigured for `storedFrame` and issues one `drawElements`. */
  draw(storedFrame: number): InstanceType<typeof GlError> | undefined
  dispose(): void
}

export function createSheetMesh(
  gl: WebGL2RenderingContext,
  pack: Pack,
): InstanceType<typeof GlError> | SheetMesh {
  const buffers: WebGLBuffer[] = []
  const vaos: WebGLVertexArrayObject[] = []
  let bytes = 0

  const fail = (message: string): InstanceType<typeof GlError> => {
    for (const vao of vaos) gl.deleteVertexArray(vao)
    for (const buffer of buffers) gl.deleteBuffer(buffer)
    gl.bindVertexArray(null)
    gl.bindBuffer(gl.ARRAY_BUFFER, null)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null)
    return new GlError(`sheetMesh(${pack.bucket}): ${message}`)
  }

  // Element-array binding is VAO state (§3.1), and unlike ARRAY_BUFFER it is never restored by
  // any scope §5.1 saves. Unbind the caller's VAO first so the index buffer below binds against
  // the default VAO, not whatever VAO the caller had current.
  gl.bindVertexArray(null)

  function buffer(target: number, data: ArrayBufferView): WebGLBuffer | null {
    const b = gl.createBuffer()
    if (!b) return null
    buffers.push(b)
    gl.bindBuffer(target, b)
    gl.bufferData(target, data, gl.STATIC_DRAW)
    bytes += data.byteLength
    return b
  }

  const uvBuffer = buffer(gl.ARRAY_BUFFER, pack.uvs)
  if (!uvBuffer) return fail('createBuffer failed for the UV block')
  const indexBuffer = buffer(gl.ELEMENT_ARRAY_BUFFER, pack.indices)
  if (!indexBuffer) return fail('createBuffer failed for the index block')

  const { layout } = pack
  for (let frame = 0; frame < pack.frameCount; frame++) {
    const block = frameBytes(pack, frame)
    if (block instanceof Error) return fail(`stored frame ${frame}: ${block.message}`)

    const vao = gl.createVertexArray()
    if (!vao) return fail(`createVertexArray failed at stored frame ${frame}`)
    vaos.push(vao)
    gl.bindVertexArray(vao)

    const frameBuffer = buffer(gl.ARRAY_BUFFER, block)
    if (!frameBuffer) return fail(`createBuffer failed at stored frame ${frame}`)
    // The frame block is stored exactly as the GPU wants it: positions as HALF_FLOAT, normals as
    // normalized BYTE oct pairs, AO as one normalized UNSIGNED_BYTE. No CPU decode, ever.
    gl.enableVertexAttribArray(ATTR.position)
    gl.vertexAttribPointer(ATTR.position, 3, gl.HALF_FLOAT, false, 6, layout.positions)
    gl.enableVertexAttribArray(ATTR.normal)
    gl.vertexAttribPointer(ATTR.normal, 2, gl.BYTE, true, 2, layout.normals)
    gl.enableVertexAttribArray(ATTR.ao)
    gl.vertexAttribPointer(ATTR.ao, 1, gl.UNSIGNED_BYTE, true, 1, layout.ao)

    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuffer)
    gl.enableVertexAttribArray(ATTR.uv)
    gl.vertexAttribPointer(ATTR.uv, 2, gl.FLOAT, false, 0, 0)

    // Element-array binding is VAO state, so it is captured here and never rebound at draw time.
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer)
  }

  gl.bindVertexArray(null)
  gl.bindBuffer(gl.ARRAY_BUFFER, null)
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null)

  const err = gl.getError()
  if (err !== gl.NO_ERROR) return fail(`GL error 0x${err.toString(16)} while building the VAOs`)

  const indexCount = pack.indexCount
  const frameCount = pack.frameCount
  let disposed = false

  return {
    indexCount,
    frameCount,
    bytes,

    draw(storedFrame) {
      if (disposed) return new GlError(`sheetMesh(${pack.bucket}): drawn after dispose`)
      if (!Number.isInteger(storedFrame) || storedFrame < 0 || storedFrame >= frameCount) {
        return new GlError(
          `sheetMesh(${pack.bucket}): stored frame ${storedFrame} out of 0..${frameCount - 1}`,
        )
      }
      gl.bindVertexArray(vaos[storedFrame])
      gl.drawElements(gl.TRIANGLES, indexCount, gl.UNSIGNED_SHORT, 0)
      return undefined
    },

    dispose() {
      if (disposed) return
      disposed = true
      for (const vao of vaos) gl.deleteVertexArray(vao)
      for (const b of buffers) gl.deleteBuffer(b)
      vaos.length = 0
      buffers.length = 0
    },
  }
}
