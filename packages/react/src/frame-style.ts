import type { ViewFrame } from '@paper-crumple/core'
import type { CrumpleArtworkStyle, CrumpleFrameStyle } from './crumple-types.js'

/**
 * One scale, `frameTo / max(artwork.w, artwork.h)`, applied to both of the frame's boxes (§6, and
 * USAGE "pin the picture"). The wrapper takes the drawn box — the paper, which overflows the
 * picture by however far the edge knobs reach — and is offset so the artwork lands on the
 * position the wrapper would otherwise have occupied. `examples/playground/src/framing.ts`
 * (`frameArtwork`) is the reference implementation and this is the same four multiplications.
 */
export function frameStyleFor(
  frame: ViewFrame | null,
  frameTo: number | undefined,
): CrumpleFrameStyle | null {
  if (frame === null || frameTo === undefined) return null
  const long = Math.max(frame.artwork.w, frame.artwork.h)
  // A frame with no artwork has no scale to derive; zero boxes are laid out, not NaN ones.
  const scale = long > 0 ? frameTo / long : 0
  return {
    width: `${String(Number((frame.box.w * scale).toFixed(10)))}px`,
    height: `${String(Number((frame.box.h * scale).toFixed(10)))}px`,
    left: `${String(Number((-frame.artwork.x * scale).toFixed(10)))}px`,
    top: `${String(Number((-frame.artwork.y * scale).toFixed(10)))}px`,
  }
}

/**
 * The artwork box under the same scale `frameStyleFor` applies, so the two are always in step —
 * one bump publishes both. A layout reserves THIS box; the wrapper takes the bigger one and
 * overflows it by however far the paper reaches. `examples/playground/src/framing.ts`'s
 * `frameArtwork(...).image` is the same two multiplications.
 */
export function artworkStyleFor(
  frame: ViewFrame | null,
  frameTo: number | undefined,
): CrumpleArtworkStyle | null {
  if (frame === null || frameTo === undefined) return null
  const long = Math.max(frame.artwork.w, frame.artwork.h)
  // A frame with no artwork has no scale to derive; zero boxes are laid out, not NaN ones.
  const scale = long > 0 ? frameTo / long : 0
  return {
    width: `${String(Number((frame.artwork.w * scale).toFixed(10)))}px`,
    height: `${String(Number((frame.artwork.h * scale).toFixed(10)))}px`,
  }
}
