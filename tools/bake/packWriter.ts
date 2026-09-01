/**
 * A JS twin of `tools/bake/pack.py`'s writer (spec 9.2, 11, 13).
 *
 * It lives here and not in `@paper-crumple/motion` on purpose: a writer is not runtime code and
 * would be dead bytes in every consumer's bundle. It re-implements nothing it can import — the
 * constants, `align4` and `frameLayout` come from the package's own `format.ts`, and the two
 * codecs from `half.ts` and `oct.ts` — so the reader and both writers derive every offset from
 * the same three functions.
 *
 * Errore convention: this returns `Error | WrittenPack` and never throws. The single failure is
 * a non-finite normal component, which `encodeOct` reports as a `PackError`; that value is
 * propagated unchanged rather than re-wrapped, because `PackError` cannot be named as a type
 * from `tools/` — `@paper-crumple/core` is not resolvable outside the workspace.
 */
import {
  HEADER_BYTES,
  MAGIC,
  VERSION,
  align4,
  frameLayout,
} from '../../packages/motion/src/format.js'
import { toHalf } from '../../packages/motion/src/half.js'
import { encodeOct } from '../../packages/motion/src/oct.js'

/** `round(v, 5)`, spelled the way `pack.py` spells it. */
const round5 = (v: number): number => Math.round(v * 1e5) / 1e5

/** One stored frame, in the shape `pack.py`'s `build_pack` takes. */
export interface FrameSpec {
  /** The **simulation** frame number, not a stored slot (spec 9.1). */
  readonly index: number
  /** `3 * vertexCount` components, row-major. */
  readonly positions: ArrayLike<number>
  /** `3 * vertexCount` components; each triple must be a unit vector. */
  readonly normals: ArrayLike<number>
  /** `vertexCount` values in [0, 1]; 1 is open. */
  readonly ao: ArrayLike<number>
}

/** Everything one pack is written from. */
export interface PackSpec {
  readonly vertsPerSide: number
  readonly frames: readonly FrameSpec[]
  /** Simulation frame numbers, copied into the manifest untouched. */
  readonly keyFrames: readonly number[]
  /** Toward the light, in sheet space; normalised into the manifest. */
  readonly light: readonly [number, number, number]
  readonly bucket: string
  readonly aspect: number
  /** Provenance. `stage1End` drives the compaction ramp when present. */
  readonly sim: Readonly<Record<string, unknown>>
}

/** The `.bin` and the manifest, ready to be compared or parsed. */
export interface WrittenPack {
  readonly bin: ArrayBuffer
  readonly manifest: Record<string, unknown>
}

/** `(u, v)` per vertex, row-major, row 0 at y minimum. Column advances first. */
export function gridUvs(quads: number): Float32Array {
  const out = new Float32Array(2 * (quads + 1) * (quads + 1))
  let i = 0
  for (let y = 0; y <= quads; y++) {
    for (let x = 0; x <= quads; x++) {
      out[i++] = x / quads
      out[i++] = y / quads
    }
  }
  return out
}

/** Two CCW triangles per quad: `(a, b, c)` `(a, c, d)`, `a = row * (quads + 1) + col`. */
export function gridIndices(quads: number): Uint16Array {
  const s = quads + 1
  const out = new Uint16Array(6 * quads * quads)
  let i = 0
  for (let y = 0; y < quads; y++) {
    for (let x = 0; x < quads; x++) {
      const a = y * s + x
      out[i++] = a
      out[i++] = a + 1
      out[i++] = a + s + 1
      out[i++] = a
      out[i++] = a + s + 1
      out[i++] = a + s
    }
  }
  return out
}

/** Axis-aligned bounds of one frame, rounded like `pack.py`'s `bbox`. */
function bbox(positions: ArrayLike<number>): number[] {
  const lo = [Infinity, Infinity, Infinity]
  const hi = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < positions.length; i += 3) {
    for (let c = 0; c < 3; c++) {
      lo[c] = Math.min(lo[c]!, positions[i + c]!)
      hi[c] = Math.max(hi[c]!, positions[i + c]!)
    }
  }
  return [...lo, ...hi].map(round5)
}

/** 0 through stage 1, smoothstep to 1 at the last stored frame: the compaction ramp (spec 9.1). */
function alphaFloor(frame: number, stage1End: number, last: number): number {
  if (last <= stage1End) return frame < last ? 0 : 1
  const t = Math.max(0, Math.min(1, (frame - stage1End) / (last - stage1End)))
  return Math.round(t * t * (3 - 2 * t) * 1e4) / 1e4
}

/**
 * The whole pack: the `.bin` as an `ArrayBuffer` and the manifest as a plain object, both
 * byte-for-byte comparable with what `pack.py` writes — the manifest after `JSON.parse`, since
 * Python renders a float as `1.0` where `JSON.stringify` renders it as `1`.
 */
export function writePack(spec: PackSpec): Error | WrittenPack {
  const { vertsPerSide, frames, keyFrames, light, bucket, aspect, sim } = spec
  const n = vertsPerSide * vertsPerSide
  const quads = vertsPerSide - 1
  const uvs = gridUvs(quads)
  const indices = gridIndices(quads)
  const uvOffset = HEADER_BYTES
  const indexOffset = align4(uvOffset + 8 * n)
  const frameBase = align4(indexOffset + 2 * indices.length)
  const layout = frameLayout(n)
  const bin = new ArrayBuffer(frameBase + frames.length * layout.bytes)
  const view = new DataView(bin)
  for (let i = 0; i < 4; i++) view.setUint8(i, MAGIC.charCodeAt(i))
  view.setUint32(4, VERSION, true)
  view.setUint32(8, n, true)
  view.setUint32(12, indices.length, true)
  view.setUint32(16, frames.length, true)
  view.setUint32(20, uvOffset, true)
  view.setUint32(24, indexOffset, true)
  view.setUint32(28, frameBase, true)
  new Float32Array(bin, uvOffset, 2 * n).set(uvs)
  new Uint16Array(bin, indexOffset, indices.length).set(indices)

  const offsets: number[] = []
  for (let f = 0; f < frames.length; f++) {
    const frame = frames[f]!
    const base = frameBase + f * layout.bytes
    offsets.push(base)
    const positions = new Uint16Array(bin, base + layout.positions, 3 * n)
    for (let i = 0; i < 3 * n; i++) positions[i] = toHalf(frame.positions[i]!)
    const normals = new Int8Array(bin, base + layout.normals, 2 * n)
    for (let i = 0; i < n; i++) {
      const oct = encodeOct([
        frame.normals[3 * i]!,
        frame.normals[3 * i + 1]!,
        frame.normals[3 * i + 2]!,
      ])
      if (oct instanceof Error) return oct
      normals[2 * i] = oct[0]
      normals[2 * i + 1] = oct[1]
    }
    const ao = new Uint8Array(bin, base + layout.ao, n)
    for (let i = 0; i < n; i++)
      ao[i] = Math.max(0, Math.min(255, Math.floor(frame.ao[i]! * 255 + 0.5)))
  }

  const stored = frames.map((frame) => frame.index)
  const last = stored[stored.length - 1]!
  const stage1End = typeof sim.stage1End === 'number' ? sim.stage1End : 0
  // math.sqrt(sum(c*c)) is what pack.py computes; Math.hypot is a different algorithm and may
  // differ in the last bit before rounding.
  const l = Math.sqrt(light[0] * light[0] + light[1] * light[1] + light[2] * light[2])
  const manifest: Record<string, unknown> = {
    version: VERSION,
    bucket,
    aspect: round5(aspect),
    vertsPerSide,
    vertexCount: n,
    indexCount: indices.length,
    bin: `${bucket}.bin`,
    binBytes: bin.byteLength,
    frameBytes: layout.bytes,
    frames: frames.map((frame, f) => ({
      index: frame.index,
      offset: offsets[f]!,
      alphaFloor: alphaFloor(frame.index, stage1End, last),
      bbox: bbox(frame.positions),
    })),
    keyFrames: [...keyFrames],
    light: light.map((c) => round5(c / l)),
    sim,
  }
  return { bin, manifest }
}
