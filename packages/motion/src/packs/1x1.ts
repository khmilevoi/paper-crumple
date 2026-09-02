/**
 * The built-in `1x1` pack (§3.2, §14).
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
  aspect: 1,
  bin: '1x1.bin',
  binBytes: 539320,
  bucket: '1x1',
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
      bbox: [-1.00004, -1.00001, -0.00501, 1.00132, 1.00169, 0.21462],
      index: 4,
      offset: 121012,
    },
    {
      alphaFloor: 0,
      bbox: [-1.00783, -1.00261, -0.00662, 1.00734, 1.00818, 0.32149],
      index: 8,
      offset: 159040,
    },
    {
      alphaFloor: 0,
      bbox: [-1.012, -1.00816, -0.193, 1.00847, 0.75311, 0.2885],
      index: 12,
      offset: 197068,
    },
    {
      alphaFloor: 0,
      bbox: [-1.012, -1.01086, -0.20216, 1.00876, 0.8799, 0.26608],
      index: 16,
      offset: 235096,
    },
    {
      alphaFloor: 0,
      bbox: [-1.012, -1.01123, -0.19004, 1.01166, 0.83653, 0.20925],
      index: 20,
      offset: 273124,
    },
    {
      alphaFloor: 0.0741,
      bbox: [-0.89076, -0.99479, -0.1932, 0.90867, 0.65462, 0.29175],
      index: 24,
      offset: 311152,
    },
    {
      alphaFloor: 0.2593,
      bbox: [-0.60598, -0.69183, -0.26832, 0.59533, 0.53027, 0.35394],
      index: 28,
      offset: 349180,
    },
    {
      alphaFloor: 0.5,
      bbox: [-0.43166, -0.52635, -0.32822, 0.43598, 0.33662, 0.33938],
      index: 32,
      offset: 387208,
    },
    {
      alphaFloor: 0.7407,
      bbox: [-0.34864, -0.43062, -0.32973, 0.34787, 0.24965, 0.32435],
      index: 36,
      offset: 425236,
    },
    {
      alphaFloor: 0.9259,
      bbox: [-0.31516, -0.39437, -0.29699, 0.31649, 0.21549, 0.30918],
      index: 40,
      offset: 463264,
    },
    {
      alphaFloor: 1,
      bbox: [-0.31048, -0.39413, -0.2922, 0.30582, 0.21296, 0.30047],
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
  ballRadius: 0.15903,
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
  openFraction: 0.7235,
  pull: 1.5,
  r0Scale: 1.1,
  seed: 7,
  stackCentre: [-0.00009, -0.04367, 0.0048],
  stackRadius: 0.63668,
  stage1End: 20,
  storeEvery: 4,
  visibleFraction: 0.5408,
}

const pack: PackModule = {
  bucket: '1x1',
  manifest,
  binUrl: new URL('./1x1.bin', import.meta.url),
}

export default pack
