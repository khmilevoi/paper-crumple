/**
 * The four tiles the sheet shader samples (§14). **Four 512x512 grayscale planes uploaded as
 * `R8`**, not two RGBA ones: only 4 of the 8 channels were ever sampled, so the shader change is a
 * set of swizzles and tile VRAM halves from 2 MB to 1 MB.
 *
 * The `crumpleR` / `crumpleG` planes hold the **premultiplied** normal (§14.1), which is what the
 * spike actually renders and therefore what reproduces the shipped look.
 */
export interface PaperTileSet {
  /** `round(crumple.r * crumple.a / 255)` — the crease normal's x, premultiplied. */
  readonly crumpleR: URL
  /** `round(crumple.g * crumple.a / 255)` — the crease normal's y, premultiplied. */
  readonly crumpleG: URL
  /** `crumple.a` — the high-passed crease detail. */
  readonly crumpleA: URL
  /** `fibre.a` — the high-passed paper grain, and the only channel the 3D shader ever sampled. */
  readonly fibreA: URL
}
