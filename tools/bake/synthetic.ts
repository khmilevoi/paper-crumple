/**
 * An analytic "curl then wrap" sheet: aspect 1, twelve stored frames, key frames 0 8 16 24 32 44
 * (spec 13). A stand-in for a bake, so the runtime can be brought up and the pack path exercised
 * without Blender's 4 m 10 s.
 *
 * Deterministic on purpose: no random numbers, and every length is `Math.sqrt(x*x + …)` rather
 * than `Math.hypot`, whose result is not guaranteed identical across engine versions. The
 * committed `fixtures/synthetic.bin` is compared byte for byte across three Node major versions
 * in CI, so a one-ulp difference would present as a corrupt fixture.
 */
import type { FrameSpec, PackSpec } from './packWriter.js'

/** 65 vertices per side: 64 quads, the shipped grid. */
export const SYNTHETIC_SIDE = 65
/** The stored simulation frames, every fourth frame of 48. */
export const SYNTHETIC_STORED: readonly number[] = [0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44]
/** `align4(9 * 4225) * 12 + 82984`. */
export const SYNTHETIC_BYTES = 539320

/** Position and analytic normal of grid point `(u, v)` in [-1, 1]² at progress `t` in [0, 1]. */
export function surface(
  u: number,
  v: number,
  t: number,
): { p: [number, number, number]; n: [number, number, number] } {
  const curl = Math.min(1, t * 2) // 0..1 over the first half: corners lift
  const wrap = Math.max(0, t * 2 - 1) // 0..1 over the second half: the sheet wraps a sphere
  const r2 = u * u + v * v
  const z0 = 0.9 * curl * r2 * r2 // quartic bowl: flat middle, lifted corners
  const R = 0.55
  const cap = Math.sqrt(Math.max(0, R * R - 0.25 * r2)) // guarded: r2 reaches 2 at the corners
  const zs = R - cap
  const shrink = 1 - 0.6 * wrap
  const x = u * shrink
  const y = v * shrink
  const z = (1 - wrap) * z0 + wrap * zs * 1.6
  const dz = (1 - wrap) * 0.9 * curl * 4 * r2 + wrap * (0.5 / Math.max(0.05, cap)) * 1.6
  const nx = -dz * u
  const ny = -dz * v
  const l = Math.sqrt(nx * nx + ny * ny + 1)
  return { p: [x, y, z], n: [nx / l, ny / l, 1 / l] }
}

/** The whole synthetic pack spec, ready for `writePack`. */
export function syntheticFrames(): PackSpec {
  const n = SYNTHETIC_SIDE * SYNTHETIC_SIDE
  const frames: FrameSpec[] = SYNTHETIC_STORED.map((index) => {
    const t = index / 44
    const positions = new Float32Array(3 * n)
    const normals = new Float32Array(3 * n)
    const ao = new Float32Array(n)
    for (let row = 0; row < SYNTHETIC_SIDE; row++) {
      for (let col = 0; col < SYNTHETIC_SIDE; col++) {
        const i = row * SYNTHETIC_SIDE + col
        const u = col / 32 - 1
        const v = row / 32 - 1
        // Frame 0 is the exact rest grid, so pose 0 can be pixel-identical to the sprite.
        const sample =
          index === 0 ? { p: [u, v, 0] as const, n: [0, 0, 1] as const } : surface(u, v, t)
        positions.set(sample.p, 3 * i)
        normals.set(sample.n, 3 * i)
        // Darker toward the middle as the sheet closes.
        ao[i] = 1 - 0.5 * t * (1 - Math.min(1, u * u + v * v))
      }
    }
    return { index, positions, normals, ao }
  })
  return {
    vertsPerSide: SYNTHETIC_SIDE,
    frames,
    keyFrames: [0, 8, 16, 24, 32, 44],
    light: [-0.4, 0.55, 0.73338],
    bucket: 'synthetic',
    aspect: 1,
    sim: { fps: 24, frames: 48, storeEvery: 4, stage1End: 20, seed: 0, blender: 'synthetic' },
  }
}
