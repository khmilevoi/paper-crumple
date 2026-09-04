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
  /**
   * What `checkFramebufferStatus`, `getError`, `LINK_STATUS`, `COMPILE_STATUS` (per stage) and
   * `COMPLETION_STATUS_KHR` (false for the next `pendingPolls` reads, then true) answer; a test
   * flips these to fail a path or to keep a link pending.
   */
  readonly answers: {
    framebufferStatus: string
    error: string
    linkStatus: boolean
    compileStatus: { VERTEX_SHADER: boolean; FRAGMENT_SHADER: boolean }
    pendingPolls: number
  }
}

/** `parallel`: the fake offers `KHR_parallel_shader_compile`, so the link is deferred (P7). */
function fakeGl(o: { parallel?: boolean } = {}): FakeGl {
  const counts = new Map<string, number>()
  const enums = new Map<string, number>()
  const names = new Map<number, string>()
  const parameters: string[] = []
  const answers = {
    framebufferStatus: 'FRAMEBUFFER_COMPLETE',
    error: 'NO_ERROR',
    linkStatus: true,
    compileStatus: { VERTEX_SHADER: true, FRAGMENT_SHADER: true },
    pendingPolls: 0,
  }
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
        if (args[0] === 'KHR_parallel_shader_compile') {
          return o.parallel === true
            ? { COMPLETION_STATUS_KHR: enumValue('COMPLETION_STATUS_KHR') }
            : null
        }
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
      case 'getShaderParameter': {
        const pname = names.get(args[1] as number)
        if (pname !== 'COMPILE_STATUS') return true
        const stage = (args[0] as { type?: 'VERTEX_SHADER' | 'FRAGMENT_SHADER' }).type
        return stage === undefined ? true : answers.compileStatus[stage]
      }
      case 'getProgramParameter': {
        const pname = names.get(args[1] as number)
        if (pname === 'LINK_STATUS') return answers.linkStatus
        if (pname === 'COMPLETION_STATUS_KHR') {
          if (answers.pendingPolls > 0) {
            answers.pendingPolls -= 1
            return false
          }
          return true
        }
        return true
      }
      case 'getShaderInfoLog':
      case 'getProgramInfoLog':
        return 'fake log'
      case 'createShader':
        return { kind: name, id: nextId++, type: names.get(args[0] as number) }
      case 'checkFramebufferStatus':
        return enumValue(answers.framebufferStatus)
      case 'getError':
        return enumValue(answers.error)
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
    expect(texture).not.toBeInstanceOf(GlError)
    if (GlError.is(texture)) return
    f.reset()
    const target = ctx.target(texture)
    expect(target).not.toBeInstanceOf(GlError)
    expect(f.parameters()).toEqual(['DRAW_FRAMEBUFFER_BINDING'])
    expect(f.calls('isEnabled')).toBe(0)
  })
})

describe('scope() on an owned context (§4.0): the pinned baseline, no query at all', () => {
  it('captures the baseline once at creation and never queries again, restoring as before', () => {
    const f = fakeGl()
    const ctx = createGlContext(f.gl, { owned: true })
    f.reset()
    ctx.scope(() => {
      ctx.scope(() => undefined)
    })
    ctx.scope(() => undefined)
    expect(f.calls('getParameter')).toBe(0)
    expect(f.calls('isEnabled')).toBe(0)
    // The writes are the same writes: one full restore per outermost scope.
    expect(f.calls('useProgram')).toBe(2)
    expect(f.calls('bindVertexArray')).toBe(2)
    expect(f.calls('blendFuncSeparate')).toBe(2)
    expect(f.calls('pixelStorei')).toBe(2 * 9)
  })

  it('allocates without a query outside a scope, and with the one binding query inside one', () => {
    const f = fakeGl()
    const ctx = createGlContext(f.gl, { owned: true })
    f.reset()
    const texture = ctx.texture({ width: 8, height: 8, format: 'RGBA8' })
    expect(texture).not.toBeInstanceOf(GlError)
    if (GlError.is(texture)) return
    ctx.target(texture)
    // Outside a scope nothing but the library has written, so both bindings are the baseline's.
    expect(f.parameters()).toEqual([])
    ctx.scope(() => {
      f.reset()
      // Inside a scope a slot may have bound anything through the escape hatch; ask.
      const inner = ctx.texture({ width: 8, height: 8, format: 'R8' })
      expect(inner).not.toBeInstanceOf(GlError)
      if (GlError.is(inner)) return
      ctx.target(inner)
      expect(f.parameters()).toEqual(['TEXTURE_BINDING_2D', 'DRAW_FRAMEBUFFER_BINDING'])
    })
  })
})

describe('status queries off the hot path', () => {
  const desc = { width: 8, height: 8, format: 'RGBA8' } as const

  it('checks framebuffer completeness once per (format, size), and trusts a proven combination', () => {
    const f = fakeGl()
    const ctx = createGlContext(f.gl)
    const a = ctx.texture(desc)
    const b = ctx.texture(desc)
    const c = ctx.texture({ ...desc, width: 16 })
    expect(a).not.toBeInstanceOf(GlError)
    expect(b).not.toBeInstanceOf(GlError)
    expect(c).not.toBeInstanceOf(GlError)
    if (GlError.is(a) || GlError.is(b) || GlError.is(c)) return
    f.reset()
    expect(ctx.target(a)).not.toBeInstanceOf(GlError)
    expect(f.calls('checkFramebufferStatus')).toBe(1)
    expect(ctx.target(b)).not.toBeInstanceOf(GlError)
    expect(ctx.target(a)).not.toBeInstanceOf(GlError)
    expect(f.calls('checkFramebufferStatus')).toBe(1)
    // A never-proven combination is checked, and its failure is still reported.
    f.answers.framebufferStatus = 'FRAMEBUFFER_UNSUPPORTED'
    const bad = ctx.target(c)
    expect(f.calls('checkFramebufferStatus')).toBe(2)
    expect(bad).toBeInstanceOf(GlError)
    expect((bad as InstanceType<typeof GlError>).message).toMatch(
      /^RGBA8: framebuffer incomplete, status 0x/,
    )
    // A failure proves nothing: the next attempt at that combination asks again.
    f.answers.framebufferStatus = 'FRAMEBUFFER_COMPLETE'
    expect(ctx.target(c)).not.toBeInstanceOf(GlError)
    expect(f.calls('checkFramebufferStatus')).toBe(3)
  })

  it('reads getError after every allocation, so a failure surfaces on the allocation that caused it', () => {
    const f = fakeGl()
    const ctx = createGlContext(f.gl)
    f.reset()
    expect(ctx.texture(desc)).not.toBeInstanceOf(GlError)
    expect(ctx.texture(desc)).not.toBeInstanceOf(GlError)
    expect(ctx.texture({ ...desc, label: 'another' })).not.toBeInstanceOf(GlError)
    // One per allocation, proven combination or not: an error left on the flag would be read
    // and discarded by the next reader, and a texture without storage would pass as a success.
    expect(f.calls('getError')).toBe(3)
    f.answers.error = 'OUT_OF_MEMORY'
    const bad = ctx.texture({ ...desc, label: 'mask' })
    expect(f.calls('getError')).toBe(4)
    expect(bad).toBeInstanceOf(GlError)
    expect((bad as InstanceType<typeof GlError>).message).toMatch(
      /^mask: texStorage2D 8x8 RGBA8 failed, GL error 0x[0-9a-f]+$/,
    )
    // The failed allocation returned before any target could be built over it, so the
    // completeness cache never sees it: the next target of that combination still asks.
    f.answers.error = 'NO_ERROR'
    const good = ctx.texture(desc)
    expect(good).not.toBeInstanceOf(GlError)
    if (GlError.is(good)) return
    f.reset()
    expect(ctx.target(good)).not.toBeInstanceOf(GlError)
    expect(f.calls('checkFramebufferStatus')).toBe(1)
  })
})

describe('program(): the deferred link (P7, §5.2 amendment)', () => {
  const VS = 'void main() {}'
  const FS = 'void main() {}'

  it('without KHR_parallel_shader_compile checks the link synchronously, as before, and ready() resolves at once', async () => {
    const f = fakeGl()
    const ctx = createGlContext(f.gl)
    f.reset()
    const program = ctx.program(VS, FS, 'sync')
    expect(program).not.toBeInstanceOf(GlError)
    if (GlError.is(program)) return
    // Two COMPILE_STATUS reads and one LINK_STATUS read, inside program() itself.
    expect(f.calls('getShaderParameter')).toBe(2)
    expect(f.calls('getProgramParameter')).toBe(1)
    expect(f.calls('deleteShader')).toBe(2)
    f.reset()
    expect(await program.ready()).toBeUndefined()
    expect(f.calls('getProgramParameter')).toBe(0)
    program.dispose()
    expect(f.calls('deleteProgram')).toBe(1)

    f.answers.linkStatus = false
    const broken = ctx.program(VS, FS, 'bad')
    expect(broken).toBeInstanceOf(GlError)
    expect((broken as InstanceType<typeof GlError>).message).toBe(
      'bad: program did not link: fake log',
    )
  })

  it('with the extension reads no status inside program(), and ready() polls COMPLETION_STATUS_KHR once per turn until the link is done', async () => {
    const f = fakeGl({ parallel: true })
    const ctx = createGlContext(f.gl)
    f.reset()
    f.answers.pendingPolls = 3
    const program = ctx.program(VS, FS, 'deferred')
    expect(program).not.toBeInstanceOf(GlError)
    if (GlError.is(program)) return
    // mount() returns here; nothing has waited on the driver.
    expect(f.calls('linkProgram')).toBe(1)
    expect(f.calls('getShaderParameter')).toBe(0)
    expect(f.calls('getProgramParameter')).toBe(0)
    expect(f.calls('deleteShader')).toBe(0)

    const first = program.ready()
    const second = program.ready()
    expect(second).toBe(first) // one wait, however many callers
    expect(await first).toBeUndefined()
    // Three "still compiling" polls, one "done", then the one LINK_STATUS read — and the shader
    // status reads, which need the shaders alive until now.
    expect(f.calls('getProgramParameter')).toBe(5)
    expect(f.calls('getShaderParameter')).toBe(2)
    expect(f.calls('deleteShader')).toBe(2)
    expect(f.answers.pendingPolls).toBe(0)
    // Settled: a later ready() re-polls nothing.
    f.reset()
    expect(await program.ready()).toBeUndefined()
    expect(f.calls('getProgramParameter')).toBe(0)
    program.dispose()
    expect(f.calls('deleteProgram')).toBe(1)
  })

  it('delivers a compile or link failure through ready(), worded as the synchronous path worded it', async () => {
    const f = fakeGl({ parallel: true })
    const ctx = createGlContext(f.gl)

    f.answers.compileStatus.FRAGMENT_SHADER = false
    const compileFailed = ctx.program(VS, FS, 'bad')
    expect(compileFailed).not.toBeInstanceOf(GlError)
    if (GlError.is(compileFailed)) return
    f.reset()
    const outcome = await compileFailed.ready()
    expect(outcome).toBeInstanceOf(GlError)
    expect(outcome?.message).toBe('bad: fragment shader did not compile: fake log')
    // The failed program is released by the poll, as the synchronous path released it.
    expect(f.calls('deleteProgram')).toBe(1)
    expect(f.calls('deleteShader')).toBe(2)
    compileFailed.dispose()
    expect(f.calls('deleteProgram')).toBe(1)

    f.answers.compileStatus.FRAGMENT_SHADER = true
    f.answers.linkStatus = false
    const linkFailed = ctx.program(VS, FS, 'worse')
    if (GlError.is(linkFailed)) return
    const linkOutcome = await linkFailed.ready()
    expect(linkOutcome?.message).toBe('worse: program did not link: fake log')
  })

  it('defers the deleteProgram of a dispose() during the wait to the poll, and ready() reports it', async () => {
    const f = fakeGl({ parallel: true })
    const ctx = createGlContext(f.gl)
    f.answers.pendingPolls = 2
    const program = ctx.program(VS, FS, 'gone')
    if (GlError.is(program)) return
    f.reset()
    program.dispose()
    // ANGLE's deleteProgram resolves the link first — the very block the deferral removes — so
    // the program is only deleted once the driver reports completion.
    expect(f.calls('deleteProgram')).toBe(0)
    const outcome = await program.ready()
    expect(outcome?.message).toBe('gone: program disposed before its link completed')
    expect(f.calls('deleteProgram')).toBe(1)
    expect(f.calls('deleteShader')).toBe(2)
    // Never twice.
    program.dispose()
    expect(f.calls('deleteProgram')).toBe(1)
  })

  it('ctx.dispose() during a wait follows the same path: nothing blocks, the poll cleans up', async () => {
    const f = fakeGl({ parallel: true })
    const ctx = createGlContext(f.gl)
    f.answers.pendingPolls = 1
    const program = ctx.program(VS, FS, 'ctx')
    if (GlError.is(program)) return
    f.reset()
    ctx.dispose()
    expect(f.calls('deleteProgram')).toBe(0)
    expect(await program.ready()).toBeInstanceOf(GlError)
    expect(f.calls('deleteProgram')).toBe(1)
  })
})
