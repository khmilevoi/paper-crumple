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
 */
import { GlError } from './errors.js'
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
import { captureGlState, pinAmbientState, restoreGlState } from './gl-state.js'
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

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
  label: string,
): Err | WebGLShader {
  const stage = type === gl.VERTEX_SHADER ? 'vertex' : 'fragment'
  const shader: WebGLShader | null = gl.createShader(type)
  if (shader === null) return new GlError(`${label}: createShader returned null`)
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS) !== true) {
    const log = gl.getShaderInfoLog(shader) ?? '(no info log)'
    gl.deleteShader(shader)
    return new GlError(`${label}: ${stage} shader did not compile: ${log}`)
  }
  return shader
}

/** One of the two boundaries `eslint.boundaries.js` names, wrapped so it returns instead. */
function compile(gl: WebGL2RenderingContext, vs: string, fs: string, label: string): Err | Program {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, vs, label)
  if (GlError.is(vertex)) return vertex
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fs, label)
  if (GlError.is(fragment)) {
    gl.deleteShader(vertex)
    return fragment
  }

  const handle: WebGLProgram | null = gl.createProgram()
  if (handle === null) {
    gl.deleteShader(vertex)
    gl.deleteShader(fragment)
    return new GlError(`${label}: createProgram returned null`)
  }

  gl.attachShader(handle, vertex)
  gl.attachShader(handle, fragment)
  gl.linkProgram(handle)
  gl.deleteShader(vertex)
  gl.deleteShader(fragment)

  if (gl.getProgramParameter(handle, gl.LINK_STATUS) !== true) {
    const log = gl.getProgramInfoLog(handle) ?? '(no info log)'
    gl.deleteProgram(handle)
    return new GlError(`${label}: program did not link: ${log}`)
  }

  const locations = new Map<string, WebGLUniformLocation | null>()
  return {
    handle,
    label,
    uniformLocation(name) {
      if (!locations.has(name)) locations.set(name, gl.getUniformLocation(handle, name))
      return locations.get(name) ?? null
    },
    dispose() {
      gl.deleteProgram(handle)
    },
  }
}

/** The other named boundary. Returns rather than throwing on an incomplete framebuffer. */
function createTarget(
  gl: WebGL2RenderingContext,
  texture: Texture,
  floatRT: boolean,
): Err | Target {
  if (FLOAT_FORMATS.has(texture.format) && !floatRT) {
    return new GlError(
      `${texture.label}: rendering into ${texture.format} needs caps.floatRT, which this ` +
        `driver does not grant (EXT_color_buffer_float is absent)`,
    )
  }
  const framebuffer: WebGLFramebuffer | null = gl.createFramebuffer()
  if (framebuffer === null) return new GlError(`${texture.label}: createFramebuffer returned null`)

  const saved = captureGlState(gl)
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, framebuffer)
  gl.framebufferTexture2D(
    gl.DRAW_FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D,
    texture.handle,
    0,
  )
  const status = gl.checkFramebufferStatus(gl.DRAW_FRAMEBUFFER)
  restoreGlState(gl, saved)

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
 */
export function createGlContext(gl: WebGL2RenderingContext): CoreGlContext {
  pinAmbientState(gl)

  const caps: GlCaps = Object.freeze({
    floatRT: gl.getExtension('EXT_color_buffer_float') !== null,
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    timer: gl.getExtension('EXT_disjoint_timer_query_webgl2') !== null,
  })

  const exactByteFetch = probeExactByteFetch(gl)

  const owned = new Set<() => void>()
  let disposed = false

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
      const program = compile(gl, vs, fs, label)
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
      const saved = captureGlState(gl)
      gl.bindTexture(gl.TEXTURE_2D, handle)
      // Immutable storage, one level, no mipmaps (§8.7).
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl[names.internalFormat], d.width, d.height)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl[filter])
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl[filter])
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl[wrap])
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl[wrap])
      const error = gl.getError()
      restoreGlState(gl, saved)

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
      const target = createTarget(gl, t, caps.floatRT)
      if (GlError.is(target)) return target
      return { ...target, dispose: tracked(() => target.dispose()) }
    },

    scope<T>(fn: (s: DrawScope) => T): T {
      const saved = captureGlState(gl)
      try {
        return fn(drawScope)
      } finally {
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
