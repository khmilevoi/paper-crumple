import { describe, expect, it, vi } from 'vitest'
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
   * flips these to fail a path or to keep a link pending. `error` is a sticky flag the way GL's
   * is — one read returns it and clears it — and `errors` is a FIFO of flags read before it, for
   * a driver holding several at once (GL ES 3.0 §2.5). `failStoreAt` N: the N-th `texStorage2D`
   * since the last `reset()` raises OUT_OF_MEMORY — the fake driver that fails one allocation of
   * a batch.
   */
  readonly answers: {
    framebufferStatus: string
    error: string
    errors: string[]
    failStoreAt: number
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
    errors: [] as string[],
    failStoreAt: 0,
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
      case 'getError': {
        const queued = answers.errors.shift()
        if (queued !== undefined) return enumValue(queued)
        const flag = answers.error
        answers.error = 'NO_ERROR'
        return enumValue(flag)
      }
      case 'texStorage2D':
        if (answers.failStoreAt > 0 && counts.get(name) === answers.failStoreAt) {
          answers.errors.push('OUT_OF_MEMORY')
        }
        return undefined
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

/** `gl-context.ts`'s own `LINK_FAST_POLLS` / `LINK_SLOW_DELAY_MS`, restated here on purpose. */
const LINK_FAST_POLLS_FOR_TEST = 8
const LINK_SLOW_DELAY_MS_FOR_TEST = 1

/**
 * Every back-off turn the readiness poll takes while this is installed, as the number of
 * `getProgramParameter` calls that had run when it was armed (spec §5.2's amendment).
 *
 * A back-off turn is `setTimeout(fn, LINK_SLOW_DELAY_MS)` — the only route `nextTurn({ delay })`
 * has — while a fast turn is the `MessageChannel` this file's runtime prefers, so the timer spy
 * sees the slow phase and nothing else. During the wait the only `getProgramParameter` the
 * context issues is the `COMPLETION_STATUS_KHR` poll, so the recorded count IS the poll number,
 * and a first entry of nine says eight polls span the fast phase. The spy calls through, so the
 * turns still happen; it ignores any other timer the runtime arms.
 */
function watchBackOff(f: FakeGl): { armed: number[]; restore: () => void } {
  const armed: number[] = []
  const realTimeout = globalThis.setTimeout
  const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
    fn: () => void,
    ms?: number,
  ) => {
    if (ms === LINK_SLOW_DELAY_MS_FOR_TEST) armed.push(f.calls('getProgramParameter'))
    return realTimeout(fn, ms)
  }) as unknown as typeof setTimeout)
  return { armed, restore: () => timer.mockRestore() }
}

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

  it('without KHR_parallel_shader_compile compiles both shaders and links, then reads the three statuses inside program(), and ready() resolves at once', async () => {
    const f = fakeGl()
    const ctx = createGlContext(f.gl)
    f.reset()
    const program = ctx.program(VS, FS, 'sync')
    expect(program).not.toBeInstanceOf(GlError)
    if (GlError.is(program)) return
    // Both compiles and the link are issued first; then two COMPILE_STATUS reads and one
    // LINK_STATUS read, inside program() itself.
    expect(f.calls('compileShader')).toBe(2)
    expect(f.calls('linkProgram')).toBe(1)
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

  it('takes no delayed turn for a link that completes at once or inside the fast phase', async () => {
    const f = fakeGl({ parallel: true })
    const ctx = createGlContext(f.gl)

    // Already done at the first poll: one status read, no turn at all.
    f.reset()
    let watch = watchBackOff(f)
    const done = ctx.program(VS, FS, 'done')
    if (GlError.is(done)) return
    expect(await done.ready()).toBeUndefined()
    watch.restore()
    expect(watch.armed, 'a finished link never reaches the back-off').toEqual([])
    // The COMPLETION poll and the LINK_STATUS read, and nothing between them.
    expect(f.calls('getProgramParameter')).toBe(2)

    // The last poll the fast phase can take still costs no delay.
    f.reset()
    f.answers.pendingPolls = LINK_FAST_POLLS_FOR_TEST - 1
    watch = watchBackOff(f)
    const late = ctx.program(VS, FS, 'late')
    if (GlError.is(late)) return
    expect(await late.ready()).toBeUndefined()
    watch.restore()
    expect(watch.armed, 'eight turns are free, and this link needed seven').toEqual([])
    expect(f.calls('getProgramParameter')).toBe(LINK_FAST_POLLS_FOR_TEST + 1)
  })

  it('backs off to a delayed turn after eight fast polls when the link runs long (spec §5.2 amendment)', async () => {
    const f = fakeGl({ parallel: true })
    const ctx = createGlContext(f.gl)
    f.reset()
    // Twelve "still compiling" answers: four polls past the fast phase.
    f.answers.pendingPolls = LINK_FAST_POLLS_FOR_TEST + 4
    const watch = watchBackOff(f)
    const program = ctx.program(VS, FS, 'slow')
    if (GlError.is(program)) return
    expect(await program.ready()).toBeUndefined()
    watch.restore()
    // 13 COMPLETION polls (12 false, 1 true) + the one LINK_STATUS read.
    expect(f.calls('getProgramParameter')).toBe(LINK_FAST_POLLS_FOR_TEST + 6)
    expect(
      watch.armed,
      'the first eight polls spin, and every poll after them is armed on a timer',
    ).toEqual([9, 10, 11, 12])
    expect(f.answers.pendingPolls).toBe(0)
    expect(f.calls('deleteShader')).toBe(2)
  })

  it('gives a link that never completes up on the wall clock, once, worded as a link failure is', async () => {
    const f = fakeGl({ parallel: true })
    const ctx = createGlContext(f.gl)
    // `Infinity - 1` is `Infinity`: the driver answers "still compiling" for ever.
    f.answers.pendingPolls = Number.POSITIVE_INFINITY
    const program = ctx.program(VS, FS, 'hung')
    if (GlError.is(program)) return
    f.reset()
    // A clock that gains a million seconds a reading: whichever call the wait takes for its
    // base, the next one is already past any finite bound — so no test waits a real minute.
    let reading = 0
    const now = vi.spyOn(performance, 'now').mockImplementation(() => {
      reading += 1
      return reading * 1e9
    })
    const outcome = await program.ready()
    now.mockRestore()
    expect(outcome).toBeInstanceOf(GlError)
    expect(outcome?.message).toBe(
      'hung: program did not link: the driver did not report completion within 60000 ms',
    )
    // The fast phase runs, then the first back-off turn finds the bound gone. LINK_STATUS is
    // never read: that read is the block the deferral exists to avoid.
    expect(f.calls('getProgramParameter')).toBe(LINK_FAST_POLLS_FOR_TEST + 1)
    expect(f.calls('deleteProgram'), 'an abandoned link is released as a failed one is').toBe(1)
    expect(f.calls('deleteShader')).toBe(2)
    // Answered once, however many callers ask, and never polled again.
    f.reset()
    expect(await program.ready()).toBe(outcome)
    expect(f.calls('getProgramParameter')).toBe(0)
    program.dispose()
    expect(f.calls('deleteProgram')).toBe(0)
  })
})

describe('allocation batches (§7.3, §8.1, §10.8): one sticky-flag read per batch', () => {
  const desc = { width: 8, height: 8, format: 'RGBA8' } as const

  it('reads no status inside allocations(), and exactly one getError at checkAllocations()', () => {
    const f = fakeGl()
    const ctx = createGlContext(f.gl)
    f.reset()
    const made = ctx.allocations(() => {
      const textures = [1, 2, 3, 4, 5].map((i) =>
        ctx.texture({ ...desc, width: 8 * i, label: `t${i}` }),
      )
      const targets = textures.slice(0, 3).map((t) => (GlError.is(t) ? t : ctx.target(t)))
      return { textures, targets }
    })
    for (const t of [...made.textures, ...made.targets]) expect(t).not.toBeInstanceOf(GlError)
    // Five texStorage2D and three framebuffers, and not one round trip among them.
    expect(f.calls('texStorage2D')).toBe(5)
    expect(f.calls('createFramebuffer')).toBe(3)
    expect(f.calls('getError')).toBe(0)
    expect(f.calls('checkFramebufferStatus')).toBe(0)
    expect(ctx.checkAllocations()).toBe(f.gl.NO_ERROR)
    expect(f.calls('getError')).toBe(1)
    expect(f.calls('deleteTexture')).toBe(0)
    for (const t of made.textures) if (!GlError.is(t)) expect(ctx.alive(t)).toBe(true)
    // Settled: a second check reads the flag again and has nothing to release.
    expect(ctx.checkAllocations()).toBe(f.gl.NO_ERROR)
    expect(f.calls('getError')).toBe(2)
    expect(f.calls('deleteTexture')).toBe(0)
  })

  it('a driver that fails the third allocation of a batch: the check returns the error, every allocation of the batch is released, nothing is left to use', () => {
    const f = fakeGl()
    const ctx = createGlContext(f.gl)
    f.reset()
    f.answers.failStoreAt = 3
    const made = ctx.allocations(() => {
      const textures = [1, 2, 3, 4].map((i) =>
        ctx.texture({ ...desc, width: 8 * i, label: `t${i}` }),
      )
      const first = textures[0]!
      const target = GlError.is(first) ? first : ctx.target(first)
      return { textures, target }
    })
    // Inside the batch nothing is read, so even the failed allocation looks like a success: the
    // batch's contract is that nothing it handed out is trusted before checkAllocations().
    for (const t of made.textures) expect(t).not.toBeInstanceOf(GlError)
    expect(made.target).not.toBeInstanceOf(GlError)
    expect(f.calls('getError')).toBe(0)
    const outcome = ctx.checkAllocations()
    expect(outcome).toBeInstanceOf(GlError)
    expect((outcome as InstanceType<typeof GlError>).message).toMatch(
      /^allocation batch of 4 textures and 1 target failed, GL error 0x[0-9a-f]+/,
    )
    // Every allocation of the batch — the three that succeeded included — is released, and the
    // flag is drained: OUT_OF_MEMORY, then NO_ERROR.
    expect(f.calls('deleteTexture')).toBe(4)
    expect(f.calls('deleteFramebuffer')).toBe(1)
    expect(f.calls('getError')).toBe(2)
    for (const t of made.textures) if (!GlError.is(t)) expect(ctx.alive(t)).toBe(false)
    // Reported once: a later check finds a clean flag and releases nothing more.
    expect(ctx.checkAllocations()).toBe(f.gl.NO_ERROR)
    expect(f.calls('deleteTexture')).toBe(4)
    // An allocation's own dispose() after the batch's release is a no-op, not a second delete.
    for (const t of made.textures) if (!GlError.is(t)) t.dispose()
    if (!GlError.is(made.target)) made.target.dispose()
    expect(f.calls('deleteTexture')).toBe(4)
    expect(f.calls('deleteFramebuffer')).toBe(1)
  })

  it('reads every flag: an OUT_OF_MEMORY queued behind another flag still fails the batch', () => {
    const f = fakeGl()
    const ctx = createGlContext(f.gl)
    f.reset()
    const t = ctx.allocations(() => ctx.texture(desc))
    // A draw into the unbacked target raised its own flag ahead of the storage failure.
    f.answers.errors.push('INVALID_OPERATION', 'OUT_OF_MEMORY')
    expect(ctx.checkAllocations()).toBeInstanceOf(GlError)
    expect(f.calls('getError')).toBe(3)
    expect(f.calls('deleteTexture')).toBe(1)
    if (!GlError.is(t)) expect(ctx.alive(t)).toBe(false)
  })

  it('a flag no allocation can raise does not fail the batch: checkAllocations() returns it and keeps every allocation', () => {
    const f = fakeGl()
    const ctx = createGlContext(f.gl)
    f.reset()
    const t = ctx.allocations(() => ctx.texture(desc))
    f.answers.errors.push('INVALID_OPERATION')
    expect(ctx.checkAllocations()).toBe(f.gl.INVALID_OPERATION)
    expect(f.calls('deleteTexture')).toBe(0)
    if (!GlError.is(t)) expect(ctx.alive(t)).toBe(true)
    // INVALID_FRAMEBUFFER_OPERATION is an allocation's own: a target of the batch is incomplete.
    const u = ctx.allocations(() => ctx.texture({ ...desc, label: 'u' }))
    f.answers.errors.push('INVALID_FRAMEBUFFER_OPERATION')
    expect(ctx.checkAllocations()).toBeInstanceOf(GlError)
    expect(f.calls('deleteTexture')).toBe(1)
    if (!GlError.is(u)) expect(ctx.alive(u)).toBe(false)
    if (!GlError.is(t)) expect(ctx.alive(t)).toBe(true)
  })

  it('an allocation outside any batch settles what is unchecked: a clean read proves it, a fatal one releases it and is reported at the next check', () => {
    const f = fakeGl()
    const ctx = createGlContext(f.gl)
    f.reset()
    const a = ctx.allocations(() => ctx.texture({ ...desc, label: 'a' }))
    // Clean: the unbatched allocation's own read proves `a` too — no second read.
    const b = ctx.texture({ ...desc, label: 'b' })
    expect(b).not.toBeInstanceOf(GlError)
    expect(f.calls('getError')).toBe(1)
    expect(ctx.checkAllocations()).toBe(f.gl.NO_ERROR)
    expect(f.calls('deleteTexture')).toBe(0)
    // Fatal: `c` is unchecked when `d`'s own read finds OUT_OF_MEMORY. `d` fails on the call,
    // `c` is released with it, and the batch's owner learns at its own check — the flag is never
    // read and discarded between two readers.
    const c = ctx.allocations(() => ctx.texture({ ...desc, label: 'c' }))
    f.answers.error = 'OUT_OF_MEMORY'
    const d = ctx.texture({ ...desc, label: 'd' })
    expect(d).toBeInstanceOf(GlError)
    expect(f.calls('deleteTexture')).toBe(2)
    if (!GlError.is(c)) expect(ctx.alive(c)).toBe(false)
    expect(ctx.checkAllocations()).toBeInstanceOf(GlError)
    expect(ctx.checkAllocations()).toBe(f.gl.NO_ERROR)
    if (!GlError.is(a)) expect(ctx.alive(a)).toBe(true)
  })

  it('a batch inside a batch joins it: one read for both', () => {
    const f = fakeGl()
    const ctx = createGlContext(f.gl)
    f.reset()
    const made = ctx.allocations(() => {
      const outer = ctx.texture({ ...desc, label: 'outer' })
      const inner = ctx.allocations(() => ctx.texture({ ...desc, label: 'inner' }))
      // The inner batch's exit reads nothing: the outer owner's check covers it.
      const after = ctx.texture({ ...desc, label: 'after' })
      return [outer, inner, after]
    })
    expect(f.calls('getError')).toBe(0)
    expect(ctx.checkAllocations()).toBe(f.gl.NO_ERROR)
    expect(f.calls('getError')).toBe(1)
    for (const t of made) expect(t).not.toBeInstanceOf(GlError)
  })

  it('target() inside a batch asks for no completeness status, and proves nothing for later targets', () => {
    const f = fakeGl()
    const ctx = createGlContext(f.gl)
    const t = ctx.texture(desc)
    if (GlError.is(t)) return
    f.reset()
    const target = ctx.allocations(() => ctx.target(t))
    expect(target).not.toBeInstanceOf(GlError)
    expect(f.calls('checkFramebufferStatus')).toBe(0)
    expect(ctx.checkAllocations()).toBe(f.gl.NO_ERROR)
    // An incomplete target in a batch is caught by the draws into it
    // (INVALID_FRAMEBUFFER_OPERATION), not by a status query, so a clean batch is no proof of
    // the combination: the first unbatched target of it still asks.
    expect(ctx.target(t)).not.toBeInstanceOf(GlError)
    expect(f.calls('checkFramebufferStatus')).toBe(1)
  })

  it('alive(): true for a texture this context holds, false once anyone released it', () => {
    const f = fakeGl()
    const ctx = createGlContext(f.gl)
    const t = ctx.texture(desc)
    if (GlError.is(t)) return
    expect(ctx.alive(t)).toBe(true)
    t.dispose()
    expect(ctx.alive(t)).toBe(false)
    const u = ctx.texture(desc)
    if (GlError.is(u)) return
    ctx.dispose()
    expect(ctx.alive(u)).toBe(false)
  })

  it('a failure another reader found releases what the next batch allocated too: the owner is told once, and nothing of its batch survives the failed settle', () => {
    const f = fakeGl()
    const ctx = createGlContext(f.gl)
    f.reset()
    const a = ctx.allocations(() => ctx.texture({ ...desc, label: 'a' }))
    // An unbatched allocation's own read finds the fatal flag: `a` goes, the failure is kept.
    f.answers.error = 'OUT_OF_MEMORY'
    expect(ctx.texture({ ...desc, label: 'b' })).toBeInstanceOf(GlError)
    expect(f.calls('deleteTexture')).toBe(2)
    // A new batch before the owner's check — `build()`'s front, say — settles into that kept
    // failure: the contract that a failed settle releases every unchecked allocation holds here
    // too, or the caller returns the error and the front outlives it, owned by nobody.
    const front = ctx.allocations(() => ctx.texture({ ...desc, label: 'front' }))
    expect(front).not.toBeInstanceOf(GlError)
    expect(ctx.checkAllocations()).toBeInstanceOf(GlError)
    if (!GlError.is(front)) expect(ctx.alive(front)).toBe(false)
    expect(f.calls('deleteTexture')).toBe(3)
    expect(ctx.checkAllocations()).toBe(f.gl.NO_ERROR)
    if (!GlError.is(a)) expect(ctx.alive(a)).toBe(false)
  })
})
