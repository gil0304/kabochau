// Pumpkin geometry data model (renderer independent, unit tested).
//
// Object space: pumpkin centre at the origin, +x = display right, +y = up,
// +z = towards the viewer (the carved face looks down +z). Radius ≈ 1.
//
// The shell is a radial (star-shaped) surface  P(θ, φ) = dir(θ, φ) · ρ(θ, φ)
//   dir = (sin φ sin θ, cos φ, sin φ cos θ),  θ = 0 at the front, φ = 0 at the top.
// ρ combines an ellipsoid, vertical ribs/grooves, top/bottom dimples, a low
// bulge and gentle per-pumpkin irregularity.
//
// Carving: each facial feature becomes a closed 2D outline in object x/y. The
// renderer (a) masks those outlines out of the shell (orthographic front
// projection) and (b) extrudes real 3D "cut walls" from the outer surface
// inwards along the same outlines, so the openings have physical thickness.

import {
  type Bounds2,
  type Vec2,
  clamp,
  clamp01,
  hashNumbers,
  isSimplePolygon,
  lerp,
  polygonArea,
  polygonBounds,
  polygonCentroid,
  smoothstep,
  v2,
} from './math'
import { REFERENCE_FACE, paramsSignature, type PumpkinFaceParams } from './faceMapping'
import { NEUTRAL_EXPRESSION, type ExpressionState } from './expressionMapping'

// ---------------------------------------------------------------------------
// Shell

export interface PumpkinShape {
  radiusX: number
  radiusY: number
  radiusZ: number
  ribs: number
  /** Fractional radial depth of the grooves. */
  ribDepth: number
  /** <1: broad lobes and sharp grooves. */
  ribSharpness: number
  /** Radians; 0 puts a lobe crest at the front. */
  ribPhase: number
  topDimple: number
  bottomDimple: number
  bulge: number
  /** Polar angle (radians) of the bulge maximum. */
  bulgeHeight: number
  wobble: number
  seed: number
}

export const DEFAULT_PUMPKIN_SHAPE: Readonly<PumpkinShape> = Object.freeze({
  radiusX: 1,
  radiusY: 0.84,
  radiusZ: 0.97,
  ribs: 10,
  ribDepth: 0.065,
  ribSharpness: 0.55,
  ribPhase: 0,
  topDimple: 0.2,
  bottomDimple: 0.12,
  bulge: 0.05,
  bulgeHeight: Math.PI * 0.56,
  wobble: 0.018,
  seed: 1,
})

/** Groove factor (0 = lobe crest, 1 = groove bottom), already faded towards the poles. */
export function shellGroove(shape: PumpkinShape, theta: number, phi: number): number {
  const c = Math.abs(Math.cos((shape.ribs * (theta - shape.ribPhase)) / 2))
  return (1 - Math.pow(c, shape.ribSharpness)) * Math.pow(Math.sin(phi), 0.8)
}

export function shellRadius(shape: PumpkinShape, theta: number, phi: number): number {
  const sp = Math.sin(phi)
  const dx = sp * Math.sin(theta)
  const dy = Math.cos(phi)
  const dz = sp * Math.cos(theta)
  const e = 1 / Math.sqrt((dx / shape.radiusX) ** 2 + (dy / shape.radiusY) ** 2 + (dz / shape.radiusZ) ** 2)
  const lobes = 1 - shape.ribDepth * shellGroove(shape, theta, phi)
  const dimples =
    1 - shape.topDimple * Math.exp(-((phi / 0.36) ** 2)) - shape.bottomDimple * Math.exp(-(((Math.PI - phi) / 0.4) ** 2))
  const bulge = 1 + shape.bulge * Math.exp(-(((phi - shape.bulgeHeight) / 0.5) ** 2))
  const s = shape.seed
  const wobble = 1 + shape.wobble * (0.6 * Math.sin(3 * theta + s) + 0.4 * Math.sin(5 * theta + 2.3 * s)) * sp
  return e * lobes * dimples * bulge * wobble
}

export function shellPoint(shape: PumpkinShape, theta: number, phi: number): [number, number, number] {
  const r = shellRadius(shape, theta, phi)
  const sp = Math.sin(phi)
  return [r * sp * Math.sin(theta), r * Math.cos(phi), r * sp * Math.cos(theta)]
}

/** Signed distance-like test: <0 inside the shell, >0 outside. */
function shellInsideTest(shape: PumpkinShape, x: number, y: number, z: number): number {
  const r = Math.hypot(x, y, z)
  if (r < 1e-9) return -1
  const phi = Math.acos(clamp(y / r, -1, 1))
  const theta = Math.atan2(x, z)
  return r - shellRadius(shape, theta, phi)
}

/**
 * z of the front surface (z > 0) at object (x, y), or null when (x, y) is
 * outside the silhouette. Ellipsoid initial guess + bracketing + bisection.
 */
export function frontSurfaceZ(shape: PumpkinShape, x: number, y: number): number | null {
  if (shellInsideTest(shape, x, y, 0) >= 0) return null
  const q = 1 - (x / shape.radiusX) ** 2 - (y / shape.radiusY) ** 2
  const guess = shape.radiusZ * Math.sqrt(Math.max(0, q))
  let lo = Math.max(0, guess - 0.35)
  let hi = guess + 0.3
  if (shellInsideTest(shape, x, y, lo) >= 0) lo = 0
  let guard = 0
  while (shellInsideTest(shape, x, y, hi) < 0 && guard++ < 8) hi += 0.5
  for (let i = 0; i < 22; i++) {
    const m = (lo + hi) / 2
    if (shellInsideTest(shape, x, y, m) < 0) lo = m
    else hi = m
  }
  return (lo + hi) / 2
}

export interface ShellMeshData {
  positions: Float32Array
  normals: Float32Array
  uvs: Float32Array
  /** Groove factor per vertex (for shading). */
  grooves: Float32Array
  indices: Uint32Array
}

/** Parametric shell mesh with analytic (finite-difference) normals; seam at the back. */
export function buildShellMesh(shape: PumpkinShape, segU = 128, segV = 96): ShellMeshData {
  const nu = segU + 1
  const nv = segV + 1
  const positions = new Float32Array(nu * nv * 3)
  const normals = new Float32Array(nu * nv * 3)
  const uvs = new Float32Array(nu * nv * 2)
  const grooves = new Float32Array(nu * nv)
  const eps = 1e-4
  for (let j = 0; j < nv; j++) {
    const v = j / segV
    const phi = v * Math.PI
    for (let i = 0; i < nu; i++) {
      const u = i / segU
      const theta = u * 2 * Math.PI - Math.PI
      const k = j * nu + i
      const p = shellPoint(shape, theta, phi)
      positions.set(p, k * 3)
      uvs[k * 2] = u
      uvs[k * 2 + 1] = 1 - v
      grooves[k] = shellGroove(shape, theta, phi)
      let n: [number, number, number]
      if (j === 0) n = [0, 1, 0]
      else if (j === segV) n = [0, -1, 0]
      else {
        const pt = shellPoint(shape, theta + eps, phi)
        const pp = shellPoint(shape, theta, phi + eps)
        const tx = pt[0] - p[0]
        const ty = pt[1] - p[1]
        const tz = pt[2] - p[2]
        const fx = pp[0] - p[0]
        const fy = pp[1] - p[1]
        const fz = pp[2] - p[2]
        // outward = dφ × dθ
        let nx = fy * tz - fz * ty
        let ny = fz * tx - fx * tz
        let nz = fx * ty - fy * tx
        const l = Math.hypot(nx, ny, nz) || 1
        nx /= l
        ny /= l
        nz /= l
        // Near the dimpled poles the parametrisation is degenerate; keep the
        // normal pointing away from the centre.
        if (nx * p[0] + ny * p[1] + nz * p[2] < 0) {
          nx = -nx
          ny = -ny
          nz = -nz
        }
        n = [nx, ny, nz]
      }
      normals.set(n, k * 3)
    }
  }
  const indices = new Uint32Array(segU * segV * 6)
  let o = 0
  for (let j = 0; j < segV; j++) {
    for (let i = 0; i < segU; i++) {
      const a = j * nu + i
      const b = a + 1
      const d = a + nu
      const c = d + 1
      indices[o++] = a
      indices[o++] = d
      indices[o++] = c
      indices[o++] = a
      indices[o++] = c
      indices[o++] = b
    }
  }
  return { positions, normals, uvs, grooves, indices }
}

// ---------------------------------------------------------------------------
// Stem

export interface StemParams {
  height: number
  baseRadius: number
  tipRadius: number
  /** Lateral bend at the tip relative to the height. */
  bend: number
  /** Direction of the bend around the y axis (radians, 0 = towards +z). */
  bendDirection: number
  twist: number
  ridges: number
}

export const DEFAULT_STEM: Readonly<StemParams> = Object.freeze({
  height: 0.36,
  baseRadius: 0.11,
  tipRadius: 0.07,
  bend: 0.45,
  bendDirection: 2.2,
  twist: 0.9,
  ridges: 6,
})

export interface SimpleMeshData {
  positions: Float32Array
  uvs: Float32Array
  indices: Uint32Array
}

/** Twisted, ridged, tapering stem rooted in the top dimple. */
export function buildStemMesh(stem: StemParams, shape: PumpkinShape, rings = 18, sides = 28): SimpleMeshData {
  const top = shellPoint(shape, 0, 0)[1]
  const baseY = top - 0.05
  const verts: number[] = []
  const uvs: number[] = []
  const idx: number[] = []
  const bx = Math.sin(stem.bendDirection)
  const bz = Math.cos(stem.bendDirection)
  const centre = (s: number): [number, number, number] => {
    const lateral = stem.bend * stem.height * s * s
    return [bx * lateral, baseY + stem.height * s - 0.25 * lateral * s, bz * lateral]
  }
  for (let r = 0; r <= rings; r++) {
    const s = r / rings
    const c = centre(s)
    const c2 = centre(Math.min(1, s + 0.01))
    const c1 = centre(Math.max(0, s - 0.01))
    // tangent and a stable frame
    let tx = c2[0] - c1[0]
    let ty = c2[1] - c1[1]
    let tz = c2[2] - c1[2]
    const tl = Math.hypot(tx, ty, tz) || 1
    tx /= tl
    ty /= tl
    tz /= tl
    // reference axis x, orthogonalised against the tangent
    let ax = 1 - tx * tx
    let ay = -tx * ty
    let az = -tx * tz
    const al = Math.hypot(ax, ay, az) || 1
    ax /= al
    ay /= al
    az /= al
    const bxv = ty * az - tz * ay
    const byv = tz * ax - tx * az
    const bzv = tx * ay - ty * ax
    const flare = 1 + 0.9 * Math.exp(-s * 9)
    const radius = lerp(stem.baseRadius, stem.tipRadius, Math.pow(s, 0.7)) * flare
    for (let k = 0; k <= sides; k++) {
      const a = (k / sides) * Math.PI * 2 + stem.twist * s
      const ridge = 1 + 0.16 * Math.pow(Math.abs(Math.cos((stem.ridges * a) / 2)), 0.6) - 0.08
      const rr = radius * ridge
      const ca = Math.cos(a) * rr
      const sa = Math.sin(a) * rr
      verts.push(c[0] + ax * ca + bxv * sa, c[1] + ay * ca + byv * sa, c[2] + az * ca + bzv * sa)
      uvs.push(k / sides, s)
    }
  }
  const row = sides + 1
  for (let r = 0; r < rings; r++) {
    for (let k = 0; k < sides; k++) {
      const a = r * row + k
      const b = a + 1
      const d = a + row
      const c = d + 1
      idx.push(a, b, c, a, c, d)
    }
  }
  // cap
  const tip = centre(1)
  const capIndex = verts.length / 3
  verts.push(tip[0], tip[1] + 0.012, tip[2])
  uvs.push(0.5, 1)
  for (let k = 0; k < sides; k++) idx.push(rings * row + k, rings * row + k + 1, capIndex)
  return { positions: new Float32Array(verts), uvs: new Float32Array(uvs), indices: new Uint32Array(idx) }
}

// ---------------------------------------------------------------------------
// Personalised anatomy

const ratio = (value: number, ref: number) => (ref !== 0 ? value / ref : 1)

/** Pumpkin proportions derived from face proportions (CARVE). */
export function pumpkinShapeFromParams(p: PumpkinFaceParams | null): PumpkinShape {
  if (!p) return { ...DEFAULT_PUMPKIN_SHAPE }
  const hash = hashNumbers(paramsSignature(p))
  const aspect = ratio(p.faceAspect, REFERENCE_FACE.faceAspect)
  const jaw = ratio(p.jawRatio, REFERENCE_FACE.jawRatio)
  const forehead = ratio(p.foreheadRatio, REFERENCE_FACE.foreheadRatio)
  return {
    radiusX: 1,
    radiusY: clamp(0.84 * Math.pow(aspect, 2.4), 0.7, 1.0),
    radiusZ: 0.97,
    ribs: 8 + (hash % 5),
    ribDepth: clamp(0.06 + (((hash >>> 3) % 100) / 100) * 0.03, 0.05, 0.095),
    ribSharpness: 0.5 + (((hash >>> 9) % 100) / 100) * 0.2,
    ribPhase: 0,
    topDimple: clamp(0.2 + (forehead - 1) * 0.35, 0.12, 0.3),
    bottomDimple: 0.12,
    bulge: clamp(0.05 + (jaw - 1) * 0.8, -0.03, 0.16),
    bulgeHeight: Math.PI * (jaw >= 1 ? 0.6 : 0.52),
    wobble: 0.012 + (((hash >>> 15) % 100) / 100) * 0.016,
    seed: (hash % 997) / 97,
  }
}

export function stemFromParams(p: PumpkinFaceParams | null): StemParams {
  if (!p) return { ...DEFAULT_STEM }
  const hash = hashNumbers(paramsSignature(p).slice(4))
  const browTilt = p.brows.left.angle - p.brows.right.angle
  return {
    height: clamp(0.3 + (ratio(p.foreheadRatio, REFERENCE_FACE.foreheadRatio) - 1) * 0.4, 0.22, 0.46),
    baseRadius: clamp(0.1 * ratio(p.nose.width, REFERENCE_FACE.noseWidth), 0.075, 0.14),
    tipRadius: 0.065,
    bend: clamp(0.3 + Math.abs(browTilt) * 2, 0.2, 0.8),
    bendDirection: (browTilt >= 0 ? 1 : -1) * (1.3 + ((hash % 100) / 100) * 1.2),
    twist: 0.5 + ((hash >>> 7) % 100) / 100,
    ridges: 5 + ((hash >>> 13) % 3),
  }
}

// ---------------------------------------------------------------------------
// Carving layout

export type FeatureId = 'eyeLeft' | 'eyeRight' | 'browLeft' | 'browRight' | 'nose' | 'mouth'

export const FEATURE_ORDER: readonly FeatureId[] = ['eyeLeft', 'eyeRight', 'nose', 'browLeft', 'browRight', 'mouth']

export interface CarvedFeature {
  id: FeatureId
  /** Closed, counter-clockwise outline in object x/y. */
  outline: Vec2[]
  centroid: Vec2
}

export interface CarveLayout {
  features: CarvedFeature[]
  bounds: Bounds2
}

export interface CarveStyle {
  /** 1 = literal positions (LIVE registration); >1 caricatures deviations from the average face. */
  exaggeration: number
  /** Object units per face-width unit. */
  faceScale: number
  /** Object-space position of the eye midpoint (y is multiplied by radiusY). */
  anchorY: number
  eyeScale: number
  eyeOpenGain: number
  /** Minimum carved eye height / width (a "closed" eye is still a glowing slit). */
  eyeMinSlit: number
  eyeMaxOpen: number
  /** 0 = almond, 1 = triangle. */
  eyeTriangle: number
  /** Extra outward-up tilt (radians) for a jack-o'-lantern look. */
  eyeTiltBias: number
  browScale: number
  /** Object units. */
  browThickness: number
  browAngleGain: number
  noseScale: number
  mouthScale: number
  mouthOpenGain: number
  /** Minimum mouth thickness / width. */
  mouthMinHeight: number
  /** Base grin added to the measured corner lift (relative to width). */
  grinBias: number
  /** Share of the mouth opening above the lip line (0.5 = centred on the lips, used for LIVE registration). */
  mouthUpperShare: number
  smileGain: number
  /** Personalised tooth count (CARVE) vs fixed layout (LIVE, avoids popping). */
  personalTeeth: boolean
  samples: number
  /** Features must stay inside this fraction of the front ellipse. */
  fitRadius: number
}

// LIVE "pumpkin head": the pumpkin is sized and centred on the whole head
// (chin to top of hair, ears included), not just the face. Head proportions
// from the canonical face (unit = face width, origin = eye midpoint):
// chin ≈ -0.79, skull top ≈ +0.72, + hair; head width with ears/hair ≈ 1.3.
/** LIVE: pumpkin half-width in face widths. */
export const LIVE_HEAD_SCALE = 1.08
/** LIVE: centre of the head (chin..hair top) above the eye line, in face widths. */
export const LIVE_HEAD_CENTER_Y = 0.03
/** LIVE: slightly taller pumpkin with a shallower crown so the skull top stays covered. */
export const LIVE_PUMPKIN_SHAPE: Readonly<PumpkinShape> = Object.freeze({
  ...DEFAULT_PUMPKIN_SHAPE,
  radiusY: 0.93,
  topDimple: 0.14,
})

export const LIVE_STYLE: Readonly<CarveStyle> = Object.freeze({
  exaggeration: 1,
  // features stay registered to the real eyes / nose / mouth on the bigger head
  faceScale: 1 / LIVE_HEAD_SCALE,
  anchorY: -LIVE_HEAD_CENTER_Y / LIVE_HEAD_SCALE / LIVE_PUMPKIN_SHAPE.radiusY,
  eyeScale: 1.9,
  eyeOpenGain: 1.8,
  eyeMinSlit: 0.07,
  eyeMaxOpen: 0.95,
  eyeTriangle: 0.5,
  eyeTiltBias: 0.05,
  browScale: 1.25,
  browThickness: 0.05,
  browAngleGain: 1.4,
  noseScale: 1.4,
  mouthScale: 1.7,
  mouthOpenGain: 1.25,
  mouthMinHeight: 0.13,
  grinBias: 0.05,
  mouthUpperShare: 0.5,
  smileGain: 1.3,
  personalTeeth: false,
  samples: 28,
  fitRadius: 0.8,
})

export const CARVE_STYLE: Readonly<CarveStyle> = Object.freeze({
  exaggeration: 1.9,
  faceScale: 1.42,
  anchorY: 0.2,
  eyeScale: 1.75,
  eyeOpenGain: 1.9,
  eyeMinSlit: 0.09,
  eyeMaxOpen: 0.9,
  eyeTriangle: 0.7,
  eyeTiltBias: 0.08,
  browScale: 1.2,
  browThickness: 0.06,
  browAngleGain: 1.9,
  noseScale: 1.4,
  mouthScale: 1.6,
  mouthOpenGain: 1.4,
  mouthMinHeight: 0.16,
  grinBias: 0.07,
  mouthUpperShare: 0.36,
  smileGain: 1.5,
  personalTeeth: true,
  samples: 44,
  fitRadius: 0.8,
})

/** Caricature helpers: additive for positions / angles, multiplicative for sizes. */
const exagAdd = (value: number, ref: number, k: number) => ref + (value - ref) * k
const exagMul = (value: number, ref: number, k: number) => (value > 0 && ref > 0 ? ref * Math.pow(value / ref, k) : value)

function warp(t: number, peak: number): number {
  return t < peak ? (0.5 * t) / peak : 0.5 + (0.5 * (t - peak)) / (1 - peak)
}

interface EyeSpec {
  centre: Vec2
  width: number
  height: number
  tilt: number
  peak: number
  upperShare: number
  side: -1 | 1
}

function eyeOutline(e: EyeSpec, triangle: number, n: number): Vec2[] {
  const ct = Math.cos(e.tilt)
  const st = Math.sin(e.tilt)
  const ax = e.side * ct
  const ay = st
  const nx = -e.side * st
  const ny = ct
  const point = (t: number, h: number): Vec2 => {
    const along = (t - 0.5) * e.width
    return v2(e.centre.x + ax * along + nx * h, e.centre.y + ay * along + ny * h)
  }
  const up = e.height * e.upperShare
  const lo = e.height * (1 - e.upperShare)
  const out: Vec2[] = []
  for (let i = 0; i <= n; i++) {
    const t = i / n
    const almond = Math.pow(Math.sin(Math.PI * warp(t, e.peak)), 0.85)
    const tri = t < e.peak ? t / e.peak : (1 - t) / (1 - e.peak)
    out.push(point(t, up * lerp(almond, tri, triangle)))
  }
  for (let i = n - 1; i >= 1; i--) {
    const t = i / n
    const s = Math.sin(Math.PI * t)
    out.push(point(t, -lo * lerp(Math.pow(s, 0.9), Math.pow(s, 1.8), triangle * 0.6)))
  }
  return out
}

function browOutline(inner: Vec2, outer: Vec2, arch: number, thickness: number, n: number): Vec2[] {
  const dx = outer.x - inner.x
  const dy = outer.y - inner.y
  const length = Math.hypot(dx, dy) || 1
  let nx = -dy / length
  let ny = dx / length
  if (ny < 0) {
    nx = -nx
    ny = -ny
  }
  const centre = (t: number): Vec2 => {
    const h = arch * length * 4 * t * (1 - t)
    return v2(inner.x + dx * t + nx * h, inner.y + dy * t + ny * h)
  }
  const top: Vec2[] = []
  const bottom: Vec2[] = []
  for (let i = 0; i <= n; i++) {
    const t = i / n
    const c = centre(t)
    const a = centre(Math.max(0, t - 0.01))
    const b = centre(Math.min(1, t + 0.01))
    const tx = b.x - a.x
    const ty = b.y - a.y
    const tl = Math.hypot(tx, ty) || 1
    let px = -ty / tl
    let py = tx / tl
    if (py < 0) {
      px = -px
      py = -py
    }
    const th = thickness * Math.pow(Math.sin(Math.PI * (0.05 + 0.95 * t)), 0.55) * (1.1 - 0.45 * t)
    top.push(v2(c.x + (px * th) / 2, c.y + (py * th) / 2))
    bottom.push(v2(c.x - (px * th) / 2, c.y - (py * th) / 2))
  }
  // The outer tip is a single point (thickness 0).
  return [...top, ...bottom.slice(0, -1).reverse()]
}

interface NoseSpec {
  apex: Vec2
  baseY: number
  baseCentreX: number
  halfWidth: number
  tilt: number
  notch: number
  corner: number
}

function noseOutline(s: NoseSpec, n: number): Vec2[] {
  const ct = Math.cos(s.tilt)
  const st = Math.sin(s.tilt)
  const bl = v2(s.baseCentreX - s.halfWidth * ct, s.baseY - s.halfWidth * st)
  const br = v2(s.baseCentreX + s.halfWidth * ct, s.baseY + s.halfWidth * st)
  const A = s.apex
  // Corner-rounded triangle: walk the three edges, replacing each corner by a quadratic arc.
  const corners = [A, bl, br]
  const out: Vec2[] = []
  const r = s.corner
  for (let c = 0; c < 3; c++) {
    const P = corners[c]!
    const prev = corners[(c + 2) % 3]!
    const next = corners[(c + 1) % 3]!
    const dPrev = Math.hypot(prev.x - P.x, prev.y - P.y) || 1
    const dNext = Math.hypot(next.x - P.x, next.y - P.y) || 1
    const rr = Math.min(r, dPrev * 0.3, dNext * 0.3)
    const p0 = v2(P.x + ((prev.x - P.x) / dPrev) * rr, P.y + ((prev.y - P.y) / dPrev) * rr)
    const p2 = v2(P.x + ((next.x - P.x) / dNext) * rr, P.y + ((next.y - P.y) / dNext) * rr)
    for (let i = 0; i <= 4; i++) {
      const t = i / 4
      const a = (1 - t) * (1 - t)
      const b = 2 * (1 - t) * t
      const d = t * t
      out.push(v2(a * p0.x + b * P.x + d * p2.x, a * p0.y + b * P.y + d * p2.y))
    }
    // straight run to the next corner (the base edge gets the nostril notch)
    const q0 = p2
    const nextLen = Math.hypot(next.x - P.x, next.y - P.y) || 1
    const rrNext = Math.min(r, nextLen * 0.3)
    const q1 = v2(next.x + ((P.x - next.x) / nextLen) * rrNext, next.y + ((P.y - next.y) / nextLen) * rrNext)
    const isBase = c === 1
    for (let i = 1; i < n; i++) {
      const t = i / n
      const x = lerp(q0.x, q1.x, t)
      let y = lerp(q0.y, q1.y, t)
      if (isBase) y += s.notch * Math.sin(Math.PI * t)
      out.push(v2(x, y))
    }
  }
  return out
}

interface Tooth {
  t0: number
  t1: number
  /** fraction of local mouth thickness */
  height: number
}

interface MouthSpec {
  centre: Vec2
  halfWidth: number
  liftLeft: number
  liftRight: number
  thickness: number
  upperShare: number
  topTeeth: Tooth[]
  bottomTeeth: Tooth[]
}

function mouthOutline(m: MouthSpec, n: number): Vec2[] {
  const mid = (t: number) => m.centre.y + (t < 0 ? m.liftLeft : m.liftRight) * Math.pow(Math.abs(t), 1.6)
  const thick = (t: number) => m.thickness * Math.pow(Math.max(0, 1 - t * t), 0.62)
  const topY = (t: number) => mid(t) + thick(t) * m.upperShare
  const botY = (t: number) => mid(t) - thick(t) * (1 - m.upperShare)
  const X = (t: number) => m.centre.x + t * m.halfWidth

  /**
   * Samples one lip edge from `from` to `to`. Teeth are notches of flesh that
   * protrude into the opening by `height` × local thickness (dir = -1 hangs
   * down from the top edge, +1 rises from the bottom edge) with tapered tips.
   */
  const edge = (from: number, to: number, base: (t: number) => number, teeth: Tooth[], dir: 1 | -1): Vec2[] => {
    const forward = to > from
    const ts = new Set<number>()
    for (let i = 0; i <= n; i++) ts.add(from + ((to - from) * i) / n)
    for (const th of teeth) {
      ts.add(th.t0)
      ts.add(th.t1)
    }
    const sorted = [...ts].sort((a, b) => (forward ? a - b : b - a))
    const pts: Vec2[] = []
    for (const t of sorted) {
      const tooth = teeth.find((th) => t >= th.t0 && t <= th.t1)
      if (!tooth) {
        pts.push(v2(X(t), base(t)))
        continue
      }
      const h = dir * tooth.height * thick((tooth.t0 + tooth.t1) / 2)
      const taper = (tooth.t1 - tooth.t0) * 0.14
      if (t === tooth.t0 || t === tooth.t1) {
        const tipT = t === tooth.t0 ? t + taper : t - taper
        const entering = forward ? t === tooth.t0 : t === tooth.t1
        if (entering) {
          pts.push(v2(X(t), base(t)))
          pts.push(v2(X(tipT), base(tipT) + h))
        } else {
          pts.push(v2(X(tipT), base(tipT) + h))
          pts.push(v2(X(t), base(t)))
        }
      } else if (t > tooth.t0 + taper && t < tooth.t1 - taper) {
        pts.push(v2(X(t), base(t) + h))
      }
    }
    return pts
  }
  // top edge left -> right (teeth hang down), bottom edge right -> left (teeth point up)
  const top = edge(-1, 1, topY, m.topTeeth, -1)
  const bottom = edge(1, -1, botY, m.bottomTeeth, 1)
  return [...top, ...bottom.slice(1, -1)]
}

function dedupe(poly: Vec2[], eps = 1e-5): Vec2[] {
  const out: Vec2[] = []
  for (const p of poly) {
    const last = out[out.length - 1]
    if (!last || Math.abs(last.x - p.x) > eps || Math.abs(last.y - p.y) > eps) out.push(p)
  }
  while (out.length > 2) {
    const a = out[0]!
    const b = out[out.length - 1]!
    if (Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps) out.pop()
    else break
  }
  return out
}

function finalize(id: FeatureId, poly: Vec2[]): CarvedFeature {
  let outline = dedupe(poly)
  if (polygonArea(outline) < 0) outline = outline.reverse()
  return { id, outline, centroid: polygonCentroid(outline) }
}

/**
 * Picks `count` bottom-teeth positions from `candidates` (centre t values)
 * that never sit under a top tooth, so the opening is never pinched shut.
 */
function placeTeeth(
  count: number,
  halfWidth: number,
  avoid: readonly Tooth[],
  candidates: readonly number[],
  seed: number,
  height: number,
): Tooth[] {
  const out: Tooth[] = []
  const free = (c: number) =>
    [...avoid, ...out].every((t) => c + halfWidth < t.t0 - 0.06 || c - halfWidth > t.t1 + 0.06) && Math.abs(c) + halfWidth < 0.8
  const order = candidates.map((c, i) => ({ c, key: (seed >>> (i * 3)) & 7 })).sort((a, b) => a.key - b.key || a.c - b.c)
  for (const { c } of order) {
    if (out.length >= count) break
    if (free(c)) out.push({ t0: c - halfWidth, t1: c + halfWidth, height })
  }
  return out.sort((a, b) => a.t0 - b.t0)
}

/**
 * Builds the personalised carving outlines. Shared by LIVE (exaggeration 1,
 * registered to the real feature positions) and CARVE (caricatured).
 */
export function buildCarveLayout(
  params: PumpkinFaceParams,
  style: CarveStyle,
  expression: ExpressionState = NEUTRAL_EXPRESSION,
  shape: PumpkinShape = DEFAULT_PUMPKIN_SHAPE,
): CarveLayout {
  const k = style.exaggeration
  const R = REFERENCE_FACE
  const s = style.faceScale
  const anchor = v2(0, style.anchorY * shape.radiusY)
  const toObj = (u: number, v: number): Vec2 => v2(anchor.x + u * s, anchor.y + v * s)

  // ----- eyes
  const eyeSpec = (side: 'left' | 'right', blink: number): EyeSpec => {
    const e = params.eyes[side]
    const sign = side === 'left' ? -1 : 1
    const refX = (sign * R.eyeSpacing) / 2
    const cx = exagAdd(e.center.x, refX, k)
    const cy = exagAdd(e.center.y, R.eyeCenterY, k)
    const width = exagMul(e.width, R.eyeWidth, k) * s * style.eyeScale
    const openness = exagMul(Math.max(0.01, e.openness), R.eyeOpenness, k) * (1 - smoothstep(0.35, 0.85, blink))
    const height = width * clamp(openness * style.eyeOpenGain, style.eyeMinSlit, style.eyeMaxOpen)
    const total = e.upperArch + e.lowerArch || 1
    return {
      centre: toObj(cx, cy),
      width,
      height,
      tilt: exagAdd(e.tilt, R.eyeTilt, k) + style.eyeTiltBias,
      peak: clamp(e.peak, 0.3, 0.7),
      upperShare: clamp(e.upperArch / total, 0.45, 0.8),
      side: sign as -1 | 1,
    }
  }
  const eyeL = eyeSpec('left', expression.blinkLeft)
  const eyeR = eyeSpec('right', expression.blinkRight)
  // keep a bridge between the eyes (proportional to the face scale: 0.12 for CARVE)
  const minBridge = 0.085 * style.faceScale
  const innerL = eyeL.centre.x + eyeL.width / 2
  const innerR = eyeR.centre.x - eyeR.width / 2
  if (innerR - innerL < minBridge) {
    const avail = eyeR.centre.x - eyeL.centre.x - minBridge
    const f = clamp((2 * avail) / (eyeL.width + eyeR.width), 0.3, 1)
    eyeL.width *= f
    eyeR.width *= f
    eyeL.height *= f
    eyeR.height *= f
  }
  const eyeTop = (e: EyeSpec) => e.centre.y + e.height * e.upperShare + Math.abs(Math.sin(e.tilt)) * e.width * 0.5
  const eyeBottom = (e: EyeSpec) => e.centre.y - e.height * (1 - e.upperShare) - Math.abs(Math.sin(e.tilt)) * e.width * 0.5

  // ----- brows
  const browSpec = (side: 'left' | 'right', eye: EyeSpec) => {
    const b = params.brows[side]
    const e = params.eyes[side]
    const sign = side === 'left' ? -1 : 1
    // relative to the (exaggerated) eye centre so brows travel with the eyes
    const lift = exagAdd(b.lift, R.browLift, k) + 0.045 * expression.browRaise - 0.02 * expression.browFrown
    const angle =
      R.browAngle +
      (b.angle - R.browAngle) * style.browAngleGain * k * 0.6 +
      0.25 * expression.browFrown -
      0.12 * expression.browRaise
    const length = Math.hypot(b.outer.x - b.inner.x, b.outer.y - b.inner.y) * style.browScale * s
    const innerOffsetX = (b.inner.x - e.center.x) * s * style.browScale
    const innerY = eye.centre.y + lift * s * 1.15
    const inner = v2(eye.centre.x + innerOffsetX * 0.9, innerY + Math.sin(-angle) * length * 0.5 * 0.4)
    const outer = v2(inner.x + sign * Math.cos(angle) * length, inner.y + Math.sin(angle) * length)
    return { inner, outer, arch: clamp(b.arch * (0.7 + 0.3 * k), 0.04, 0.3), thickness: style.browThickness }
  }
  const browL = browSpec('left', eyeL)
  const browR = browSpec('right', eyeR)
  for (const [brow, eye] of [
    [browL, eyeL],
    [browR, eyeR],
  ] as const) {
    const lowest = Math.min(brow.inner.y, brow.outer.y) - brow.thickness * 0.6
    const minY = eyeTop(eye) + 0.05
    if (lowest < minY) {
      const d = minY - lowest
      brow.inner.y += d
      brow.outer.y += d
    }
  }

  // ----- nose
  const n = params.nose
  const noseLen = exagMul(n.length, R.noseLength, k) * s * style.noseScale * 0.62
  const noseHalfW = exagMul(n.width, R.noseWidth, k) * s * style.noseScale * 0.36
  const baseV = exagAdd(n.base.y, R.noseBaseY, k)
  const nosePos = toObj(exagAdd(n.base.x, 0, k) * 0.8, baseV)
  let baseY = nosePos.y
  let apexY = baseY + Math.max(0.1, noseLen)
  const eyeFloor = Math.min(eyeBottom(eyeL), eyeBottom(eyeR)) - 0.04
  if (apexY > eyeFloor) {
    apexY = Math.max(eyeFloor, baseY + 0.1)
    if (apexY > eyeFloor) {
      // the eyes sit low: move the whole nose down
      const d = apexY - eyeFloor
      apexY -= d
      baseY -= d
    }
  }
  const nose: NoseSpec = {
    apex: v2(nosePos.x + exagAdd(n.tip.x, 0, k) * s * 0.35, apexY),
    baseY,
    baseCentreX: nosePos.x,
    halfWidth: clamp(noseHalfW, 0.06, 0.24),
    tilt: n.tilt * k * 0.8,
    notch: style.personalTeeth ? clamp((n.protrusion - 0.17) * 0.6, -0.015, 0.03) : 0,
    corner: 0.025,
  }

  // ----- mouth
  const mo = params.mouth
  const halfWidth = (exagMul(mo.width, R.mouthWidth, k) * s * style.mouthScale) / 2
  const smileBoost = expression.smile * 0.07
  const liftRel = (lift: number) =>
    (exagAdd(lift, R.mouthCornerLift, k) - R.mouthCornerLift + style.grinBias + smileBoost) * style.smileGain
  const openEff = Math.max(Math.max(0, mo.openness - 0.03) * (k > 1 ? 1.15 : 1), expression.mouthOpen * 0.55)
  const thickness = halfWidth * 2 * (style.mouthMinHeight + style.mouthOpenGain * openEff * 0.55)
  const mouthCentre = toObj(exagAdd(mo.center.x, 0, k) * 0.9, exagAdd(mo.center.y, R.mouthCenterY, k))
  let teethTop: Tooth[]
  let teethBottom: Tooth[]
  if (style.personalTeeth) {
    const wide = mo.width / R.mouthWidth
    const asym = clamp((mo.cornerLiftRight - mo.cornerLiftLeft) * 6, -0.25, 0.25)
    const hash = hashNumbers([mo.width, mo.openness, mo.bow, mo.upperLip])
    const nTop = wide > 1.04 ? 2 : 1 + (hash % 2)
    const nBottom = mo.openness > 0.12 ? 2 : (hash >>> 4) % 2
    const tw = clamp(0.11 + (wide - 1) * 0.05, 0.08, 0.15)
    teethTop =
      nTop === 1
        ? [{ t0: asym - tw, t1: asym + tw, height: 0.42 }]
        : [
            { t0: -0.36 + asym, t1: -0.36 + asym + 2 * tw * 0.9, height: 0.4 },
            { t0: 0.2 + asym, t1: 0.2 + asym + 2 * tw * 0.9, height: 0.44 },
          ]
    teethBottom = placeTeeth(nBottom, tw * 0.85, teethTop, [-0.12, 0.38, -0.42, 0.12, -0.3, 0.25], hash >>> 8, 0.36)
  } else {
    teethTop = [
      { t0: -0.4, t1: -0.2, height: 0.4 },
      { t0: 0.2, t1: 0.4, height: 0.4 },
    ]
    teethBottom = [{ t0: -0.1, t1: 0.1, height: 0.36 }]
  }
  const mouth: MouthSpec = {
    centre: mouthCentre,
    halfWidth: clamp(halfWidth, 0.18, 0.62),
    liftLeft: clamp(liftRel(mo.cornerLiftLeft), -0.18, 0.3) * halfWidth * 2,
    liftRight: clamp(liftRel(mo.cornerLiftRight), -0.18, 0.3) * halfWidth * 2,
    thickness: clamp(thickness, 0.05, 0.5),
    upperShare: style.mouthUpperShare,
    topTeeth: teethTop,
    bottomTeeth: teethBottom,
  }
  // keep the mouth below the nose
  const mouthTopCentre = mouth.centre.y + mouth.thickness * mouth.upperShare + Math.max(0, Math.max(mouth.liftLeft, mouth.liftRight)) * Math.pow(0.4, 1.6)
  const noseFloor = nose.baseY - 0.06
  if (mouthTopCentre > noseFloor) mouth.centre.y -= mouthTopCentre - noseFloor
  // corners must not climb into the eyes
  const cornerCeil = Math.min(eyeBottom(eyeL), eyeBottom(eyeR)) - 0.05
  const maxLift = cornerCeil - mouth.centre.y
  mouth.liftLeft = Math.min(mouth.liftLeft, maxLift)
  mouth.liftRight = Math.min(mouth.liftRight, maxLift)

  const ns = style.samples
  let features: CarvedFeature[] = [
    finalize('eyeLeft', eyeOutline(eyeL, style.eyeTriangle, Math.round(ns * 0.6))),
    finalize('eyeRight', eyeOutline(eyeR, style.eyeTriangle, Math.round(ns * 0.6))),
    finalize('browLeft', browOutline(browL.inner, browL.outer, browL.arch, browL.thickness, Math.round(ns * 0.45))),
    finalize('browRight', browOutline(browR.inner, browR.outer, browR.arch, browR.thickness, Math.round(ns * 0.45))),
    finalize('nose', noseOutline(nose, Math.max(4, Math.round(ns * 0.15)))),
    finalize('mouth', mouthOutline(mouth, ns)),
  ]

  // Fit everything inside the carvable front region.
  let worst = 0
  for (const f of features) {
    for (const p of f.outline) {
      const r = Math.hypot(p.x / shape.radiusX, p.y / shape.radiusY)
      if (r > worst) worst = r
    }
  }
  if (worst > style.fitRadius) {
    const f = style.fitRadius / worst
    features = features.map((feat) =>
      finalize(
        feat.id,
        feat.outline.map((p) => v2(p.x * f, p.y * f)),
      ),
    )
  }

  // Drop anything degenerate rather than rendering a broken hole.
  features = features.filter((f) => f.outline.length >= 3 && Math.abs(polygonArea(f.outline)) > 1e-5)
  const all = features.flatMap((f) => f.outline)
  return { features, bounds: polygonBounds(all.length ? all : [v2(0, 0)]) }
}

/** Scales an outline about its centroid (carve-in animation / tracking pop-in). */
export function scaleOutline(outline: readonly Vec2[], centroid: Vec2, s: number): Vec2[] {
  return outline.map((p) => v2(centroid.x + (p.x - centroid.x) * s, centroid.y + (p.y - centroid.y) * s))
}

export function layoutIsValid(layout: CarveLayout): boolean {
  return layout.features.every((f) => isSimplePolygon(f.outline) && polygonArea(f.outline) > 0)
}

// ---------------------------------------------------------------------------
// Cut walls

export interface WallMeshData {
  positions: Float32Array
  /** 0 at the outer skin, 1 at the inner edge (drives the flesh glow gradient). */
  depth: Float32Array
  indices: Uint32Array
  vertexCount: number
  indexCount: number
}

/**
 * Extrudes each outline from the outer surface radially inwards by
 * `thickness`, producing the visible cut faces of the carving. Points outside
 * the silhouette are skipped (the layout fit keeps that from happening).
 */
export function buildCutWalls(
  shape: PumpkinShape,
  outlines: ReadonlyArray<readonly Vec2[]>,
  thickness: number,
  target?: WallMeshData,
): WallMeshData {
  let vCount = 0
  let iCount = 0
  for (const o of outlines) {
    vCount += o.length * 2
    iCount += o.length * 6
  }
  const data: WallMeshData =
    target && target.positions.length >= vCount * 3 && target.indices.length >= iCount
      ? target
      : {
          positions: new Float32Array(Math.max(vCount, 1) * 3),
          depth: new Float32Array(Math.max(vCount, 1)),
          indices: new Uint32Array(Math.max(iCount, 1)),
          vertexCount: 0,
          indexCount: 0,
        }
  let v = 0
  let ii = 0
  for (const outline of outlines) {
    const n = outline.length
    if (n < 3) continue
    const start = v
    let ok = true
    for (let i = 0; i < n; i++) {
      const p = outline[i]!
      const z = frontSurfaceZ(shape, p.x, p.y)
      if (z === null) {
        ok = false
        break
      }
      // a hair outside the skin so no seam shows between wall and shell
      const r = Math.hypot(p.x, p.y, z)
      const outerScale = (r + 0.002) / r
      const innerScale = Math.max(0.05, (r - thickness) / r)
      data.positions[(v + 0) * 3] = p.x * outerScale
      data.positions[(v + 0) * 3 + 1] = p.y * outerScale
      data.positions[(v + 0) * 3 + 2] = z * outerScale
      data.positions[(v + 1) * 3] = p.x * innerScale
      data.positions[(v + 1) * 3 + 1] = p.y * innerScale
      data.positions[(v + 1) * 3 + 2] = z * innerScale
      data.depth[v] = 0
      data.depth[v + 1] = 1
      v += 2
    }
    if (!ok) {
      v = start
      continue
    }
    for (let i = 0; i < n; i++) {
      const o0 = start + i * 2
      const i0 = o0 + 1
      const o1 = start + ((i + 1) % n) * 2
      const i1 = o1 + 1
      data.indices[ii++] = o0
      data.indices[ii++] = i0
      data.indices[ii++] = i1
      data.indices[ii++] = o0
      data.indices[ii++] = i1
      data.indices[ii++] = o1
    }
  }
  data.vertexCount = v
  data.indexCount = ii
  return data
}

export interface LayoutMetrics {
  eyeSpacing: number
  eyeLeftWidth: number
  eyeLeftHeight: number
  eyeRightWidth: number
  eyeRightHeight: number
  browLeftSlope: number
  browRightSlope: number
  noseWidth: number
  noseHeight: number
  mouthWidth: number
  mouthHeight: number
  mouthArea: number
  mouthCentreY: number
}

/** Scalar summary used by tests / debugging: distinctive geometric measurements of a layout. */
export function layoutMetrics(layout: CarveLayout): LayoutMetrics {
  const get = (id: FeatureId) => layout.features.find((f) => f.id === id)
  const b = (id: FeatureId) => {
    const f = get(id)
    return f ? polygonBounds(f.outline) : { minX: 0, minY: 0, maxX: 0, maxY: 0 }
  }
  const eL = b('eyeLeft')
  const eR = b('eyeRight')
  const m = b('mouth')
  const nB = b('nose')
  const brL = get('browLeft')
  const brR = get('browRight')
  const slope = (f: CarvedFeature | undefined, side: -1 | 1) => {
    if (!f) return 0
    // compare the inner-most and outer-most points
    let inner = f.outline[0]!
    let outer = f.outline[0]!
    for (const p of f.outline) {
      if (side * p.x < side * inner.x) inner = p
      if (side * p.x > side * outer.x) outer = p
    }
    return Math.atan2(outer.y - inner.y, Math.abs(outer.x - inner.x))
  }
  const eyeL = get('eyeLeft')
  const eyeR = get('eyeRight')
  return {
    eyeSpacing: (eyeR ? eyeR.centroid.x : 0) - (eyeL ? eyeL.centroid.x : 0),
    eyeLeftWidth: eL.maxX - eL.minX,
    eyeLeftHeight: eL.maxY - eL.minY,
    eyeRightWidth: eR.maxX - eR.minX,
    eyeRightHeight: eR.maxY - eR.minY,
    browLeftSlope: slope(brL, -1),
    browRightSlope: slope(brR, 1),
    noseWidth: nB.maxX - nB.minX,
    noseHeight: nB.maxY - nB.minY,
    mouthWidth: m.maxX - m.minX,
    mouthHeight: m.maxY - m.minY,
    mouthArea: Math.abs(polygonArea(get('mouth')?.outline ?? [])),
    mouthCentreY: get('mouth')?.centroid.y ?? 0,
  }
}

/** Fraction of a feature that is carved (used by the CARVE timeline). */
/** MAKE animation timeline (seconds) for a single pumpkin. */
export const CARVE_TIMELINE = {
  revealStart: 0.45,
  revealEnd: 1.6,
  carveStart: 1.55,
  carveStagger: 0.3,
  carveDuration: 0.5,
  igniteStart: 3.45,
  igniteEnd: 4.3,
  end: 4.9,
} as const

export type CarveTimeline = { -readonly [K in keyof typeof CARVE_TIMELINE]: number }

/**
 * Timeline for a group: person i starts carving `i * stagger` later, so
 * ignition and the end are pushed back until the last pumpkin is carved.
 */
export function carveTimeline(count: number, stagger = 0.14, maxCount = 4): CarveTimeline {
  const extra = Math.max(0, Math.min(maxCount, Math.floor(count)) - 1) * stagger
  const T = CARVE_TIMELINE
  return { ...T, igniteStart: T.igniteStart + extra, igniteEnd: T.igniteEnd + extra, end: T.end + extra }
}

export function carveProgress(time: number, index: number, start: number, stagger: number, duration: number): number {
  return clamp01((time - start - index * stagger) / duration)
}
