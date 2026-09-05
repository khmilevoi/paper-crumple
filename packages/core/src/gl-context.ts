/**
 * The concrete `GlContext` (§5.1, §7.3).
 *
 * **It does not own a surface.** `createGlContext` takes a context that already exists; the
 * canvas, `present`, `resize` and §4.0.2's attribute grading are P9's. What this module owns is
 * the bag those attributes are asked for with, and everything downstream of the context object.
 *
 * `compile` and `createTarget` are the two boundaries `eslint.boundaries.js` names. They are
 * module-private here and they never throw: they wrap the GL calls that can fail and return a
 * `GlError` (§10.8), which is why this file is not in `boundaryFiles`.
 *
 * **The link is deferred where the driver allows it (P7, §5.2 amendment).** With
 * `KHR_parallel_shader_compile` present, `compile` issues the compile and the link and returns a
 * `Program` without reading `LINK_STATUS` — that read is where ANGLE's D3D11 backend blocked the
 * main thread for the whole HLSL compile (42–48 s cold for the paper shader before P7, seconds
 * after) — and the outcome is delivered by `Program.ready()`, which polls `COMPLETION_STATUS_KHR`
 * once per `nextTurn()` and only then reads `LINK_STATUS`. That poll backs off after eight fast
 * turns (S11: a cold `PAPER_FS` link is ~3 s, which was ~200 000 undelayed turns of a spinning core (206 448 measured on a 1.3 s link)
 * core) and gives up on a driver that never answers — see `LINK_FAST_POLLS` below. Without the
 * extension both shaders are compiled and the program linked, then the three statuses are read
 * before `program()` returns, and `ready()` resolves at once.
 */
import { GlError } from './errors.js'
import { nextTurn } from './next-turn.js'
import {
  FLOAT_FORMATS,
  INTEGER_FORMATS,
  TEXTURE_FORMAT_GL,
  textureBytes,
  type Program,
  type Target,
  type Texture,
  type TextureDesc,
} from './gl-resources.js'
import { probeExactByteFetch } from './gl-probe.js'
import { captureGlState, pinAmbientState, restoreGlState, type GlState } from './gl-state.js'
import type { DrawScope, DrawTarget, GlCaps, GlContext } from './gl.js'

/**
 * §7.3's required attributes, with the `powerPreference` the original omitted and the spike
 * passes. `preserveDrawingBuffer: true` and `depth: true` together are why §7.3 forbids clearing
 * the default framebuffer and why `DrawScope` has no `clear()`.
 */
export const GL_ATTRIBUTES: Readonly<WebGLContextAttributes> = Object.freeze({
  alpha: true,
  antialias: false,
  depth: true,
  stencil: false,
  premultipliedAlpha: false,
  preserveDrawingBuffer: true,
  powerPreference: 'high-performance',
} as const)

/**
 * The stage's handle on the context. A slot receives the `GlContext` half and therefore cannot
 * `dispose()` — the surface and its lifetime are P9's (§4.0).
 */
export interface CoreGlContext extends GlContext {
  /** Release every program, texture and target this context created. Idempotent. */
  dispose(): void
}

/** How `createGlContext` is to treat the context it is handed. */
export interface GlContextOptions {
  /**
   * The stage created this context on a canvas of its own and nothing but the library writes to
   * it (§4.0). After `pinAmbientState` (§7.4.1) every library write happens inside a `scope()`
   * that restores at exit — or is an allocation that puts back the one binding it moved — so
   * the state at every outermost scope entry is one known constant: the pinned baseline. It is
   * captured once here and every restore writes it back; no scope pays a query.
   *
   * **Both owned presentation modes set it**, `present: 'direct'` included: a direct canvas is
   * handed to the consumer to append, place and style, but the stage owns the context on it just
   * as it owns the offscreen one under `'blit'`. The consumer must therefore never call
   * `getContext` on that element — a second context handle, or any state written through one,
   * is exactly what the baseline restore assumes cannot exist (`stage-surface.ts`).
   *
   * Default `false`: an injected context (§7.3) may carry any state between two library calls,
   * so every outermost scope captures for real, as it always has. A write through the `gl`
   * escape hatch outside any scope is honoured on an injected context and undone at the next
   * scope exit on an owned one, where there is no consumer whose state it could be.
   */
  readonly owned?: boolean
}

type Err = InstanceType<typeof GlError>

const DRAW_CAPS = {
  DEPTH_TEST: 'DEPTH_TEST',
  BLEND: 'BLEND',
  CULL_FACE: 'CULL_FACE',
  SCISSOR_TEST: 'SCISSOR_TEST',
} as const

function isPositiveInteger(n: number): boolean {
  return Number.isInteger(n) && n > 0
}

/** `KHR_parallel_shader_compile`: the one enum the deferred link polls. */
interface ParallelCompile {
  readonly COMPLETION_STATUS_KHR: number
}

/**
 * How many turns `Program.ready()` polls `COMPLETION_STATUS_KHR` at full speed before it backs
 * off (§5.2's amendment; the readback's own back-off is §8.10's, `sheet.ts`).
 *
 * A poll costs one platform turn, and a turn is tens of microseconds on an otherwise idle
 * thread, so polling a whole link undelayed spins one core for its entire length. That length is
 * the point: the cold link of `PAPER_FS` on an Intel Iris Xe (ANGLE/D3D11) is ~3 s — 2.9 s
 * median, 2.5 s min on the `gl.compile.paperFs` row — which was roughly 200 000 undelayed turns (206 448 measured on a 1.3 s link)
 * of a core doing nothing but asking a driver whether it is done yet, on the very first load,
 * next to the decode and the first hull the page actually needs.
 *
 * Eight turns of it is not: it is the window in which a link that is already complete, or
 * completes within a few turns of the issue (every driver without a real compile to do, and
 * every warm shader cache), is answered with zero added latency — the common case, and the one
 * the back-off must not tax. Past it every poll takes `LINK_SLOW_DELAY_MS` instead.
 */
const LINK_FAST_POLLS = 8

/**
 * The back-off turn's delay in milliseconds past the fast phase (§5.2's amendment). One
 * millisecond is the smallest delay worth asking for and the browser's own timer clamp is the
 * real floor (~4 ms once timers nest past the fifth) — so a link is noticed about a clamp after
 * it completes rather than within a turn, a few milliseconds on a wait that is seconds long.
 * `nextTurn`'s header carries the measurement and the reason the route is `setTimeout`.
 */
const LINK_SLOW_DELAY_MS = 1

/**
 * How long `ready()` polls, in wall-clock milliseconds, before it gives the link up (§5.2's
 * amendment). A safety net against a driver that never reports completion while the context
 * still says it is not lost — not a budget: every link that can complete is far inside it.
 *
 * Sized from P7's measurements on the slowest GPU this project has numbers for (Intel Iris Xe,
 * ANGLE/D3D11, `report-P7.md`): the shipping `PAPER_FS` links cold in 3.6 s, and the whole
 * pre-diet program — the worst link that has ever actually completed here — took 51.9 s. Sixty
 * seconds clears the first by more than an order of magnitude and still clears the second, so no
 * link a driver is genuinely working on is abandoned; a driver still saying "compiling" after a
 * minute has hung, and an error the caller can act on beats a poll that never ends.
 *
 * Wall-clock and not a turn count because the turn is no longer a fixed cost: the fast phase's
 * turns are microseconds and the back-off's are milliseconds, so one count would mean two
 * different waits.
 */
const LINK_WAIT_MAX_MS = 60_000

/**
 * A second, absolute exit for the same loop: a clock that stands still (a frozen or replaced
 * `performance.now`) must not turn the wall-clock bound into an endless loop. At one delayed
 * turn per ~4 ms this is over an hour — far beyond `LINK_WAIT_MAX_MS`, and never the first
 * bound to fire.
 */
const LINK_TURN_MAX = 1_000_000

/** A shader object with its source set and its compile issued — its status is not read here. */
function createShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
  label: string,
): Err | WebGLShader {
  const shader: WebGLShader | null = gl.createShader(type)
  if (shader === null) return new GlError(`${label}: createShader returned null`)
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  return shader
}

/**
 * The outcome of a link whose work is done: the first failure in compile order, worded as the
 * synchronous path always worded it, or `undefined`. `COMPILE_STATUS` and `LINK_STATUS` block
 * until the driver has finished, so this runs either right after `linkProgram` (no extension) or
 * once `COMPLETION_STATUS_KHR` has reported completion (with it).
 */
function linkOutcome(
  gl: WebGL2RenderingContext,
  handle: WebGLProgram,
  vertex: WebGLShader,
  fragment: WebGLShader,
  label: string,
): Err | undefined {
  for (const [stage, shader] of [
    ['vertex', vertex],
    ['fragment', fragment],
  ] as const) {
    if (gl.getShaderParameter(shader, gl.COMPILE_STATUS) !== true) {
      const log = gl.getShaderInfoLog(shader) ?? '(no info log)'
      return new GlError(`${label}: ${stage} shader did not compile: ${log}`)
    }
  }
  if (gl.getProgramParameter(handle, gl.LINK_STATUS) !== true) {
    const log = gl.getProgramInfoLog(handle) ?? '(no info log)'
    return new GlError(`${label}: program did not link: ${log}`)
  }
  return undefined
}

/**
 * One of the two boundaries `eslint.boundaries.js` names, wrapped so it returns instead.
 *
 * With `parallel` the link is deferred (module header): the shaders stay attached and alive
 * until `ready()` has read their status, because a status query needs the object, and the
 * program is not deleted while its link is in flight — ANGLE's `deleteProgram` resolves the link
 * first, which is the very block this exists to avoid — so a `dispose()` during the wait marks
 * the program and the poll deletes it on completion.
 */
function compile(
  gl: WebGL2RenderingContext,
  vs: string,
  fs: string,
  label: string,
  parallel: ParallelCompile | null,
): Err | Program {
  const vertex = createShader(gl, gl.VERTEX_SHADER, vs, label)
  if (GlError.is(vertex)) return vertex
  const fragment = createShader(gl, gl.FRAGMENT_SHADER, fs, label)
  if (GlError.is(fragment)) {
    gl.deleteShader(vertex)
    return fragment
  }

  const created: WebGLProgram | null = gl.createProgram()
  if (created === null) {
    gl.deleteShader(vertex)
    gl.deleteShader(fragment)
    return new GlError(`${label}: createProgram returned null`)
  }
  // Narrowed once here: the closures below would otherwise see `WebGLProgram | null` again.
  const handle: WebGLProgram = created

  gl.attachShader(handle, vertex)
  gl.attachShader(handle, fragment)
  gl.linkProgram(handle)

  /** The shaders are released once, when the outcome has been read. */
  function releaseShaders(): void {
    gl.deleteShader(vertex)
    gl.deleteShader(fragment)
  }

  if (parallel === null) {
    // Without the extension: both shaders are compiled and the program linked above, and only
    // now are the three statuses read, inside `program()` — the synchronous path since P7 (it
    // used to read each shader's status before compiling the next). Same outcome, same wording.
    const failed = linkOutcome(gl, handle, vertex, fragment, label)
    releaseShaders()
    if (failed !== undefined) {
      gl.deleteProgram(handle)
      return failed
    }
  }

  /** True until the deferred outcome has been read; false from the start without the extension. */
  let pending = parallel !== null
  let disposed = false
  let released = false
  let readiness: Promise<Err | undefined> | null = null

  /** The one `deleteProgram`, whether a failed link, a dispose or both ask for it. */
  function release(): void {
    if (released) return
    released = true
    gl.deleteProgram(handle)
  }

  /** The dispose exit, shared by the two ends of the wait: the shaders and the program go. */
  function disposedDuringLink(): Err {
    releaseShaders()
    release()
    return new GlError(`${label}: program disposed before its link completed`)
  }

  function settle(): Err | undefined {
    pending = false
    if (disposed) return disposedDuringLink()
    const failed = linkOutcome(gl, handle, vertex, fragment, label)
    releaseShaders()
    if (failed !== undefined) release()
    return failed
  }

  /**
   * The give-up exit: the driver never reported completion inside `LINK_WAIT_MAX_MS`, so the
   * outcome is the one the synchronous path words for a link that did not come out — with the
   * bound in place of a driver log, because reading `LINK_STATUS` for a real one is exactly the
   * block the deferral exists to avoid, and on a hung driver it would never return. The program
   * is released as a failed link's is, and the shaders with it.
   */
  function abandon(): Err {
    pending = false
    if (disposed) return disposedDuringLink()
    releaseShaders()
    release()
    return new GlError(
      `${label}: program did not link: the driver did not report completion within ${LINK_WAIT_MAX_MS} ms`,
    )
  }

  /**
   * One `COMPLETION_STATUS_KHR` poll per turn, with the same back-off the sheet's fence wait
   * takes (§8.10): the first `LINK_FAST_POLLS` turns are plain `nextTurn()`s, so a link that is
   * already complete costs no turn at all and one that completes within a few costs no added
   * latency; every turn after them is `nextTurn({ delay: LINK_SLOW_DELAY_MS })`, which parks the
   * poll on the platform's timer instead of spinning a core through a link that runs for
   * seconds. Two exits bound a driver that never answers — `LINK_WAIT_MAX_MS` of wall clock and
   * `LINK_TURN_MAX` turns, only ever read in the slow phase, which the fast phase cannot outlast.
   */
  async function awaitLink(): Promise<Err | undefined> {
    // Without the extension nothing is pending and this is never reached; the narrowing is for
    // the loop below.
    if (parallel === null) return settle()
    const deadline = performance.now() + LINK_WAIT_MAX_MS
    for (let turn = 0; ; turn++) {
      // `false` is "still compiling"; `true` is done, and `null` is a lost context, whose
      // LINK_STATUS then reads as a failure — either way the wait ends.
      if (gl.getProgramParameter(handle, parallel.COMPLETION_STATUS_KHR) !== false) return settle()
      const fast = turn < LINK_FAST_POLLS
      await (fast ? nextTurn() : nextTurn({ delay: LINK_SLOW_DELAY_MS }))
      if (!fast && (performance.now() >= deadline || turn >= LINK_TURN_MAX)) return abandon()
    }
  }

  function ready(): Promise<Err | undefined> {
    if (readiness === null) readiness = pending ? awaitLink() : Promise.resolve(undefined)
    return readiness
  }

  const locations = new Map<string, WebGLUniformLocation | null>()
  return {
    handle,
    label,
    uniformLocation(name) {
      if (!locations.has(name)) locations.set(name, gl.getUniformLocation(handle, name))
      return locations.get(name) ?? null
    },
    ready,
    dispose() {
      if (disposed) return
      disposed = true
      if (pending) {
        // Deleted by the poll once the driver is done with it; a wait nobody started yet is
        // started here so that happens.
        void ready()
        return
      }
      release()
    },
  }
}

/** The other named boundary. Returns rather than throwing on an incomplete framebuffer. */
function createTarget(
  gl: WebGL2RenderingContext,
  texture: Texture,
  floatRT: boolean,
  boundDrawFramebuffer: () => WebGLFramebuffer | null,
  checkStatus: boolean,
): Err | Target {
  if (FLOAT_FORMATS.has(texture.format) && !floatRT) {
    return new GlError(
      `${texture.label}: rendering into ${texture.format} needs caps.floatRT, which this ` +
        `driver does not grant (EXT_color_buffer_float is absent)`,
    )
  }
  const framebuffer: WebGLFramebuffer | null = gl.createFramebuffer()
  if (framebuffer === null) return new GlError(`${texture.label}: createFramebuffer returned null`)

  // The only item of §5.1's set this disturbs is the draw framebuffer binding, so that is all it
  // saves — and asks for only when the context cannot already know it.
  const previous = boundDrawFramebuffer()
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, framebuffer)
  gl.framebufferTexture2D(
    gl.DRAW_FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D,
    texture.handle,
    0,
  )
  // Completeness is a property of (format, size, attachment shape), so the caller asks for the
  // round trip only for a combination this context has not proven complete yet.
  const status = checkStatus
    ? gl.checkFramebufferStatus(gl.DRAW_FRAMEBUFFER)
    : (gl.FRAMEBUFFER_COMPLETE as number)
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, previous)

  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    gl.deleteFramebuffer(framebuffer)
    return new GlError(`${texture.label}: framebuffer incomplete, status 0x${status.toString(16)}`)
  }

  return {
    framebuffer,
    texture,
    width: texture.width,
    height: texture.height,
    dispose() {
      gl.deleteFramebuffer(framebuffer)
    },
  }
}

/**
 * Wrap an existing WebGL2 context.
 *
 * The context is pinned (§7.4.1), its capabilities are read once, and §8.5.3's probe runs once —
 * inside a save/restore, so a stage that probes is indistinguishable from one that did not.
 *
 * With `owned: true` the pinned state is then captured once, and that capture is what every
 * outermost `scope()` restores: the contract of §5.1 — every enumerated item equals its value at
 * scope entry — holds without a query, because on a context nothing else writes to, the value at
 * every scope entry *is* that capture. Without it every outermost scope captures for real.
 */
export function createGlContext(
  gl: WebGL2RenderingContext,
  o: GlContextOptions = {},
): CoreGlContext {
  pinAmbientState(gl)

  const caps: GlCaps = Object.freeze({
    floatRT: gl.getExtension('EXT_color_buffer_float') !== null,
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    timer: gl.getExtension('EXT_disjoint_timer_query_webgl2') !== null,
  })

  const exactByteFetch = probeExactByteFetch(gl)

  // The deferred link (module header). Asked for once; a driver that has it keeps it for the
  // context's lifetime.
  const parallel = gl.getExtension('KHR_parallel_shader_compile') as ParallelCompile | null

  /**
   * The state every outermost scope on an owned context restores to. Read after the pins and
   * after the probe, which restores what it found — so this is the pinned state and nothing the
   * probe touched. `null` on an injected context, which has no constant to offer.
   */
  const baseline: GlState | null = o.owned === true ? captureGlState(gl) : null

  const owned = new Set<() => void>()
  let disposed = false
  /** How many `scope()` bodies are live. Only the outermost one saves and restores. */
  let depth = 0

  /**
   * The two bindings an allocation moves, as it must put them back. Outside every scope on an
   * owned context nothing but the library has written since the last restore, so they are the
   * baseline's; inside a scope a slot may have bound anything through the escape hatch, and on
   * an injected context the consumer may have, so the driver is asked. Both are queries Blink
   * answers from its own bookkeeping, not GPU-process round trips.
   */
  function boundTexture2d(): WebGLTexture | null {
    if (baseline !== null && depth === 0) return baseline.texture2d
    return gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null
  }
  function boundDrawFramebuffer(): WebGLFramebuffer | null {
    if (baseline !== null && depth === 0) return baseline.drawFramebuffer
    return gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null
  }

  /**
   * The (format, width, height) combinations this context has attached and found complete, so
   * `checkFramebufferStatus` runs once per combination: completeness is a property of the
   * attachment's format and size, and `texture()` returns an Error on any allocation failure
   * before a target can be built over it. A failure proves nothing and leaves the combination
   * unproven.
   */
  const provenTargets = new Set<string>()
  const combination = (t: Pick<TextureDesc, 'format' | 'width' | 'height'>): string =>
    `${t.format}:${t.width}x${t.height}`

  /**
   * Register one resource's release so `dispose()` can run it, and hand back a `dispose` that
   * runs it at most once.
   *
   * It takes a function rather than the resource, because `{ ...resource, dispose }` over a
   * generic `T` does not type-check as `T` — the override widens it to
   * `Omit<T, 'dispose'> & { dispose: () => void }`. Each construction site below builds its
   * object with this already in place instead.
   */
  function tracked(release: () => void): () => void {
    let released = false
    const run = (): void => {
      if (released) return
      released = true
      owned.delete(run)
      release()
    }
    owned.add(run)
    return run
  }

  const drawScope: DrawScope = {
    bindTarget(t: DrawTarget) {
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, t.framebuffer)
      gl.viewport(t.viewport.x, t.viewport.y, t.viewport.w, t.viewport.h)
      // dest is the view's box inside that viewport. Whether the scissor test is on is the
      // view's call, which is what enable() is for.
      gl.scissor(t.dest.x, t.dest.y, t.dest.w, t.dest.h)
    },
    enable(cap, on) {
      const value = gl[DRAW_CAPS[cap]]
      if (on) gl.enable(value)
      else gl.disable(value)
    },
  }

  return {
    caps,
    exactByteFetch,

    program(vs, fs, label) {
      const program = compile(gl, vs, fs, label, parallel)
      if (GlError.is(program)) return program
      return { ...program, dispose: tracked(() => program.dispose()) }
    },

    texture(d: TextureDesc): Err | Texture {
      const label = d.label ?? d.format
      if (!isPositiveInteger(d.width) || !isPositiveInteger(d.height)) {
        return new GlError(`${label}: texture is ${d.width}x${d.height}`)
      }
      if (d.width > caps.maxTextureSize || d.height > caps.maxTextureSize) {
        return new GlError(
          `${label}: texture is ${d.width}x${d.height}, past this driver's ` +
            `maxTextureSize of ${caps.maxTextureSize}`,
        )
      }
      const integer = INTEGER_FORMATS.has(d.format)
      const filter = d.filter ?? (integer ? 'NEAREST' : 'LINEAR')
      if (integer && filter === 'LINEAR') {
        return new GlError(`${label}: ${d.format} is an integer format and is not filterable`)
      }

      const handle: WebGLTexture | null = gl.createTexture()
      if (handle === null) return new GlError(`${label}: createTexture returned null`)

      const names = TEXTURE_FORMAT_GL[d.format]
      const wrap = d.wrap ?? 'CLAMP_TO_EDGE'
      // The only item of §5.1's set this disturbs is the 2D binding on the active unit, so that
      // is all it saves, and asks for only when the context cannot already know it. A slot that
      // allocates mid-draw keeps the texture it had bound.
      const previous = boundTexture2d()
      gl.bindTexture(gl.TEXTURE_2D, handle)
      // Immutable storage, one level, no mipmaps (§8.7).
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl[names.internalFormat], d.width, d.height)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl[filter])
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl[filter])
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl[wrap])
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl[wrap])
      // One getError per allocation, always. A GL error is sticky only until someone reads it:
      // an OUT_OF_MEMORY left on the flag here would be read and discarded by the next reader —
      // a readback's drain loop, a mesh build — and a texture without storage would pass as a
      // success, with the completeness cache below then vouching for a target over it. The step
      // path allocates nothing, so this round trip costs nothing there.
      const error = gl.getError()
      gl.bindTexture(gl.TEXTURE_2D, previous)

      if (error !== gl.NO_ERROR) {
        gl.deleteTexture(handle)
        return new GlError(
          `${label}: texStorage2D ${d.width}x${d.height} ${d.format} failed, ` +
            `GL error 0x${error.toString(16)}`,
        )
      }

      return {
        handle,
        width: d.width,
        height: d.height,
        format: d.format,
        bytes: textureBytes(d),
        label,
        dispose: tracked(() => gl.deleteTexture(handle)),
      }
    },

    target(t: Texture) {
      const key = combination(t)
      const check = !provenTargets.has(key)
      const target = createTarget(gl, t, caps.floatRT, boundDrawFramebuffer, check)
      if (GlError.is(target)) return target
      provenTargets.add(key)
      return { ...target, dispose: tracked(() => target.dispose()) }
    },

    scope<T>(fn: (s: DrawScope) => T): T {
      // Re-entrant: a scope entered while another is live on this context neither saves nor
      // restores, the way §7.3 says a nested `stage.batch` is a no-op rather than a double save.
      // The outermost scope's restore covers every write a nested one made, because the saved
      // set is the same enumeration at every depth. This is what lets a batch of draws — or a
      // draw whose slot opens a scope of its own inside the stage's — pay one capture, not one
      // per level.
      if (depth > 0) {
        depth += 1
        try {
          return fn(drawScope)
        } finally {
          depth -= 1
        }
      }
      // Owned: the baseline, no query. Injected: the consumer's state, read for real.
      const saved = baseline ?? captureGlState(gl)
      depth = 1
      try {
        return fn(drawScope)
      } finally {
        depth = 0
        restoreGlState(gl, saved)
      }
    },

    get gl() {
      return gl
    },

    dispose() {
      if (disposed) return
      disposed = true
      for (const release of [...owned]) release()
      owned.clear()
      // The context itself is not lost here: the surface is P9's and a stage may be handed one
      // it does not own (§7.3's injected case).
    },
  }
}
