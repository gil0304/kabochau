import { describe, expect, it } from 'vitest'
import { boundsCenter, coverageFit, projectedEllipse, smoothCoverage, type CoverageFit } from '../app/utils/headCoverage'

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1]
const pitch = (a: number) => [1, 0, 0, 0, Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a)]
const inside = (q: { xx: number; xy: number; yy: number }, x: number, y: number) => q.xx * x * x + 2 * q.xy * x * y + q.yy * y * y

describe('projectedEllipse', () => {
  it('projects an upright ellipsoid to its x/y radii (with margin)', () => {
    const q = projectedEllipse(IDENTITY, [1, 0.93, 0.97], 2, 1)!
    expect(inside(q, 2, 0)).toBeCloseTo(1, 9)
    expect(inside(q, 0, 1.86)).toBeCloseTo(1, 9)
    const m = projectedEllipse(IDENTITY, [1, 0.93, 0.97], 2, 0.9)!
    expect(inside(m, 1.8, 0)).toBeCloseTo(1, 9)
  })

  it('accounts for a pitched head (the silhouette mixes y and z radii)', () => {
    const q = projectedEllipse(pitch(Math.PI / 2), [1, 0.5, 2], 1, 1)!
    // rotated 90° about x: screen height now comes from the z radius
    expect(inside(q, 0, 2)).toBeCloseTo(1, 9)
  })
})

const fitCenter = (center: { x: number; y: number }, target: { x: number; y: number }, fit: CoverageFit) => ({
  x: center.x + (target.x - center.x) * fit.shift,
  y: center.y + (target.y - center.y) * fit.shift,
})

describe('coverageFit', () => {
  const quad = projectedEllipse(IDENTITY, [1, 0.93, 0.97], 1, 0.9)!

  it('changes nothing when the whole face is already inside', () => {
    const face = [
      { x: -0.4, y: 0.1 },
      { x: 0.4, y: 0.1 },
      { x: 0, y: -0.6 },
    ]
    expect(coverageFit(face, { x: 0, y: 0 }, boundsCenter(face), quad)).toEqual({ shift: 0, grow: 1 })
  })

  it('slides just enough toward the face to cover a chin poking out below', () => {
    const center = { x: 0, y: 0.3 } // pumpkin swung up (looking down)
    const face = [
      { x: -0.35, y: 0.25 },
      { x: 0.35, y: 0.25 },
      { x: 0, y: -0.7 },
    ]
    const target = boundsCenter(face)
    const fit = coverageFit(face, center, target, quad)
    expect(fit.grow).toBe(1)
    expect(fit.shift).toBeGreaterThan(0)
    expect(fit.shift).toBeLessThan(1)
    const c = fitCenter(center, target, fit)
    for (const p of face) expect(inside(quad, p.x - c.x, p.y - c.y)).toBeLessThanOrEqual(1 + 1e-6)
    const less = fitCenter(center, target, { shift: fit.shift * 0.95, grow: 1 })
    expect(face.some((p) => inside(quad, p.x - less.x, p.y - less.y) > 1)).toBe(true)
  })

  it('grows only when sliding is not enough, and caps the growth', () => {
    const face = [
      { x: -1.2, y: 0 },
      { x: 1.2, y: 0 },
    ]
    const fit = coverageFit(face, { x: 0, y: 0.2 }, boundsCenter(face), quad)
    expect(fit.shift).toBe(1)
    expect(fit.grow).toBeGreaterThan(1.2)
    expect(coverageFit([{ x: 0, y: -50 }], { x: 0, y: 0 }, { x: 0, y: 0 }, quad, 1.4).grow).toBe(1.4)
  })
})

describe('smoothCoverage', () => {
  it('grows immediately and shrinks back gradually', () => {
    expect(smoothCoverage(1, 1.3, 0.016)).toBe(1.3)
    const s = smoothCoverage(1.3, 1, 0.016)
    expect(s).toBeLessThan(1.3)
    expect(s).toBeGreaterThan(1.25)
    let v = 1.3
    for (let i = 0; i < 300; i++) v = smoothCoverage(v, 1, 0.016)
    expect(v).toBeCloseTo(1, 3)
  })
})

// End-to-end placement math of the LIVE compositor on the canonical face mesh:
// the face is pitched down, the pumpkin is pinned at the eye midpoint exactly
// as liveCompositor.layoutFrame does, and every landmark must be covered.
import { normalizeLandmarks } from '../app/utils/faceMapping'
import { LIVE_PUMPKIN_SHAPE, LIVE_STYLE, frontSurfaceZ } from '../app/utils/pumpkinGeometry'
import { canonicalVertices, projectToLandmarks } from './helpers/faceFixture'

function livePlacement(pitchRad: number, yawRad = 0) {
  const W = 1280
  const H = 720
  const lm = projectToLandmarks(canonicalVertices(), { pitch: pitchRad, yaw: yawRad, imageWidth: W, imageHeight: H, scale: 16 })
  const face = normalizeLandmarks(lm, W, H, false)!
  const f = face.frame
  const x = f.xAxis
  const y = f.yAxis
  const z = { x: x.y * y.z - x.z * y.y, y: x.z * y.x - x.x * y.z, z: x.x * y.y - x.y * y.x }
  const rotation = [x.x, y.x, z.x, x.y, y.y, z.y, x.z, y.z, z.z]
  const s = f.faceWidthPx / LIVE_STYLE.faceScale
  const ay = LIVE_STYLE.anchorY * LIVE_PUMPKIN_SHAPE.radiusY
  const pin = [0, ay, frontSurfaceZ(LIVE_PUMPKIN_SHAPE, 0, ay) ?? 0.9]
  const off = [0, 1, 2].map((r) => (rotation[r * 3]! * pin[0]! + rotation[r * 3 + 1]! * pin[1]! + rotation[r * 3 + 2]! * pin[2]!) * s)
  const anchor = { x: f.originNorm.x * W, y: -f.originNorm.y * H }
  const center = { x: anchor.x - off[0]!, y: anchor.y - off[1]! }
  const points = lm.slice(0, 468).map((l) => ({ x: l.x * W, y: -l.y * H }))
  const quad = projectedEllipse(rotation, [LIVE_PUMPKIN_SHAPE.radiusX, LIVE_PUMPKIN_SHAPE.radiusY, LIVE_PUMPKIN_SHAPE.radiusZ], s, 0.88)!
  const target = boundsCenter(points)
  const allInside = (fit: CoverageFit) => {
    const c = fitCenter(center, target, fit)
    return points.every((p) => inside(quad, p.x - c.x, p.y - c.y) <= fit.grow * fit.grow + 1e-6)
  }
  return { fit: coverageFit(points, center, target, quad), allInside, anchor, s }
}

describe('LIVE head coverage on the canonical face', () => {
  it('changes nothing for a frontal face (eyes stay registered)', () => {
    expect(livePlacement(0).fit).toEqual({ shift: 0, grow: 1 })
  })

  it('looking down: the chin would escape the pinned pumpkin, the fit brings it back inside', () => {
    for (const deg of [15, 25, 35, 45]) {
      const { fit, allInside } = livePlacement((deg * Math.PI) / 180)
      expect(allInside(fit), `${deg}°`).toBe(true)
      // a slide (not a giant pumpkin) is enough for realistic angles
      expect(fit.grow, `${deg}°`).toBeLessThan(1.15)
    }
    const steep = livePlacement((30 * Math.PI) / 180)
    expect(steep.allInside({ shift: 0, grow: 1 })).toBe(false)
  })

  it('also covers looking up and turning the head', () => {
    for (const [p, yw] of [
      [-25, 0],
      [0, 35],
      [20, -30],
    ] as const) {
      const { fit, allInside } = livePlacement((p * Math.PI) / 180, (yw * Math.PI) / 180)
      expect(allInside(fit)).toBe(true)
    }
  })
})
