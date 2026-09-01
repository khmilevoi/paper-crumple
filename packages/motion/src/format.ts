/**
 * CRMP v1: the constants and the offset arithmetic (spec 9). Little-endian throughout.
 *
 * ```
 * Header, 32 bytes
 *   0   char[4]  magic "CRMP"
 *   4   u32      version = 1
 *   8   u32      vertexCount            4225 (65 x 65)
 *   12  u32      indexCount             24576
 *   16  u32      frameCount             12 stored frames
 *   20  u32      uvOffset               32
 *   24  u32      indexOffset            align4(uvOffset + 8 * vertexCount)   = 33832
 *   28  u32      frameBase              align4(indexOffset + 2 * indexCount) = 82984
 * UV block      Float32 x 2 x n   u = col/64, v = row/64, row-major, row 0 = y min
 * Index block   UInt16 x indexCount    two CCW triangles per quad, a = row*65 + col
 * Frame blocks  frameCount x align4(9n) = 38028 B each
 *   +0n   Float16 x 3 x n   positions in normalised sheet space: x/(W/2), y/(H/2), z/(H/2)
 *   +6n   Int8    x 2 x n   oct-encoded unit normals, snorm8 = floor(v * 127 + 0.5)
 *   +8n   UInt8   x n       ambient occlusion, 1 = open
 * ```
 *
 * Nothing here reads a manifest. `parsePack` compares the header against what these functions
 * derive, and the bake writers lay a pack out with the same two functions — that shared
 * derivation is what makes the Python writer, the JS twin and the committed fixture comparable.
 */

/** The four magic bytes at offset 0. */
export const MAGIC = 'CRMP'
/** The only format version this package reads or writes. */
export const VERSION = 1
/** The fixed header size, and therefore the UV block's offset. */
export const HEADER_BYTES = 32
/**
 * The UInt16 index block caps the sheet at 255 quads — 256 vertices per side, 65 536 vertices,
 * whose highest index 65 535 is the last an unsigned 16-bit integer can name (spec 9.3).
 */
export const MAX_VERTS_PER_SIDE = 256

/** Where the three per-vertex arrays sit inside one frame block, and how long the block is. */
export interface FrameLayout {
  /** Always 0: positions lead the block. */
  readonly positions: number
  /** `6 * vertexCount` — three Float16s per vertex precede it. */
  readonly normals: number
  /** `8 * vertexCount` — two Int8s per vertex precede it. */
  readonly ao: number
  /** `align4(9 * vertexCount)`: the stride from one frame block to the next. */
  readonly bytes: number
}

/** Where the UV, index and frame blocks sit inside the file. */
export interface PackOffsets {
  readonly uvOffset: number
  readonly indexOffset: number
  readonly frameBase: number
}

/** Rounds up to the next multiple of four. */
export function align4(n: number): number {
  return (n + 3) & ~3
}

/** The three sub-block offsets and the stride, for a grid of `vertexCount` vertices. */
export function frameLayout(vertexCount: number): FrameLayout {
  const n = vertexCount
  return { positions: 0, normals: 6 * n, ao: 8 * n, bytes: align4(9 * n) }
}

/**
 * The offsets a legal pack must carry. `parsePack` recomputes these and refuses a header that
 * disagrees, rather than trusting three numbers it could derive.
 */
export function packOffsets(vertexCount: number, indexCount: number): PackOffsets {
  const uvOffset = HEADER_BYTES
  const indexOffset = align4(uvOffset + 8 * vertexCount)
  return { uvOffset, indexOffset, frameBase: align4(indexOffset + 2 * indexCount) }
}
