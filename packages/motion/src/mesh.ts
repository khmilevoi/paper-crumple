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

/**
 * §8.4's twelve preconfigured VAOs for one bucket, built from the pack's frame blocks as stored.
 *
 * **`read` — the error flag through the context's accounting (S7, §7.3, §8.1).** The build ends
 * with one read of the sticky error flag, the way it always has. Given `read`, the library's own
 * caller binds it to `GlContext.checkAllocations()`, and the flag is read twice through it: once
 * BEFORE the first buffer and once after the VAOs. The first read settles whatever another slot
 * left unchecked — the sheet's allocation batch, aborted at its yield with an `OUT_OF_MEMORY` of
 * its own still on the flag — so that flag fails and releases that batch, by order, instead of
 * being read here and discarded as a VAO error while an unbacked resident lives on under its
 * key. The second read then has nothing unchecked to blame and is this mesh's own: a refused
 * block fails the mesh exactly as before. Without `read` the mesh reads `gl.getError()` itself,
 * once, after the VAOs — the signature that shipped, kept for callers outside the library.
 */
export function createSheetMesh(
  gl: WebGL2RenderingContext,
  pack: Pack,
  read?: () => InstanceType<typeof GlError> | number,
): InstanceType<typeof GlError> | SheetMesh {
  const buffers: WebGLBuffer[] = []
  const vaos: WebGLVertexArrayObject[] = []
  let bytes = 0

  // Given a reader, the first read is another batch's settle (doc comment above); its outcome
  // is that batch's, and the mesh has allocated nothing yet.
  if (read !== undefined) read()

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

  // This mesh's own read: with a reader, nothing is unchecked by now (the read above settled
  // it), so a fatal flag comes back as a number and is the VAOs' — the same outcome, the same
  // wording, as the raw read without one.
  const err = read === undefined ? gl.getError() : read()
  if (GlError.is(err)) {
    return fail(
      `GL error while building the VAOs (an allocation batch failed with it: ${err.message})`,
    )
  }
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
