/**
 * A recording stand-in for `WebGL2RenderingContext`: every method call is counted by name and
 * answered with a plausible value, so the real `createGlContext`, `paperSheet` and `bakedMotion`
 * run their whole GL paths under Node. Nothing is rendered; what this measures is the number and
 * kind of GL calls the library issues per operation — the synchronous queries (`getParameter`,
 * `isEnabled`, `getError`, `checkFramebufferStatus`, shader/program status) being the ones that
 * cost a GPU-process round trip in a browser.
 *
 * Plausible answers, and why:
 *   - `getParameter(IMPLEMENTATION_COLOR_READ_FORMAT/TYPE)` -> RED / FLOAT, so `readBackField`
 *     takes its single-channel float branch; `readPixels(..., FLOAT, buf)` is answered by the
 *     `readback(w, h, buf)` hook the caller supplies (a CPU signed field, so a real hull is traced);
 *   - `readPixels(..., RGBA_INTEGER, UNSIGNED_BYTE, buf)` returns the bytes of the last
 *     `texSubImage2D` upload of the same length, which is exactly what `probeExactByteFetch`
 *     checks — so `exactByteFetch` is true and the resampler takes its GPU path rather than the
 *     `OffscreenCanvas` one Node cannot run;
 *   - `getExtension('EXT_color_buffer_float')` is granted (float render targets), the timer
 *     extension is not;
 *   - every status query succeeds: `COMPILE_STATUS`/`LINK_STATUS` true, `FRAMEBUFFER_COMPLETE`,
 *     `getError` NO_ERROR.
 *
 * `captures` counts `getParameter(CURRENT_PROGRAM)`, which only `captureGlState`
 * (`packages/core/src/gl-state.ts`) asks for — one per capture.
 */

/** The WebGL2 enums the packages reference, with their real values. */
export const GL = Object.freeze({
  NO_ERROR: 0,
  NONE: 0,
  ZERO: 0,
  ONE: 1,
  TRIANGLES: 0x0004,
  DEPTH_BUFFER_BIT: 0x0100,
  STENCIL_BUFFER_BIT: 0x0400,
  COLOR_BUFFER_BIT: 0x4000,
  LESS: 0x0201,
  LEQUAL: 0x0203,
  FRONT: 0x0404,
  BACK: 0x0405,
  CULL_FACE: 0x0b44,
  DEPTH_TEST: 0x0b71,
  DEPTH_WRITEMASK: 0x0b72,
  DEPTH_CLEAR_VALUE: 0x0b73,
  DEPTH_FUNC: 0x0b74,
  STENCIL_TEST: 0x0b90,
  STENCIL_WRITEMASK: 0x0b98,
  VIEWPORT: 0x0ba2,
  DITHER: 0x0bd0,
  BLEND: 0x0be2,
  SCISSOR_BOX: 0x0c10,
  SCISSOR_TEST: 0x0c11,
  COLOR_CLEAR_VALUE: 0x0c22,
  UNPACK_ROW_LENGTH: 0x0cf2,
  UNPACK_SKIP_ROWS: 0x0cf3,
  UNPACK_SKIP_PIXELS: 0x0cf4,
  UNPACK_ALIGNMENT: 0x0cf5,
  PACK_ALIGNMENT: 0x0d05,
  MAX_TEXTURE_SIZE: 0x0d33,
  TEXTURE_2D: 0x0de1,
  BYTE: 0x1400,
  UNSIGNED_BYTE: 0x1401,
  SHORT: 0x1402,
  UNSIGNED_SHORT: 0x1403,
  INT: 0x1404,
  UNSIGNED_INT: 0x1405,
  FLOAT: 0x1406,
  HALF_FLOAT: 0x140b,
  COLOR: 0x1800,
  RED: 0x1903,
  RGB: 0x1907,
  RGBA: 0x1908,
  NEAREST: 0x2600,
  LINEAR: 0x2601,
  TEXTURE_MAG_FILTER: 0x2800,
  TEXTURE_MIN_FILTER: 0x2801,
  TEXTURE_WRAP_S: 0x2802,
  TEXTURE_WRAP_T: 0x2803,
  REPEAT: 0x2901,
  TEXTURE_3D: 0x806f,
  TEXTURE_BINDING_3D: 0x806a,
  UNPACK_SKIP_IMAGES: 0x806d,
  UNPACK_IMAGE_HEIGHT: 0x806e,
  TEXTURE_BINDING_2D: 0x8069,
  RGBA8: 0x8058,
  SAMPLE_ALPHA_TO_COVERAGE: 0x809e,
  SAMPLE_COVERAGE: 0x80a0,
  BLEND_DST_RGB: 0x80c8,
  BLEND_SRC_RGB: 0x80c9,
  BLEND_DST_ALPHA: 0x80ca,
  BLEND_SRC_ALPHA: 0x80cb,
  CLAMP_TO_EDGE: 0x812f,
  R8: 0x8229,
  RG: 0x8227,
  RG8: 0x822b,
  R16F: 0x822d,
  R32F: 0x822e,
  RG16F: 0x822f,
  RG32F: 0x8230,
  MIRRORED_REPEAT: 0x8370,
  TEXTURE0: 0x84c0,
  TEXTURE1: 0x84c1,
  ACTIVE_TEXTURE: 0x84e0,
  TEXTURE_CUBE_MAP: 0x8513,
  TEXTURE_BINDING_CUBE_MAP: 0x8514,
  VERTEX_ARRAY_BINDING: 0x85b5,
  RGBA32F: 0x8814,
  RGBA16F: 0x881a,
  QUERY_RESULT: 0x8866,
  QUERY_RESULT_AVAILABLE: 0x8867,
  ARRAY_BUFFER: 0x8892,
  ELEMENT_ARRAY_BUFFER: 0x8893,
  STREAM_READ: 0x88e1,
  STATIC_DRAW: 0x88e4,
  PIXEL_PACK_BUFFER: 0x88eb,
  PIXEL_PACK_BUFFER_BINDING: 0x88ed,
  SAMPLER_BINDING: 0x8919,
  FRAGMENT_SHADER: 0x8b30,
  VERTEX_SHADER: 0x8b31,
  COMPILE_STATUS: 0x8b81,
  LINK_STATUS: 0x8b82,
  CURRENT_PROGRAM: 0x8b8d,
  IMPLEMENTATION_COLOR_READ_TYPE: 0x8b9a,
  IMPLEMENTATION_COLOR_READ_FORMAT: 0x8b9b,
  TEXTURE_2D_ARRAY: 0x8c1a,
  TEXTURE_BINDING_2D_ARRAY: 0x8c1d,
  STENCIL_BACK_WRITEMASK: 0x8ca5,
  DRAW_FRAMEBUFFER_BINDING: 0x8ca6,
  READ_FRAMEBUFFER: 0x8ca8,
  DRAW_FRAMEBUFFER: 0x8ca9,
  READ_FRAMEBUFFER_BINDING: 0x8caa,
  FRAMEBUFFER_COMPLETE: 0x8cd5,
  COLOR_ATTACHMENT0: 0x8ce0,
  FRAMEBUFFER: 0x8d40,
  RGBA8UI: 0x8d7c,
  RED_INTEGER: 0x8d94,
  RGBA_INTEGER: 0x8d99,
  SYNC_GPU_COMMANDS_COMPLETE: 0x9117,
  ALREADY_SIGNALED: 0x911a,
  TIMEOUT_EXPIRED: 0x911b,
  CONDITION_SATISFIED: 0x911c,
  WAIT_FAILED: 0x911d,
  UNPACK_FLIP_Y_WEBGL: 0x9240,
  UNPACK_PREMULTIPLY_ALPHA_WEBGL: 0x9241,
  UNPACK_COLORSPACE_CONVERSION_WEBGL: 0x9243,
  BROWSER_DEFAULT_WEBGL: 0x9244,
})

/** The columns the report tracks, in the order the table prints them. */
export const TRACKED_CALLS = Object.freeze([
  'getParameter',
  'isEnabled',
  'getError',
  'checkFramebufferStatus',
  'getShaderParameter',
  'getProgramParameter',
  'readPixels',
  'bindFramebuffer',
  'useProgram',
  'bindTexture',
  'drawArrays',
  'drawElements',
  'texImage2D',
  'texSubImage2D',
  'texStorage2D',
  'createTexture',
  'createFramebuffer',
])

/** The synchronous queries: the calls a browser answers with a GPU-process round trip. */
export const SYNC_QUERIES = Object.freeze([
  'getParameter',
  'isEnabled',
  'getError',
  'checkFramebufferStatus',
  'getShaderParameter',
  'getProgramParameter',
  'readPixels',
])

export const CONTEXT_ATTRIBUTES = Object.freeze({
  alpha: true,
  antialias: false,
  depth: true,
  stencil: false,
  premultipliedAlpha: false,
  preserveDrawingBuffer: true,
  powerPreference: 'high-performance',
})

/**
 * The two library frames above `captureGlState` on the stack — who captured, and who asked them
 * to — as a short `fn@file:line > fn@file:line` key.
 */
function captureSite(anchor = 'captureGlState') {
  const lines = (new Error().stack ?? '').split('\n')
  const at = lines.findIndex((l) => l.includes(anchor))
  if (at < 0) return '(unknown)'
  const frame = (l) => {
    const m = /at (?:(\S+) )?\(?(?:file:\/\/\/)?(.*?):(\d+):\d+\)?$/.exec(l.trim())
    if (m === null) return l.trim()
    const file = m[2].replace(/\\/g, '/').replace(/^.*\/packages\//, '')
    return `${m[1] ?? '(anon)'}@${file}:${m[3]}`
  }
  return lines
    .slice(at + 1, at + 4)
    .map(frame)
    .join(' > ')
}

/**
 * @param {{
 *   readback?: (w: number, h: number, out: Float32Array) => void,
 *   warnUnknown?: boolean,
 *   traceCaptures?: boolean,
 *   traceAllocations?: boolean,
 * }} o
 */
export function createRecordingGl(o = {}) {
  const counts = new Map()
  const sites = new Map()
  let captures = 0
  let total = 0
  let nextId = 1
  let lastUpload = null
  let lastPack = null
  const uniformLocations = new Map()
  const unknownEnums = new Map()
  const canvas = {
    width: 1,
    height: 1,
    getContext(kind) {
      return kind === 'webgl2' ? gl : null
    },
  }

  const handle = (kind) => ({ kind, id: nextId++ })

  const behaviours = {
    getParameter(pname) {
      switch (pname) {
        case GL.CURRENT_PROGRAM:
          captures += 1
          if (o.traceCaptures === true) {
            const site = captureSite()
            sites.set(site, (sites.get(site) ?? 0) + 1)
          }
          return null
        case GL.MAX_TEXTURE_SIZE:
          return 8192
        case GL.VIEWPORT:
        case GL.SCISSOR_BOX:
          return new Int32Array([0, 0, canvas.width, canvas.height])
        case GL.COLOR_CLEAR_VALUE:
          return new Float32Array(4)
        case GL.ACTIVE_TEXTURE:
          return GL.TEXTURE0
        case GL.IMPLEMENTATION_COLOR_READ_FORMAT:
          return GL.RED
        case GL.IMPLEMENTATION_COLOR_READ_TYPE:
          return GL.FLOAT
        case GL.DEPTH_FUNC:
          return GL.LESS
        case GL.BLEND_SRC_RGB:
        case GL.BLEND_SRC_ALPHA:
          return GL.ONE
        case GL.BLEND_DST_RGB:
        case GL.BLEND_DST_ALPHA:
          return GL.ZERO
        case GL.DEPTH_WRITEMASK:
          return true
        case GL.DEPTH_CLEAR_VALUE:
          return 1
        case GL.UNPACK_ALIGNMENT:
          return 4
        case GL.UNPACK_COLORSPACE_CONVERSION_WEBGL:
          return GL.BROWSER_DEFAULT_WEBGL
        case GL.STENCIL_WRITEMASK:
        case GL.STENCIL_BACK_WRITEMASK:
          return 0xffffffff
        case GL.UNPACK_FLIP_Y_WEBGL:
        case GL.UNPACK_PREMULTIPLY_ALPHA_WEBGL:
          return false
        default:
          return 0
      }
    },
    isEnabled: () => false,
    getError: () => GL.NO_ERROR,
    checkFramebufferStatus: () => GL.FRAMEBUFFER_COMPLETE,
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getShaderInfoLog: () => '',
    getProgramInfoLog: () => '',
    getAttribLocation: () => 0,
    getUniformLocation(program, name) {
      const key = `${program.id}:${name}`
      let loc = uniformLocations.get(key)
      if (loc === undefined) {
        loc = { program: program.id, name }
        uniformLocations.set(key, loc)
      }
      return loc
    },
    getExtension: (name) => (name === 'EXT_color_buffer_float' ? {} : null),
    getSupportedExtensions: () => ['EXT_color_buffer_float'],
    getContextAttributes: () => ({ ...CONTEXT_ATTRIBUTES }),
    isContextLost: () => false,
    createShader: () => handle('shader'),
    createProgram: () => handle('program'),
    createTexture: () => handle('texture'),
    createFramebuffer: () => handle('framebuffer'),
    createRenderbuffer: () => handle('renderbuffer'),
    createBuffer: () => handle('buffer'),
    createVertexArray: () => handle('vao'),
    createSampler: () => handle('sampler'),
    createQuery: () => handle('query'),
    fenceSync: () => handle('sync'),
    clientWaitSync: () => GL.ALREADY_SIGNALED,
    texStorage2D(target, levels, internalFormat, width, height) {
      if (o.traceAllocations === true) {
        const name = Object.keys(GL).find((k) => GL[k] === internalFormat) ?? String(internalFormat)
        const site = captureSite('Object.texture').split(' > ').slice(0, 2).join(' > ')
        process.stderr.write(`  texStorage2D ${name} ${width}x${height}  via ${site}\n`)
      }
    },
    texSubImage2D(...args) {
      const last = args[args.length - 1]
      if (ArrayBuffer.isView(last)) lastUpload = last
    },
    texImage2D(...args) {
      const last = args[args.length - 1]
      if (ArrayBuffer.isView(last)) lastUpload = last
    },
    getBufferSubData(target, offset, out) {
      // The pack-buffer half of a §8.10 readback: the field the last `readPixels` at an offset
      // asked for, now copied out.
      if (lastPack !== null && o.readback !== undefined && out instanceof Float32Array) {
        o.readback(lastPack.w, lastPack.h, out)
        lastPack = null
      }
    },
    readPixels(x, y, w, h, format, type, out) {
      if (typeof out === 'number') {
        // A `PIXEL_PACK_BUFFER` readback (§8.10): the bytes are answered by `getBufferSubData`.
        lastPack = type === GL.FLOAT ? { w, h } : null
        return
      }
      if (type === GL.FLOAT && o.readback !== undefined && out instanceof Float32Array) {
        o.readback(w, h, out)
        return
      }
      if (
        format === GL.RGBA_INTEGER &&
        type === GL.UNSIGNED_BYTE &&
        lastUpload !== null &&
        ArrayBuffer.isView(out) &&
        lastUpload.byteLength === out.byteLength
      ) {
        new Uint8Array(out.buffer, out.byteOffset, out.byteLength).set(
          new Uint8Array(lastUpload.buffer, lastUpload.byteOffset, lastUpload.byteLength),
        )
      }
    },
  }

  const methods = new Map()
  function methodFor(name) {
    let fn = methods.get(name)
    if (fn === undefined) {
      const behaviour = behaviours[name]
      fn =
        behaviour === undefined
          ? () => {
              counts.set(name, (counts.get(name) ?? 0) + 1)
              total += 1
              return undefined
            }
          : (...args) => {
              counts.set(name, (counts.get(name) ?? 0) + 1)
              total += 1
              return behaviour(...args)
            }
      methods.set(name, fn)
    }
    return fn
  }

  const gl = new Proxy(
    {},
    {
      get(_, prop) {
        if (typeof prop !== 'string') return undefined
        if (prop === 'canvas') return canvas
        if (prop === 'drawingBufferWidth') return canvas.width
        if (prop === 'drawingBufferHeight') return canvas.height
        if (Object.hasOwn(GL, prop)) return GL[prop]
        if (/^[A-Z][A-Z0-9_]*$/.test(prop)) {
          // An enum this table does not know: hand out a distinct synthetic value and say so once.
          let v = unknownEnums.get(prop)
          if (v === undefined) {
            v = 0x70000 + unknownEnums.size
            unknownEnums.set(prop, v)
            if (o.warnUnknown !== false)
              process.stderr.write(`recording-gl: unknown enum ${prop}\n`)
          }
          return v
        }
        return methodFor(prop)
      },
      has(_, prop) {
        return typeof prop === 'string'
      },
    },
  )

  return {
    gl,
    canvas,
    reset() {
      counts.clear()
      sites.clear()
      captures = 0
      total = 0
    },
    /** A plain object of every count seen since the last reset, plus `captures` and `total`. */
    snapshot() {
      const out = { total, captures }
      if (o.traceCaptures === true) {
        out.sites = [...sites.entries()].sort((a, b) => b[1] - a[1])
      }
      for (const name of TRACKED_CALLS) out[name] = counts.get(name) ?? 0
      let sync = 0
      for (const name of SYNC_QUERIES) sync += counts.get(name) ?? 0
      out.syncQueries = sync
      out.other = Object.fromEntries(
        [...counts.entries()].filter(([k]) => !TRACKED_CALLS.includes(k)).sort(),
      )
      return out
    },
  }
}
