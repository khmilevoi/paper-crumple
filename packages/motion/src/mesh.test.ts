import { GlError } from '@paper-crumple/core'
import { createGlContext } from '@paper-crumple/core/unstable'
import { describe, expect, it } from 'vitest'

import { createSheetMesh } from './mesh.js'
import { parsePack, type Pack } from './pack.js'
import { readTinyBin, readTinyManifest } from '../test/fixture.js'

/**
 * A counting stand-in for `WebGL2RenderingContext` with a sticky error flag the way GL's is —
 * one read returns it and clears it — so the mesh's read of the flag can be placed. Nothing is
 * rendered; every method answers a plausible value. `failBufferAt` N: the N-th `bufferData`
 * raises OUT_OF_MEMORY — the driver refusing one of the mesh's own blocks.
 */
function fakeGl() {
  const counts = new Map<string, number>()
  const enums = new Map<string, number>()
  const names = new Map<number, string>()
  const answers = { error: 'NO_ERROR', failBufferAt: 0 }
  let nextId = 1
  const enumValue = (name: string): number => {
    let value = enums.get(name)
    if (value === undefined) {
      value = 0x1000 + enums.size
      enums.set(name, value)
      names.set(value, name)
    }
    return value
  }
  const arrayValued = new Set(['VIEWPORT', 'SCISSOR_BOX', 'COLOR_CLEAR_VALUE'])
  const call = (name: string, args: unknown[]): unknown => {
    counts.set(name, (counts.get(name) ?? 0) + 1)
    switch (name) {
      case 'getExtension':
        return null
      case 'getParameter': {
        const pname = names.get(args[0] as number) ?? String(args[0])
        if (pname === 'MAX_TEXTURE_SIZE') return 4096
        if (pname === 'ACTIVE_TEXTURE') return enumValue('TEXTURE0')
        if (arrayValued.has(pname)) return [0, 0, 0, 0]
        return null
      }
      case 'isEnabled':
        return false
      case 'getShaderParameter':
      case 'getProgramParameter':
        return true
      case 'getShaderInfoLog':
      case 'getProgramInfoLog':
        return ''
      case 'checkFramebufferStatus':
        return enumValue('FRAMEBUFFER_COMPLETE')
      case 'getError': {
        const flag = answers.error
        answers.error = 'NO_ERROR'
        return enumValue(flag)
      }
      case 'bufferData':
        if (answers.failBufferAt > 0 && counts.get(name) === answers.failBufferAt) {
          answers.error = 'OUT_OF_MEMORY'
        }
        return undefined
      case 'createShader':
      case 'createProgram':
      case 'createTexture':
      case 'createFramebuffer':
      case 'createVertexArray':
      case 'createBuffer':
      case 'getUniformLocation':
        return { kind: name, id: nextId++ }
      default:
        return undefined
    }
  }
  const gl = new Proxy({} as Record<string, unknown>, {
    get(_, prop) {
      if (typeof prop !== 'string') return undefined
      if (prop === 'canvas') return { width: 4, height: 4 }
      if (/^[A-Z][A-Z0-9_]*$/.test(prop)) return enumValue(prop)
      return (...args: unknown[]) => call(prop, args)
    },
  }) as unknown as WebGL2RenderingContext
  return {
    gl,
    answers,
    calls: (name: string) => counts.get(name) ?? 0,
    reset: () => counts.clear(),
  }
}

function tinyPack(): Pack {
  const pack = parsePack(readTinyBin(), readTinyManifest())
  expect(pack).not.toBeInstanceOf(Error)
  return pack as Pack
}

const desc = { width: 8, height: 8, format: 'RGBA8', label: 'artwork' } as const

describe("createSheetMesh reads the error flag through the context's accounting (S7, spec 7.3, 8.1)", () => {
  it("an OUT_OF_MEMORY another slot left unchecked is that batch's to fail, never a VAO error: the batch is released, the mesh is built", () => {
    const f = fakeGl()
    const ctx = createGlContext(f.gl)
    const pack = tinyPack()
    // The sheet's batch, aborted at its yield: unchecked, the driver's flag still set.
    const resident = ctx.allocations(() => ctx.texture(desc))
    expect(resident).not.toBeInstanceOf(GlError)
    if (GlError.is(resident)) return
    f.answers.error = 'OUT_OF_MEMORY'
    f.reset()
    const mesh = ctx.scope(() => createSheetMesh(f.gl, pack, () => ctx.checkAllocations()))
    expect(mesh).not.toBeInstanceOf(Error)
    // The flag was the batch's: its allocation is released and the pools will find it dead
    // (`alive`), rather than the OOM being read and discarded as a mesh failure while an
    // unbacked resident lives on under its key.
    expect(ctx.alive(resident)).toBe(false)
    expect(f.calls('deleteTexture')).toBe(1)
    expect(ctx.checkAllocations()).toBe(f.gl.NO_ERROR)
    if (!(mesh instanceof Error)) mesh.dispose()
  })

  it("the mesh's own refused block still fails the mesh: the read after the VAOs has nothing unchecked to blame", () => {
    const f = fakeGl()
    const ctx = createGlContext(f.gl)
    const pack = tinyPack()
    f.answers.failBufferAt = 1
    const mesh = ctx.scope(() => createSheetMesh(f.gl, pack, () => ctx.checkAllocations()))
    expect(mesh).toBeInstanceOf(GlError)
    expect((mesh as InstanceType<typeof GlError>).message).toMatch(
      /^sheetMesh\(.*\): GL error 0x[0-9a-f]+ while building the VAOs$/,
    )
  })

  it('without a reader it reads the flag itself, once, as it always did', () => {
    const f = fakeGl()
    const pack = tinyPack()
    f.reset()
    const mesh = createSheetMesh(f.gl, pack)
    expect(mesh).not.toBeInstanceOf(Error)
    expect(f.calls('getError')).toBe(1)
    f.answers.error = 'OUT_OF_MEMORY'
    expect(createSheetMesh(f.gl, pack)).toBeInstanceOf(GlError)
  })
})
