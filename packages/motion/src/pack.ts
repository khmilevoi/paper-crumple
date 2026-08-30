/**
 * The CRMP v1 parser (spec 9). Manifest plus binary in, typed views out; nothing here throws and
 * nothing here fetches.
 *
 * The parser **re-derives every offset** from the counts and refuses a header that disagrees, so
 * a writer that miscomputed one is caught at the door rather than four frames into a draw. The
 * cross-field checks are hand-rolled because a schema library validates field *types* — the cheap
 * half — and can express none of them, and because hand-rolling is what keeps the zero-dependency
 * promise (spec 9.2).
 *
 * Frame blocks are handed to the GPU as-is (`frameBytes`): positions are HALF_FLOAT attributes,
 * normals normalised BYTE, AO normalised UNSIGNED_BYTE, so no CPU decode happens on a pose swap.
 * `decodeFrame` exists for tests and for any CPU-side geometry check.
 */
import { PackError } from '@paper-crumple/core'

import type { FrameLayout } from './format.js'
import {
  HEADER_BYTES,
  MAGIC,
  MAX_VERTS_PER_SIDE,
  VERSION,
  frameLayout,
  packOffsets,
} from './format.js'
import { fromHalf } from './half.js'
import { decodeOct } from './oct.js'

/** One entry of the manifest's `frames[]`. Unknown keys are tolerated and preserved. */
export interface PackManifestFrame {
  readonly index: number
  readonly offset: number
  readonly alphaFloor: number
  readonly bbox: readonly number[]
  readonly [key: string]: unknown
}

/**
 * The JSON sibling of a `.bin`. The index signature is deliberate: `parsePack` must tolerate
 * unknown keys so `sim` — and anything a later revision adds — stays forward-compatible.
 */
export interface PackManifest {
  readonly version: number
  readonly bucket: string
  readonly aspect: number
  readonly vertsPerSide: number
  readonly vertexCount: number
  readonly indexCount: number
  /** Provenance only. **Never used to resolve a URL** — `loadPack` takes an explicit `binUrl`. */
  readonly bin: string
  readonly binBytes: number
  readonly frameBytes: number
  readonly frames: readonly PackManifestFrame[]
  /** **Simulation** frame indices, resolved to stored slots by `parsePack`. */
  readonly keyFrames: readonly number[]
  readonly light: readonly number[]
  readonly [key: string]: unknown
}

/** One stored frame, located inside the binary. */
export interface PackFrame {
  /** The **simulation** index, as the manifest stores it. Not a slot. */
  readonly index: number
  readonly alphaFloor: number
  /** Six numbers: lo x, lo y, lo z, hi x, hi y, hi z. */
  readonly bbox: readonly number[]
  readonly byteOffset: number
  readonly byteLength: number
}

/** A parsed pack. */
export interface Pack {
  readonly manifest: PackManifest
  readonly buffer: ArrayBuffer
  readonly bucket: string
  readonly aspect: number
  readonly vertsPerSide: number
  readonly vertexCount: number
  readonly indexCount: number
  readonly frameCount: number
  readonly layout: FrameLayout
  readonly uvs: Float32Array
  readonly indices: Uint16Array
  readonly frames: readonly PackFrame[]
  /** Pose index to **stored-slot** index, already resolved through `frames[].index`. */
  readonly keyFrames: readonly number[]
  /** Unit length. */
  readonly light: readonly [number, number, number]
}

/** One frame, decoded onto the CPU. */
export interface DecodedFrame {
  readonly positions: Float32Array
  readonly normals: Float32Array
  readonly ao: Float32Array
}

/**
 * A view may be a window into a much larger buffer — `readFileSync` returns a `Buffer` backed by
 * a pooled 64 KB `ArrayBuffer` at an arbitrary offset — so a view is copied into an
 * `ArrayBuffer` of exactly its own length before any offset is derived against it.
 */
function ownBuffer(bin: ArrayBuffer | ArrayBufferView): ArrayBuffer | null {
  if (ArrayBuffer.isView(bin)) {
    const copy = new Uint8Array(bin.byteLength)
    copy.set(new Uint8Array(bin.buffer, bin.byteOffset, bin.byteLength))
    return copy.buffer
  }
  return bin instanceof ArrayBuffer ? bin : null
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null
}

/**
 * The two rules the original never states (spec 9.1): pose 0 must be stored frame 0 — "the
 * untouched sprite" — and key frames must be non-decreasing. Pure: it validates and returns a
 * frozen copy rather than mutating anything. `parsePack` runs it over the resolved list, so a
 * pack that breaks either rule is rejected at parse time.
 */
export function setKeyFrames(
  list: readonly number[],
  frameCount: number,
): InstanceType<typeof PackError> | readonly number[] {
  if (list.length === 0) return new PackError('keyFrames: a pack needs at least one key frame')
  for (const [i, k] of list.entries()) {
    if (!Number.isInteger(k) || k < 0 || k >= frameCount) {
      return new PackError(
        `keyFrames: entry ${i} is ${String(k)}, not a stored slot in 0 … ${frameCount - 1}`,
      )
    }
  }
  if (list[0] !== 0) {
    return new PackError(
      `keyFrames: pose 0 must be stored frame 0 (the untouched sprite), got ${String(list[0])}`,
    )
  }
  for (let i = 1; i < list.length; i++) {
    if (list[i]! < list[i - 1]!) {
      return new PackError(`keyFrames: must be non-decreasing, got ${list.join(', ')}`)
    }
  }
  return Object.freeze(list.slice())
}

/** Manifest plus binary to a `Pack`. Accepts injected bytes; performs no I/O. */
export function parsePack(
  bin: ArrayBuffer | ArrayBufferView,
  manifest: unknown,
): InstanceType<typeof PackError> | Pack {
  const buffer = ownBuffer(bin)
  if (buffer === null) {
    return new PackError('pack: expected an ArrayBuffer or an ArrayBufferView of the .bin')
  }
  if (!isRecord(manifest)) return new PackError('pack: expected a manifest object')
  if (buffer.byteLength < HEADER_BYTES) {
    return new PackError(
      `pack: ${buffer.byteLength} bytes is shorter than the ${HEADER_BYTES}-byte header`,
    )
  }

  const view = new DataView(buffer)
  const magic = String.fromCharCode(
    view.getUint8(0),
    view.getUint8(1),
    view.getUint8(2),
    view.getUint8(3),
  )
  if (magic !== MAGIC) return new PackError(`pack: bad magic "${magic}", expected "${MAGIC}"`)
  const version = view.getUint32(4, true)
  if (version !== VERSION) {
    return new PackError(`pack: version ${version}, this loader reads ${VERSION}`)
  }
  const vertexCount = view.getUint32(8, true)
  const indexCount = view.getUint32(12, true)
  const frameCount = view.getUint32(16, true)

  const side = Math.round(Math.sqrt(vertexCount))
  if (side < 2 || side > MAX_VERTS_PER_SIDE || side * side !== vertexCount) {
    return new PackError(
      `pack: vertexCount ${vertexCount} is not a square grid of 2 … ${MAX_VERTS_PER_SIDE} verts per side`,
    )
  }
  if (indexCount !== 6 * (side - 1) ** 2) {
    return new PackError(
      `pack: indexCount ${indexCount} does not match a ${side - 1}x${side - 1} quad grid (expected ${6 * (side - 1) ** 2})`,
    )
  }
  if (frameCount < 1) return new PackError(`pack: frameCount ${frameCount} stores no frames`)

  // Re-derived, never trusted: three numbers the counts already determine (spec 9, 9.2).
  const derived = packOffsets(vertexCount, indexCount)
  const header = {
    uvOffset: view.getUint32(20, true),
    indexOffset: view.getUint32(24, true),
    frameBase: view.getUint32(28, true),
  }
  for (const key of ['uvOffset', 'indexOffset', 'frameBase'] as const) {
    if (header[key] !== derived[key]) {
      return new PackError(
        `pack: header ${key} is ${header[key]}, the counts derive ${derived[key]}`,
      )
    }
  }

  const layout = frameLayout(vertexCount)
  const expected = derived.frameBase + frameCount * layout.bytes
  if (expected !== buffer.byteLength) {
    return new PackError(
      `pack: size mismatch, the header implies ${expected} bytes but the file has ${buffer.byteLength}`,
    )
  }

  const checked = validateManifest(manifest, {
    side,
    vertexCount,
    indexCount,
    frameCount,
    layout,
    frameBase: derived.frameBase,
    binBytes: buffer.byteLength,
  })
  if (PackError.is(checked)) return checked

  return {
    manifest: checked.manifest,
    buffer,
    bucket: checked.manifest.bucket,
    aspect: checked.manifest.aspect,
    vertsPerSide: side,
    vertexCount,
    indexCount,
    frameCount,
    layout,
    uvs: new Float32Array(buffer, derived.uvOffset, 2 * vertexCount),
    indices: new Uint16Array(buffer, derived.indexOffset, indexCount),
    frames: checked.frames,
    keyFrames: checked.keyFrames,
    light: checked.light,
  }
}

interface HeaderFacts {
  readonly side: number
  readonly vertexCount: number
  readonly indexCount: number
  readonly frameCount: number
  readonly layout: FrameLayout
  readonly frameBase: number
  readonly binBytes: number
}

interface CheckedManifest {
  readonly manifest: PackManifest
  readonly frames: readonly PackFrame[]
  readonly keyFrames: readonly number[]
  readonly light: readonly [number, number, number]
}

/** Task 6 fills this in. For now, only what Task 5's tests exercise. */
function validateManifest(
  manifest: Record<string, unknown>,
  h: HeaderFacts,
): InstanceType<typeof PackError> | CheckedManifest {
  const rawFrames = manifest.frames
  if (!Array.isArray(rawFrames) || rawFrames.length !== h.frameCount) {
    return new PackError(
      `pack: frame count mismatch, the bin has ${h.frameCount}, the manifest lists ${
        Array.isArray(rawFrames) ? rawFrames.length : typeof rawFrames
      }`,
    )
  }
  const frames: PackFrame[] = []
  for (const [i, entry] of rawFrames.entries()) {
    if (!isRecord(entry)) return new PackError(`pack: frame ${i} is not an object`)
    const byteOffset = h.frameBase + i * h.layout.bytes
    if (entry.offset !== byteOffset) {
      return new PackError(
        `pack: frame ${i} offset ${String(entry.offset)}, expected ${byteOffset}`,
      )
    }
    if (!Number.isInteger(entry.index)) {
      return new PackError(`pack: frame ${i} has no integer index`)
    }
    const index = entry.index as number
    if (i > 0 && index <= frames[i - 1]!.index) {
      return new PackError(`pack: frame indices must strictly increase (frame ${i} is ${index})`)
    }
    const alphaFloor = Number(entry.alphaFloor)
    if (!Number.isFinite(alphaFloor) || alphaFloor < 0 || alphaFloor > 1) {
      return new PackError(
        `pack: frame ${i} alphaFloor ${String(entry.alphaFloor)} is not in 0 … 1`,
      )
    }
    const bbox = entry.bbox
    if (!Array.isArray(bbox) || bbox.length !== 6 || !bbox.every((c) => Number.isFinite(c))) {
      return new PackError(`pack: frame ${i} bbox is not a six-element numeric array`)
    }
    frames.push({
      index,
      alphaFloor,
      bbox: bbox as number[],
      byteOffset,
      byteLength: h.layout.bytes,
    })
  }

  const rawKeys = manifest.keyFrames
  if (!Array.isArray(rawKeys) || rawKeys.length === 0) {
    return new PackError('pack: the manifest has no keyFrames')
  }
  const resolved: number[] = []
  for (const k of rawKeys) {
    // Simulation indices, resolved to stored slots. frames[44] is undefined; this is not.
    const at = frames.findIndex((f) => f.index === k)
    if (at < 0) return new PackError(`pack: key frame ${String(k)} is not a stored frame`)
    resolved.push(at)
  }
  const keyFrames = setKeyFrames(resolved, h.frameCount)
  if (PackError.is(keyFrames)) return keyFrames

  const rawLight = manifest.light
  const lightOk =
    Array.isArray(rawLight) && rawLight.length === 3 && rawLight.every((c) => Number.isFinite(c))
  if (!lightOk) {
    return new PackError('pack: the manifest light is not a three-element numeric vector')
  }
  const [lx, ly, lz] = rawLight as [number, number, number]
  const ll = Math.hypot(lx, ly, lz)
  if (ll === 0) return new PackError('pack: the manifest light is the zero vector')

  return {
    manifest: manifest as unknown as PackManifest,
    frames,
    keyFrames,
    light: [lx / ll, ly / ll, lz / ll],
  }
}

function frameAt(pack: Pack, storedFrame: number): InstanceType<typeof PackError> | PackFrame {
  if (!Number.isInteger(storedFrame) || storedFrame < 0 || storedFrame >= pack.frameCount) {
    return new PackError(
      `pack: stored frame ${String(storedFrame)} is out of 0 … ${pack.frameCount - 1}`,
    )
  }
  return pack.frames[storedFrame]!
}

/** The raw frame block, ready for `gl.bufferSubData`. No copy. */
export function frameBytes(
  pack: Pack,
  storedFrame: number,
): InstanceType<typeof PackError> | Uint8Array {
  const f = frameAt(pack, storedFrame)
  if (PackError.is(f)) return f
  return new Uint8Array(pack.buffer, f.byteOffset, f.byteLength)
}

/** CPU decode of one frame, for tests, readouts and geometry checks. */
export function decodeFrame(
  pack: Pack,
  storedFrame: number,
): InstanceType<typeof PackError> | DecodedFrame {
  const f = frameAt(pack, storedFrame)
  if (PackError.is(f)) return f
  const n = pack.vertexCount
  const { layout } = pack
  const halves = new Uint16Array(pack.buffer, f.byteOffset + layout.positions, 3 * n)
  const octs = new Int8Array(pack.buffer, f.byteOffset + layout.normals, 2 * n)
  const aoBytes = new Uint8Array(pack.buffer, f.byteOffset + layout.ao, n)
  const positions = new Float32Array(3 * n)
  const normals = new Float32Array(3 * n)
  const ao = new Float32Array(n)
  for (let k = 0; k < 3 * n; k++) positions[k] = fromHalf(halves[k]!)
  for (let v = 0; v < n; v++) {
    normals.set(decodeOct(octs[2 * v]!, octs[2 * v + 1]!), 3 * v)
    ao[v] = aoBytes[v]! / 255
  }
  return { positions, normals, ao }
}
