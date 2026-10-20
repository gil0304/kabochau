// LIVE: guarantee that the pumpkin head always covers the whole face.
//
// The pumpkin is pinned to the eye midpoint, but its centre sits about one
// face width behind the face. When the head pitches down (or turns), that
// centre swings up/sideways on screen and the chin or mouth would peek out —
// in 3D the chin is actually outside the pumpkin, the frontal view only hides
// it. Every frame we therefore check, in the screen plane, that every face
// landmark lies inside the pumpkin's projected silhouette and, if not:
//   1. slide the pumpkin toward the face (smallest fraction λ of the way to
//      the centre of the face's bounding box), then
//   2. if that is still not enough, grow it about its new centre (k).
// For a frontal face nothing changes (λ = 0, k = 1), so the carved eyes stay
// registered on the real eyes; only when the face would show do they drift.
//
// All 2D coordinates here are in the same plane units (x right, y up).

import type { Vec2 } from './math'

/** Symmetric 2×2 quadratic form A: p is inside when pᵀ A p ≤ 1. */
export interface Quad2 {
  xx: number
  xy: number
  yy: number
}

/**
 * Silhouette of an ellipsoid with semi-axes `radii` rotated by the row-major
 * 3×3 `rotation` and scaled by `scale`, projected along z (near-orthographic
 * LIVE camera). `margin` < 1 shrinks it (ribs / dimples make the real
 * silhouette a little smaller than the ellipsoid).
 */
export function projectedEllipse(rotation: readonly number[], radii: readonly [number, number, number], scale: number, margin = 0.9): Quad2 | null {
  // C = (R S)(R S)ᵀ, top-left 2×2 = covariance of the projected outline
  let cxx = 0
  let cxy = 0
  let cyy = 0
  for (let k = 0; k < 3; k++) {
    const r = radii[k]! * scale * margin
    const ex = rotation[k]! * r // row 0 (x), column k
    const ey = rotation[3 + k]! * r // row 1 (y), column k
    cxx += ex * ex
    cxy += ex * ey
    cyy += ey * ey
  }
  const det = cxx * cyy - cxy * cxy
  if (!(det > 1e-12)) return null
  return { xx: cyy / det, xy: -cxy / det, yy: cxx / det }
}

const inside = (q: Quad2, x: number, y: number) => q.xx * x * x + 2 * q.xy * x * y + q.yy * y * y

export interface CoverageFit {
  /** fraction of the way the pumpkin centre moves toward `target` (0..1) */
  shift: number
  /** extra scale about the shifted centre (≥ 1) */
  grow: number
}

function bisect(ok: (v: number) => boolean, lo: number, hi: number): number {
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2
    if (ok(mid)) hi = mid
    else lo = mid
  }
  return hi
}

/**
 * Smallest adjustment that puts every point inside the silhouette `quad`
 * centred at `center`: first a shift toward `target` (the face centre), then
 * growth about the shifted centre, capped at `maxGrow`.
 */
export function coverageFit(points: readonly Vec2[], center: Vec2, target: Vec2, quad: Quad2, maxGrow = 1.5): CoverageFit {
  const covered = (shift: number, grow: number) => {
    const cx = center.x + (target.x - center.x) * shift
    const cy = center.y + (target.y - center.y) * shift
    const lim = grow * grow
    for (const p of points) if (inside(quad, p.x - cx, p.y - cy) > lim) return false
    return true
  }
  if (covered(0, 1)) return { shift: 0, grow: 1 }
  if (covered(1, 1)) return { shift: bisect((v) => covered(v, 1), 0, 1), grow: 1 }
  if (!covered(1, maxGrow)) return { shift: 1, grow: maxGrow }
  return { shift: 1, grow: bisect((v) => covered(1, v), 1, maxGrow) }
}

/** Centre of the points' bounding box (where a covering pumpkin should sit). */
export function boundsCenter(points: readonly Vec2[]): Vec2 {
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const p of points) {
    minX = Math.min(minX, p.x)
    maxX = Math.max(maxX, p.x)
    minY = Math.min(minY, p.y)
    maxY = Math.max(maxY, p.y)
  }
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 }
}

/** Apply instantly when more is needed (never show the face), relax slowly (no pumping). */
export function smoothCoverage(current: number, target: number, dt: number, release = 0.6): number {
  if (target >= current) return target
  const k = 1 - Math.exp(-Math.max(0, dt) / release)
  return current + (target - current) * k
}
