// Group photos: MediaPipe's Face Landmarker only uses the short-range face
// detector (it shrinks the whole image to 128 px), so small faces in a group
// photo are often missed. For still photos we additionally run detection on
// overlapping tiles — each face is then ~2× larger for the detector — and
// merge the results back into full-image coordinates. All of this is local.

import type { LandmarkLike } from './faceMapping'

export interface Tile {
  /** normalised to the full image */
  x: number
  y: number
  w: number
  h: number
}

export interface FaceCandidate<B = unknown> {
  landmarks: LandmarkLike[]
  blendshapes: B
  /** true when detected on the full image (preferred over tile duplicates) */
  full: boolean
  /** tile the candidate came from (full image = {0,0,1,1}) */
  tile: Tile
}

const CHEEK_RIGHT = 234
const CHEEK_LEFT = 454

/** Overlapping tiles: 2–3 columns for landscape, 2 rows for portrait, 2×2 for square-ish photos. */
export function photoTiles(width: number, height: number, overlap = 0.25): Tile[] {
  if (!(width > 0) || !(height > 0)) return []
  const aspect = width / height
  const cols = aspect >= 2.2 ? 3 : aspect >= 0.83 ? 2 : 1
  const rows = aspect <= 1.2 ? 2 : 1
  const tw = cols === 1 ? 1 : Math.min(1, (1 / cols) * (1 + overlap))
  const th = rows === 1 ? 1 : Math.min(1, (1 / rows) * (1 + overlap))
  const tiles: Tile[] = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = cols === 1 ? 0 : (c * (1 - tw)) / (cols - 1)
      const y = rows === 1 ? 0 : (r * (1 - th)) / (rows - 1)
      tiles.push({ x, y, w: tw, h: th })
    }
  }
  return tiles
}

/**
 * Landmarks detected in a tile → full-image normalised coordinates. z is
 * expressed by MediaPipe in units of the (tile) image width, so it is rescaled
 * by tileWidth / imageWidth as well.
 */
export function mapTileLandmarks(landmarks: readonly LandmarkLike[], tile: Tile): LandmarkLike[] {
  return landmarks.map((l) => ({
    x: tile.x + l.x * tile.w,
    y: tile.y + l.y * tile.h,
    z: l.z === undefined ? undefined : l.z * tile.w,
  }))
}

function faceGeometry(lm: readonly LandmarkLike[], aspect: number) {
  const a = lm[CHEEK_RIGHT]
  const b = lm[CHEEK_LEFT]
  if (!a || !b) return null
  const x = ((a.x + b.x) / 2) * aspect
  const y = (a.y + b.y) / 2
  const size = Math.hypot((a.x - b.x) * aspect, a.y - b.y)
  return size > 0 ? { x, y, size } : null
}

/** True when the face's cheek-to-cheek span touches an inner tile edge (likely cut off). */
export function touchesTileEdge(lm: readonly LandmarkLike[], tile: Tile, margin = 0.015): boolean {
  if (tile.w >= 1 && tile.h >= 1) return false
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const i of [CHEEK_RIGHT, CHEEK_LEFT, 10, 152]) {
    const p = lm[i]
    if (!p) continue
    minX = Math.min(minX, p.x)
    maxX = Math.max(maxX, p.x)
    minY = Math.min(minY, p.y)
    maxY = Math.max(maxY, p.y)
  }
  const innerLeft = tile.x > 1e-6
  const innerRight = tile.x + tile.w < 1 - 1e-6
  const innerTop = tile.y > 1e-6
  const innerBottom = tile.y + tile.h < 1 - 1e-6
  return (
    (innerLeft && minX < tile.x + margin) ||
    (innerRight && maxX > tile.x + tile.w - margin) ||
    (innerTop && minY < tile.y + margin) ||
    (innerBottom && maxY > tile.y + tile.h - margin)
  )
}

/**
 * De-duplicates faces found on the full image and on tiles (landmarks already
 * in full-image coordinates). Full-image detections win; tile detections that
 * are cut by a tile edge are dropped.
 */
export function mergeFaceCandidates<B>(candidates: readonly FaceCandidate<B>[], imageWidth: number, imageHeight: number): FaceCandidate<B>[] {
  const aspect = imageWidth / imageHeight
  const ordered = candidates
    .map((c) => ({ c, g: faceGeometry(c.landmarks, aspect) }))
    .filter((e): e is { c: FaceCandidate<B>; g: { x: number; y: number; size: number } } => e.g !== null)
    .filter((e) => e.c.full || !touchesTileEdge(e.c.landmarks, e.c.tile))
    .sort((a, b) => Number(b.c.full) - Number(a.c.full) || b.g.size - a.g.size)
  const kept: typeof ordered = []
  for (const e of ordered) {
    const dup = kept.some((k) => Math.hypot(k.g.x - e.g.x, k.g.y - e.g.y) < 0.6 * Math.max(k.g.size, e.g.size))
    if (!dup) kept.push(e)
  }
  return kept.map((e) => e.c)
}
