/**
 * The built-in `3x2` pack (§3.2, §14).
 *
 * One module, one export subpath, and the binary beside it. The manifest is inlined rather than
 * fetched as a JSON sibling; `sim` is a separate named export so a consumer who does not import
 * it pays nothing for it (§9.1). `manifest.bin` is provenance and is **never** resolved — the
 * binary is reached through `binUrl` alone, so a bundler that content-hashes the asset rewrites
 * the one place that names it.
 *
 * Baked by `tools/bake/`. Do not hand-edit: `parsePack` re-derives every offset from the
 * counts and rejects a manifest that disagrees with its binary (§9.2).
 */
import type { PackModule } from '../pack-module.js'
import type { PackManifest } from '../pack.js'

/** The manifest, minus `sim`. */
export const manifest = {
  aspect: 1.5,
  bin: '3x2.bin',
  binBytes: 539320,
  bucket: '3x2',
  frameBytes: 38028,
  frames: [
    {
      alphaFloor: 0,
      bbox: [-1, -1, 0, 1, 1, 0],
      index: 0,
      offset: 82984,
    },
    {
      alphaFloor: 0,
      bbox: [-1.00003, -1.00001, -0.00499, 1.00094, 1.00166, 0.26338],
      index: 4,
      offset: 121012,
    },
    {
      alphaFloor: 0,
      bbox: [-1.00516, -1.00247, -0.00662, 1.00521, 1.00814, 0.44199],
      index: 8,
      offset: 159040,
    },
    {
      alphaFloor: 0,
      bbox: [-1.00791, -1.00732, -0.30163, 1.00588, 0.7712, 0.29188],
      index: 12,
      offset: 197068,
    },
    {
      alphaFloor: 0,
      bbox: [-1.00791, -1.01088, -0.31881, 0.9727, 0.96089, 0.37751],
      index: 16,
      offset: 235096,
    },
    {
      alphaFloor: 0,
      bbox: [-1.00791, -1.01126, -0.29676, 0.97212, 0.87416, 0.33543],
      index: 20,
      offset: 273124,
    },
    {
      alphaFloor: 0.0741,
      bbox: [-0.80768, -1.01294, -0.31348, 0.78208, 0.70646, 0.37076],
      index: 24,
      offset: 311152,
    },
    {
      alphaFloor: 0.2593,
      bbox: [-0.55365, -0.86702, -0.36551, 0.51353, 0.6895, 0.47684],
      index: 28,
      offset: 349180,
    },
    {
      alphaFloor: 0.5,
      bbox: [-0.37608, -0.6238, -0.41656, 0.35832, 0.46336, 0.5105],
      index: 32,
      offset: 387208,
    },
    {
      alphaFloor: 0.7407,
      bbox: [-0.31588, -0.49838, -0.38043, 0.28111, 0.37939, 0.46351],
      index: 36,
      offset: 425236,
    },
    {
      alphaFloor: 0.9259,
      bbox: [-0.28629, -0.45542, -0.37795, 0.25381, 0.3302, 0.42454],
      index: 40,
      offset: 463264,
    },
    {
      alphaFloor: 1,
      bbox: [-0.28038, -0.45434, -0.37637, 0.24934, 0.3277, 0.41892],
      index: 44,
      offset: 501292,
    },
  ],
  indexCount: 24576,
  keyFrames: [0, 8, 16, 24, 32, 44],
  light: [-0.39993, 0.5499, 0.73325],
  version: 1,
  vertexCount: 4225,
  vertsPerSide: 65,
} satisfies PackManifest

/**
 * Provenance: Blender version and the cloth parameters (§9.1). Never read by the loader, and
 * exported separately so it tree-shakes to zero. `stage1End` lives in here, and §9.3 lists it
 * among the values baked into a pack, which is why it ships at all.
 */
export const sim = {
  aoSamples: 16,
  ball: 0.24,
  ballRadius: 0.20903,
  blender: '5.2.1 LTS',
  cloth: {
    air: 1,
    bend_damping: 2,
    bending: 500,
    col_dist: 0.008,
    col_quality: 4,
    compression: 80,
    crease_band: 2.5,
    crease_pin: 1,
    damping: 10,
    depth_scale: 0.6,
    flaps: 6,
    hinge: 'pins',
    hinge_deg: 150,
    hinge_frames: 8,
    mass: 0.15,
    pin_stiffness: 1,
    quads: 64,
    quality: 10,
    self_dist: 0.006,
    shear: 60,
    stagger: 2,
    tension: 80,
  },
  fps: 24,
  frames: 48,
  openFraction: 0.7047,
  pull: 1.5,
  r0Scale: 1.1,
  seed: 7,
  stackCentre: [-0.01342, -0.03427, 0.00967],
  stackRadius: 0.83023,
  stage1End: 20,
  storeEvery: 4,
  visibleFraction: 0.5127,
}

const pack: PackModule = {
  bucket: '3x2',
  manifest,
  binUrl: new URL('./3x2.bin', import.meta.url),
}

export default pack
