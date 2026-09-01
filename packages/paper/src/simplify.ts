import type { Loop, Point } from './point.js'

function pointSegmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const l2 = dx * dx + dy * dy
  let t = l2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0
  t = Math.min(1, Math.max(0, t))
  const ex = a[0] + dx * t - p[0]
  const ey = a[1] + dy * t - p[1]
  return Math.sqrt(ex * ex + ey * ey)
}

/** Douglas-Peucker on an open polyline. Keeps the endpoints. */
export function simplifyPolyline(points: Loop, tolerance: number): Loop {
  const n = points.length
  if (n <= 2) return points.slice()
  const keep = new Uint8Array(n)
  keep[0] = 1
  keep[n - 1] = 1
  // A flat index stack rather than an array of pairs: `pop()` types as `number | undefined`, and
  // the `?? 0` fallbacks below are unreachable while `length >= 2` holds.
  const stack: number[] = [0, n - 1]
  while (stack.length >= 2) {
    const i1 = stack.pop() ?? 0
    const i0 = stack.pop() ?? 0
    let worst = -1
    let worstD = tolerance
    for (let i = i0 + 1; i < i1; i++) {
      const d = pointSegmentDistance(points[i], points[i0], points[i1])
      if (d > worstD) {
        worstD = d
        worst = i
      }
    }
    if (worst < 0) continue
    keep[worst] = 1
    stack.push(i0, worst, worst, i1)
  }
  const out: Loop = []
  for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i])
  return out
}

/**
 * Douglas-Peucker on a closed loop: split at the vertex farthest from vertex 0 so both halves have
 * real endpoints, simplify each, and rejoin. The first vertex is never repeated at the end.
 */
export function simplifyLoop(loop: Loop, tolerance: number): Loop {
  const n = loop.length
  if (n <= 3) return loop.slice()
  let far = 1
  let farD = -1
  for (let i = 1; i < n; i++) {
    const dx = loop[i][0] - loop[0][0]
    const dy = loop[i][1] - loop[0][1]
    const d = dx * dx + dy * dy
    if (d > farD) {
      farD = d
      far = i
    }
  }
  const a = simplifyPolyline(loop.slice(0, far + 1), tolerance)
  const b = simplifyPolyline(loop.slice(far).concat([loop[0]]), tolerance)
  // `a` ends at loop[far], `b` starts there and ends at loop[0], which `a` starts at.
  return a.concat(b.slice(1, -1))
}
