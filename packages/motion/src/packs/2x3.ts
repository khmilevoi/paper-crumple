/**
 * The built-in `2x3` pack (§3.2, §14).
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
  aspect: 0.66667,
  bin: '2x3.bin',
  binBytes: 539320,
  bucket: '2x3',
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
      bbox: [-1.00006, -1.00001, -0.005, 1.00182, 1.00166, 0.1821],
      index: 4,
      offset: 121012,
    },
    {
      alphaFloor: 0,
      bbox: [-1.01174, -1.00262, -0.00663, 1.01013, 1.00792, 0.24115],
      index: 8,
      offset: 159040,
    },
    {
      alphaFloor: 0,
      bbox: [-1.01801, -1.01043, -0.12058, 1.01283, 0.74241, 0.28625],
      index: 12,
      offset: 197068,
    },
    {
      alphaFloor: 0,
      bbox: [-1.01801, -1.01844, -0.17542, 1.01327, 0.82591, 0.19283],
      index: 16,
      offset: 235096,
    },
    {
      alphaFloor: 0,
      bbox: [-1.01801, -1.01871, -0.13163, 1.01741, 0.81144, 0.15477],
      index: 20,
      offset: 273124,
    },
    {
      alphaFloor: 0.0741,
      bbox: [-0.91602, -0.85643, -0.10172, 1.02469, 0.64585, 0.21156],
      index: 24,
      offset: 311152,
    },
    {
      alphaFloor: 0.2593,
      bbox: [-0.74092, -0.60883, -0.17335, 0.76136, 0.39508, 0.24104],
      index: 28,
      offset: 349180,
    },
    {
      alphaFloor: 0.5,
      bbox: [-0.53052, -0.45814, -0.2114, 0.52119, 0.24664, 0.26909],
      index: 32,
      offset: 387208,
    },
    {
      alphaFloor: 0.7407,
      bbox: [-0.42209, -0.382, -0.21718, 0.40977, 0.17363, 0.26342],
      index: 36,
      offset: 425236,
    },
    {
      alphaFloor: 0.9259,
      bbox: [-0.39149, -0.35257, -0.222, 0.37117, 0.14783, 0.25079],
      index: 40,
      offset: 463264,
    },
    {
      alphaFloor: 1,
      bbox: [-0.38184, -0.34965, -0.21411, 0.36088, 0.14068, 0.25627],
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
  ballRadius: 0.13497,
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
  openFraction: 0.7274,
  pull: 1.5,
  r0Scale: 1.1,
  seed: 7,
  stackCentre: [-0.0001, -0.05182, 0.00578],
  stackRadius: 0.53047,
  stage1End: 20,
  storeEvery: 4,
  visibleFraction: 0.5575,
}

const pack: PackModule = {
  bucket: '2x3',
  manifest,
  binUrl: new URL('./2x3.bin', import.meta.url),
}

export default pack
