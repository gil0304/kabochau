import { CANONICAL_FACE } from '../fixtures/canonicalFace'
import { EYE_L, EYE_R } from '../../app/utils/landmarkIndices'
import type { LandmarkLike } from '../../app/utils/faceMapping'

export type Vertex = [number, number, number]

export interface ProjectOptions {
  imageWidth?: number
  imageHeight?: number
  /** face centre in pixels */
  cx?: number
  cy?: number
  /** pixels per centimetre */
  scale?: number
  yaw?: number
  pitch?: number
  roll?: number
}

/** Fresh mutable copy of the canonical (average) face. */
export function canonicalVertices(): Vertex[] {
  return CANONICAL_FACE.map((v) => [v[0], v[1], v[2]] as Vertex)
}

function rotate(v: Vertex, yaw: number, pitch: number, roll: number): Vertex {
  let [x, y, z] = v
  // yaw about +y
  let c = Math.cos(yaw)
  let s = Math.sin(yaw)
  ;[x, z] = [c * x + s * z, -s * x + c * z]
  // pitch about +x
  c = Math.cos(pitch)
  s = Math.sin(pitch)
  ;[y, z] = [c * y - s * z, s * y + c * z]
  // roll about +z
  c = Math.cos(roll)
  s = Math.sin(roll)
  ;[x, y] = [c * x - s * y, s * x + c * y]
  return [x, y, z]
}

/**
 * Projects canonical-space vertices (cm, +x viewer right, +y up, +z towards
 * camera) into MediaPipe-style normalised landmarks of an UNMIRRORED image.
 * Adds the 10 iris points (468-477) at the eye centres.
 */
export function projectToLandmarks(verts: readonly Vertex[], opts: ProjectOptions = {}): LandmarkLike[] {
  const W = opts.imageWidth ?? 1280
  const H = opts.imageHeight ?? 720
  const cx = opts.cx ?? W / 2
  const cy = opts.cy ?? H / 2
  const s = opts.scale ?? 14
  const out: LandmarkLike[] = verts.map((v) => {
    const [x, y, z] = rotate(v, opts.yaw ?? 0, opts.pitch ?? 0, opts.roll ?? 0)
    return { x: (cx + s * x) / W, y: (cy - s * y) / H, z: (-s * z) / W }
  })
  const centre = (ids: readonly number[]) => {
    const n = ids.length
    return {
      x: ids.reduce((a, i) => a + out[i]!.x, 0) / n,
      y: ids.reduce((a, i) => a + out[i]!.y, 0) / n,
      z: ids.reduce((a, i) => a + (out[i]!.z ?? 0), 0) / n,
    }
  }
  const r = centre(EYE_R.contour)
  const l = centre(EYE_L.contour)
  for (let k = 0; k < 5; k++) out.push({ ...r })
  for (let k = 0; k < 5; k++) out.push({ ...l })
  return out
}

/** Moves the listed vertices by (dx, dy) cm. */
export function shift(verts: Vertex[], ids: readonly number[], dx: number, dy: number): void {
  for (const i of new Set(ids)) {
    verts[i]![0] += dx
    verts[i]![1] += dy
  }
}

/** Scales the listed vertices about their centroid. */
export function scaleAbout(verts: Vertex[], ids: readonly number[], sx: number, sy: number): void {
  const uniq = [...new Set(ids)]
  const cx = uniq.reduce((a, i) => a + verts[i]![0], 0) / uniq.length
  const cy = uniq.reduce((a, i) => a + verts[i]![1], 0) / uniq.length
  for (const i of uniq) {
    verts[i]![0] = cx + (verts[i]![0] - cx) * sx
    verts[i]![1] = cy + (verts[i]![1] - cy) * sy
  }
}
