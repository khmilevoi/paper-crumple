/**
 * What a `@paper-crumple/motion/packs/<bucket>` subpath default-exports (§3.2, §14).
 *
 * **One module and one export subpath per pack.** A template-literal `new URL()` over a bucket
 * name compiles to a static module map with one import per matching file in Vite, and to a
 * context module in webpack 5 — all three packs land in every bundle, which defeats §3.2's whole
 * purpose. `bakedMotion({ packs })` therefore takes packs explicitly, and the main entry of this
 * package imports `./packs` not at all.
 */
import type { PackManifest } from './pack.js'

export interface PackModule {
  /** The bucket this pack was baked for: `'2x3'`, `'1x1'` or `'3x2'`. */
  readonly bucket: string
  /**
   * The manifest, inlined into the module rather than fetched as a JSON sibling — which is what
   * makes "fetch the 2 KB manifest before the 539 KB binary" free (§9.1). `sim` is **not** in
   * here; it is a separate named export so it tree-shakes to zero.
   */
  readonly manifest: PackManifest
  /**
   * Where the binary actually is. `new URL('./2x3.bin', import.meta.url)` from a module shipped
   * beside the asset, so a bundler that content-hashes it rewrites this and `manifest.bin` is
   * never resolved against anything.
   */
  readonly binUrl: URL
}
