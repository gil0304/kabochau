// Small allocation-light vector helpers shared by the pure (DOM-free) modules.

export interface Vec2 {
  x: number
  y: number
}

export interface Vec3 {
  x: number
  y: number
  z: number
}

export const v2 = (x: number, y: number): Vec2 => ({ x, y })
export const v3 = (x: number, y: number, z: number): Vec3 => ({ x, y, z })

export const add3 = (a: Vec3, b: Vec3): Vec3 => v3(a.x + b.x, a.y + b.y, a.z + b.z)
export const sub3 = (a: Vec3, b: Vec3): Vec3 => v3(a.x - b.x, a.y - b.y, a.z - b.z)
export const scale3 = (a: Vec3, s: number): Vec3 => v3(a.x * s, a.y * s, a.z * s)
export const dot3 = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z
export const cross3 = (a: Vec3, b: Vec3): Vec3 =>
  v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x)
export const len3 = (a: Vec3): number => Math.hypot(a.x, a.y, a.z)
export const mid3 = (a: Vec3, b: Vec3): Vec3 => v3((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2)

export function normalize3(a: Vec3): Vec3 {
  const l = len3(a)
  return l > 1e-12 ? scale3(a, 1 / l) : v3(0, 0, 0)
}

export const sub2 = (a: Vec2, b: Vec2): Vec2 => v2(a.x - b.x, a.y - b.y)
export const add2 = (a: Vec2, b: Vec2): Vec2 => v2(a.x + b.x, a.y + b.y)
export const scale2 = (a: Vec2, s: number): Vec2 => v2(a.x * s, a.y * s)
export const len2 = (a: Vec2): number => Math.hypot(a.x, a.y)
export const dist2 = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y)
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t
export const lerp2 = (a: Vec2, b: Vec2, t: number): Vec2 => v2(lerp(a.x, b.x, t), lerp(a.y, b.y, t))

export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x)
export const clamp01 = (x: number): number => clamp(x, 0, 1)

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0))
  return t * t * (3 - 2 * t)
}

export function isFiniteVec3(a: Vec3): boolean {
  return Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.z)
}

/** Signed area (positive = counter-clockwise in a y-up frame). */
export function polygonArea(poly: readonly Vec2[]): number {
  let a = 0
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i]!
    const q = poly[(i + 1) % n]!
    a += p.x * q.y - q.x * p.y
  }
  return a / 2
}

export function polygonCentroid(poly: readonly Vec2[]): Vec2 {
  const area = polygonArea(poly)
  if (Math.abs(area) < 1e-12) {
    let sx = 0
    let sy = 0
    for (const p of poly) {
      sx += p.x
      sy += p.y
    }
    return v2(sx / Math.max(1, poly.length), sy / Math.max(1, poly.length))
  }
  let cx = 0
  let cy = 0
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i]!
    const q = poly[(i + 1) % n]!
    const f = p.x * q.y - q.x * p.y
    cx += (p.x + q.x) * f
    cy += (p.y + q.y) * f
  }
  return v2(cx / (6 * area), cy / (6 * area))
}

export interface Bounds2 {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export function polygonBounds(poly: readonly Vec2[]): Bounds2 {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of poly) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  return { minX, minY, maxX, maxY }
}

/** Even-odd point-in-polygon test. */
export function pointInPolygon(p: Vec2, poly: readonly Vec2[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!
    const b = poly[j]!
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

function segmentsIntersect(p1: Vec2, p2: Vec2, p3: Vec2, p4: Vec2): boolean {
  const d1 = (p4.x - p3.x) * (p1.y - p3.y) - (p4.y - p3.y) * (p1.x - p3.x)
  const d2 = (p4.x - p3.x) * (p2.y - p3.y) - (p4.y - p3.y) * (p2.x - p3.x)
  const d3 = (p2.x - p1.x) * (p3.y - p1.y) - (p2.y - p1.y) * (p3.x - p1.x)
  const d4 = (p2.x - p1.x) * (p4.y - p1.y) - (p2.y - p1.y) * (p4.x - p1.x)
  return d1 * d2 < 0 && d3 * d4 < 0
}

/** True when no two non-adjacent edges cross (O(n²), fine for carving outlines). */
export function isSimplePolygon(poly: readonly Vec2[]): boolean {
  const n = poly.length
  if (n < 3) return false
  for (let i = 0; i < n; i++) {
    const a1 = poly[i]!
    const a2 = poly[(i + 1) % n]!
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue
      if (segmentsIntersect(a1, a2, poly[j]!, poly[(j + 1) % n]!)) return false
    }
  }
  return true
}

/** Deterministic 32-bit hash of a list of numbers (used for stable per-face variety). */
export function hashNumbers(values: readonly number[]): number {
  let h = 2166136261 >>> 0
  for (const v of values) {
    const q = Math.round(v * 1000) | 0
    h ^= q & 0xff
    h = Math.imul(h, 16777619)
    h ^= (q >>> 8) & 0xff
    h = Math.imul(h, 16777619)
    h ^= (q >>> 16) & 0xffff
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}
