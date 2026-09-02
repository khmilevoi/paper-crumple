import { GlError } from '@paper-crumple/core'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { createSheetMesh, type SheetMesh } from './mesh.js'
import type { Pack } from './pack.js'
import { parsePack } from './pack.js'
import pack2x3 from './packs/2x3.js'
import { ATTR, SHEET_FS, SHEET_VS } from './shaders.js'
import { createGlFixture, type GlFixture } from './testing/gl-fixture.js'

let fixture: GlFixture | null = null
let pack: Pack

beforeAll(async () => {
  // Fetched through the module's own binUrl, which is what exercises the `new URL` design.
  const response = await fetch(String(pack2x3.binUrl))
  expect(response.ok, `${String(pack2x3.binUrl)}: HTTP ${response.status}`).toBe(true)
  const parsed = parsePack(await response.arrayBuffer(), pack2x3.manifest)
  expect(parsed).not.toBeInstanceOf(Error)
  pack = parsed as Pack
})

afterEach(() => {
  // §4.0 caps live WebGL2 contexts at roughly sixteen and Vitest opens one page per file.
  fixture?.dispose()
  fixture = null
})

function open(): GlFixture {
  fixture = createGlFixture(64, 64)
  expect(fixture.gl, 'no WebGL2 context — check the SwiftShader launch flags (§11)').not.toBeNull()
  return fixture
}

function build(f: GlFixture): SheetMesh {
  const mesh = f.ctx.scope(() => createSheetMesh(f.gl, pack))
  expect(mesh).not.toBeInstanceOf(Error)
  return mesh as SheetMesh
}

/**
 * Binds the real sheet program so `draw()`'s own `drawElements` has one current — WebGL2 raises
 * `INVALID_OPERATION` without it, which would make `gl.getError()` assertions below unfalsifiable
 * for a reason that has nothing to do with the mesh (Fix round 1, Important 1 and 2).
 */
function bindSheetProgram(f: GlFixture): () => void {
  const program = f.ctx.program(SHEET_VS, SHEET_FS, 'sheet')
  if (program instanceof Error) {
    expect.fail(`sheet program failed to compile: ${program.message}`)
  }
  f.gl.useProgram(program.handle)
  return () => program.dispose()
}

describe('the sheet mesh (§8.4)', () => {
  it('preconfigures one VAO per stored frame — twelve, not one', () => {
    const f = open()
    const mesh = build(f)
    expect(mesh.frameCount).toBe(12)
    expect(mesh.indexCount).toBe(24576)
    mesh.dispose()
  })

  it('costs 539 288 B per bucket: twelve frames plus one UV and one index block', () => {
    const f = open()
    const mesh = build(f)
    // 12 * 38028 = 456336 of frames, 8 * 4225 = 33800 of UV, 2 * 24576 = 49152 of indices.
    expect(mesh.bytes).toBe(456_336 + 33_800 + 49_152)
    mesh.dispose()
  })

  it('draws every stored frame without a GL error and without a bufferSubData', () => {
    const f = open()
    const mesh = build(f)
    const disposeProgram = bindSheetProgram(f)
    f.ctx.scope(() => {
      for (let i = 0; i < mesh.frameCount; i++) expect(mesh.draw(i)).toBeUndefined()
    })
    expect(f.gl.getError()).toBe(f.gl.NO_ERROR)
    disposeProgram()
    mesh.dispose()
  })

  it('rejects a frame outside 0..frameCount-1 with a GlError, and draws nothing', () => {
    const f = open()
    const mesh = build(f)
    const disposeProgram = bindSheetProgram(f)
    f.ctx.scope(() => {
      expect(GlError.is(mesh.draw(-1))).toBe(true)
      expect(GlError.is(mesh.draw(12))).toBe(true)
      expect(GlError.is(mesh.draw(1.5))).toBe(true)
    })
    expect(f.gl.getError()).toBe(f.gl.NO_ERROR)
    disposeProgram()
    mesh.dispose()
  })

  it('enables exactly the four attribute locations §3.1 fixes, on every VAO', () => {
    const f = open()
    const { gl } = f
    const mesh = build(f)
    f.ctx.scope(() => {
      for (let i = 0; i < mesh.frameCount; i++) {
        mesh.draw(i)
        for (const loc of [ATTR.position, ATTR.normal, ATTR.ao, ATTR.uv]) {
          expect(gl.getVertexAttrib(loc, gl.VERTEX_ATTRIB_ARRAY_ENABLED)).toBe(true)
        }
        expect(gl.getVertexAttrib(4, gl.VERTEX_ATTRIB_ARRAY_ENABLED)).toBe(false)
      }
    })
    mesh.dispose()
  })

  it('binds the stored formats: HALF_FLOAT x3, normalized BYTE x2, normalized UNSIGNED_BYTE x1, FLOAT x2', () => {
    const f = open()
    const { gl } = f
    const mesh = build(f)
    f.ctx.scope(() => {
      mesh.draw(0)
      expect(gl.getVertexAttrib(ATTR.position, gl.VERTEX_ATTRIB_ARRAY_SIZE)).toBe(3)
      expect(gl.getVertexAttrib(ATTR.position, gl.VERTEX_ATTRIB_ARRAY_TYPE)).toBe(gl.HALF_FLOAT)
      expect(gl.getVertexAttrib(ATTR.normal, gl.VERTEX_ATTRIB_ARRAY_SIZE)).toBe(2)
      expect(gl.getVertexAttrib(ATTR.normal, gl.VERTEX_ATTRIB_ARRAY_TYPE)).toBe(gl.BYTE)
      expect(gl.getVertexAttrib(ATTR.normal, gl.VERTEX_ATTRIB_ARRAY_NORMALIZED)).toBe(true)
      expect(gl.getVertexAttrib(ATTR.ao, gl.VERTEX_ATTRIB_ARRAY_SIZE)).toBe(1)
      expect(gl.getVertexAttrib(ATTR.ao, gl.VERTEX_ATTRIB_ARRAY_TYPE)).toBe(gl.UNSIGNED_BYTE)
      expect(gl.getVertexAttrib(ATTR.ao, gl.VERTEX_ATTRIB_ARRAY_NORMALIZED)).toBe(true)
      expect(gl.getVertexAttrib(ATTR.uv, gl.VERTEX_ATTRIB_ARRAY_TYPE)).toBe(gl.FLOAT)
    })
    mesh.dispose()
  })

  it('leaves no ARRAY_BUFFER bound, which §5.1 does not save and scope cannot restore', () => {
    const f = open()
    const { gl } = f
    const mesh = build(f)
    expect(gl.getParameter(gl.ARRAY_BUFFER_BINDING)).toBeNull()
    expect(gl.getParameter(gl.ELEMENT_ARRAY_BUFFER_BINDING)).toBeNull()
    mesh.dispose()
  })

  it('never overwrites the caller VAO with its own index buffer (Fix round: BLOCKING 2)', () => {
    const f = open()
    const { gl } = f
    // Element-array binding is VAO state and §5.1 never saves ELEMENT_ARRAY_BUFFER, so a mesh
    // build must not leave its index buffer bound on whatever VAO the caller had current.
    const callerVao = gl.createVertexArray()
    gl.bindVertexArray(callerVao)
    const mesh = build(f)
    gl.bindVertexArray(callerVao)
    expect(gl.getParameter(gl.ELEMENT_ARRAY_BUFFER_BINDING)).toBeNull()
    gl.bindVertexArray(null)
    gl.deleteVertexArray(callerVao)
    mesh.dispose()
  })

  it('is disposable twice without a GL error', () => {
    const f = open()
    const mesh = build(f)
    mesh.dispose()
    mesh.dispose()
    expect(f.gl.getError()).toBe(f.gl.NO_ERROR)
  })
})
