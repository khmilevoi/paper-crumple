import { describe, expect, it } from 'vitest'
import { GlError } from './errors.js'
import { createGlContext } from './gl-context.js'

/**
 * A counting stand-in for `WebGL2RenderingContext`: every method is answered with a plausible
 * value and counted by name, and every `getParameter` remembers which enum it was asked for.
 * Nothing is rendered. What this pins is the number and kind of synchronous queries the context
 * issues per operation — the calls a browser answers with a GPU-process round trip — which no
 * level-2 test can see and which the whole state-shadow design exists to remove.
 */
interface FakeGl {
  readonly gl: WebGL2RenderingContext
  /** Calls to `name` since the last `reset()`. */
  calls(name: string): number
  /** The enum names `getParameter` was asked for since the last `reset()`, in order. */
  parameters(): string[]
  reset(): void
  /** What `checkFramebufferStatus` and `getError` answer; a test flips these to fail a path. */
  readonly answers: { framebufferStatus: string; error: string }
}

function fakeGl(): FakeGl {
  const counts = new Map<string, number>()
  const enums = new Map<string, number>()
  const names = new Map<number, string>()
  const parameters: string[] = []
  const answers = { framebufferStatus: 'FRAMEBUFFER_COMPLETE', error: 'NO_ERROR' }
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
        return args[0] === 'EXT_color_buffer_float' ? {} : null
      case 'getParameter': {
        const pname = names.get(args[0] as number) ?? String(args[0])
        parameters.push(pname)
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
      case 'checkFramebufferStatus':
        return enumValue(answers.framebufferStatus)
      case 'getError':
        return enumValue(answers.error)
      case 'createShader':
      case 'createProgram':
      case 'createTexture':
      case 'createFramebuffer':
      case 'createVertexArray':
      case 'createBuffer':
      case 'createSampler':
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
    calls: (name) => counts.get(name) ?? 0,
    parameters: () => [...parameters],
    reset() {
      counts.clear()
      parameters.length = 0
    },
    answers,
  }
}

/** `captureGlState`'s footprint: 31 `getParameter` enums and 5 `isEnabled` caps (§5.1). */
const CAPTURE = { getParameter: 31, isEnabled: 5 }

describe('scope() on an injected context (§7.3): capture at the outermost entry only', () => {
  it('pays one full capture for the outermost scope and none for a nested one', () => {
    const f = fakeGl()
    const ctx = createGlContext(f.gl)
    f.reset()
    ctx.scope(() => {
      expect(f.calls('getParameter')).toBe(CAPTURE.getParameter)
      expect(f.calls('isEnabled')).toBe(CAPTURE.isEnabled)
      ctx.scope(() => undefined)
      ctx.scope(() => ctx.scope(() => undefined))
      expect(f.calls('getParameter')).toBe(CAPTURE.getParameter)
      expect(f.calls('isEnabled')).toBe(CAPTURE.isEnabled)
    })
    expect(f.calls('getParameter')).toBe(CAPTURE.getParameter)
  })
})

describe('texture() and target() save only the binding they disturb', () => {
  it('asks for TEXTURE_BINDING_2D alone when allocating a texture', () => {
    const f = fakeGl()
    const ctx = createGlContext(f.gl)
    f.reset()
    const texture = ctx.texture({ width: 8, height: 8, format: 'RGBA8' })
    expect(texture).not.toBeInstanceOf(GlError)
    expect(f.parameters()).toEqual(['TEXTURE_BINDING_2D'])
    expect(f.calls('isEnabled')).toBe(0)
  })

  it('asks for DRAW_FRAMEBUFFER_BINDING alone when wrapping a target', () => {
    const f = fakeGl()
    const ctx = createGlContext(f.gl)
    const texture = ctx.texture({ width: 8, height: 8, format: 'RGBA8' })
    if (GlError.is(texture)) return
    f.reset()
    const target = ctx.target(texture)
    expect(target).not.toBeInstanceOf(GlError)
    expect(f.parameters()).toEqual(['DRAW_FRAMEBUFFER_BINDING'])
    expect(f.calls('isEnabled')).toBe(0)
  })
})
