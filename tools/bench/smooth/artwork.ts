/**
 * The synthetic artwork every view shows: the GL bench's garment-ish logo (a torso disc, two
 * legs, the concave gap between them — `../gl/harness.ts`), varied per image so the hull cache,
 * which keys on the bitmap, never answers a swap from memory and every source is a real one.
 *
 * The variation is deterministic in `i`: the hue, the torso radius and height, the leg widths and
 * gap, a sleeve on one side, and a few holes punched through the silhouette — each of which moves
 * the contour count and the hull vertex count, so the CPU side of `source()` varies too. Encoded
 * as PNG through `OffscreenCanvas.convertToBlob`, so the swap goes through the playground's own
 * path: a URL, a fetch, a decode.
 */

/** A small LCG so the variation is reproducible run to run without seeding a global. */
function rng(seed: number): () => number {
  let s = (seed * 2654435761 + 1013904223) >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

export async function artworkBlob(i: number, size: number): Promise<Blob | Error> {
  const canvas = new OffscreenCanvas(size, size)
  const c2d = canvas.getContext('2d')
  if (c2d === null) return new Error('no 2D context for the artwork')
  const r = rng(i + 1)
  const w = size
  const h = size
  const hue = Math.floor(r() * 360)
  const g = c2d.createLinearGradient(0, 0, w, h)
  g.addColorStop(0, `hsl(${hue} 70% 45%)`)
  g.addColorStop(1, `hsl(${(hue + 140) % 360} 60% 40%)`)
  c2d.fillStyle = g

  const cx = w / 2
  const cy = h * (0.3 + r() * 0.1)
  const radius = Math.min(w, h) * (0.2 + r() * 0.1)
  c2d.beginPath()
  c2d.arc(cx, cy, radius, 0, Math.PI * 2)
  c2d.fill()

  const legW = w * (0.11 + r() * 0.08)
  const gap = w * (0.06 + r() * 0.1)
  const legBottom = h * (0.88 + r() * 0.07)
  c2d.fillRect(cx - gap / 2 - legW, cy, legW, legBottom - cy)
  c2d.fillRect(cx + gap / 2, cy, legW, legBottom - cy)

  // A sleeve, left or right, so the silhouette is not mirror-symmetric.
  const sleeveW = w * (0.08 + r() * 0.08)
  const sleeveH = h * (0.2 + r() * 0.2)
  const left = r() < 0.5
  c2d.fillRect(left ? cx - radius - sleeveW : cx + radius, cy - sleeveH * 0.3, sleeveW, sleeveH)

  // Holes: each one is a contour of its own for the tracer and a concavity for the hull.
  c2d.globalCompositeOperation = 'destination-out'
  const holes = 1 + Math.floor(r() * 3)
  for (let k = 0; k < holes; k++) {
    const hr = Math.min(w, h) * (0.02 + r() * 0.04)
    c2d.beginPath()
    c2d.arc(cx + (r() - 0.5) * radius, cy + (r() - 0.3) * radius, hr, 0, Math.PI * 2)
    c2d.fill()
  }
  c2d.globalCompositeOperation = 'source-over'

  // Blob URLs are what the playground swaps to after a drop; PNG is what its samples are.
  return canvas.convertToBlob({ type: 'image/png' }).catch((e: unknown) => {
    return e instanceof Error ? e : new Error(String(e))
  })
}
