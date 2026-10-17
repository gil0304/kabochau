import { describe, expect, it } from 'vitest'
import {
  REFERENCE_FACE,
  averageParams,
  computeFaceParams,
  facePoseFromFrame,
  landmarksToParams,
  normalizeLandmarks,
  paramsSignature,
  type PumpkinFaceParams,
} from '../app/utils/faceMapping'
import { BROW_L, BROW_R, EYE_L, EYE_R, LIPS } from '../app/utils/landmarkIndices'
import { canonicalVertices, projectToLandmarks, scaleAbout, shift } from './helpers/faceFixture'

const W = 1280
const H = 720
const LIP_IDS = [...LIPS.outerUpper, ...LIPS.outerLower, ...LIPS.innerUpper, ...LIPS.innerLower]

function params(
  verts = canonicalVertices(),
  opts: Parameters<typeof projectToLandmarks>[1] = {},
  mirrored = true,
): PumpkinFaceParams {
  const p = landmarksToParams(projectToLandmarks(verts, opts), opts.imageWidth ?? W, opts.imageHeight ?? H, mirrored)
  expect(p).not.toBeNull()
  return p!
}

function maxAbsDiff(a: number[], b: number[]): number {
  return a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i]!)), 0)
}

describe('normalizeLandmarks', () => {
  it('rejects missing or corrupt data instead of throwing', () => {
    expect(normalizeLandmarks(null, W, H, true)).toBeNull()
    expect(normalizeLandmarks(undefined, W, H, true)).toBeNull()
    expect(normalizeLandmarks([], W, H, true)).toBeNull()
    const lm = projectToLandmarks(canonicalVertices())
    expect(normalizeLandmarks(lm.slice(0, 100), W, H, true)).toBeNull()
    expect(normalizeLandmarks(lm, 0, H, true)).toBeNull()
    const broken = lm.map((l) => ({ ...l }))
    broken[33] = { x: Number.NaN, y: 0.5, z: 0 }
    expect(normalizeLandmarks(broken, W, H, true)).toBeNull()
    // collapsed face (all points identical)
    const collapsed = lm.map(() => ({ x: 0.5, y: 0.5, z: 0 }))
    expect(normalizeLandmarks(collapsed, W, H, true)).toBeNull()
  })

  it('accepts 468-point meshes without iris landmarks', () => {
    const lm = projectToLandmarks(canonicalVertices()).slice(0, 468)
    expect(landmarksToParams(lm, W, H, true)).not.toBeNull()
  })

  it('puts the eye midpoint at the origin with unit face width', () => {
    const face = normalizeLandmarks(projectToLandmarks(canonicalVertices()), W, H, true)!
    const at = (i: number) => [face.points[i * 3]!, face.points[i * 3 + 1]!]
    const cheekL = at(234)
    const cheekR = at(454)
    expect(Math.abs(cheekR[0]! - cheekL[0]!)).toBeCloseTo(1, 3)
    // forehead above, chin below the origin (y up)
    expect(at(10)[1]).toBeGreaterThan(0)
    expect(at(152)[1]).toBeLessThan(0)
  })
})

describe('computeFaceParams', () => {
  it('reproduces the documented average-face reference values', () => {
    const p = params()
    const R = REFERENCE_FACE
    expect(p.faceAspect).toBeCloseTo(R.faceAspect, 3)
    expect(p.eyeSpacing).toBeCloseTo(R.eyeSpacing, 3)
    expect(p.eyes.left.width).toBeCloseTo(R.eyeWidth, 3)
    expect(p.eyes.left.openness).toBeCloseTo(R.eyeOpenness, 3)
    expect(p.eyes.left.tilt).toBeCloseTo(R.eyeTilt, 3)
    expect(p.brows.left.angle).toBeCloseTo(R.browAngle, 3)
    expect(p.brows.left.lift).toBeCloseTo(R.browLift, 3)
    expect(p.nose.width).toBeCloseTo(R.noseWidth, 3)
    expect(p.nose.length).toBeCloseTo(R.noseLength, 3)
    expect(p.mouth.width).toBeCloseTo(R.mouthWidth, 3)
    expect(p.mouth.openness).toBeCloseTo(R.mouthOpenness, 3)
    expect(p.mouth.cornerLiftLeft).toBeCloseTo(R.mouthCornerLift, 3)
    expect(p.mouth.center.y).toBeCloseTo(R.mouthCenterY, 3)
  })

  it('is invariant to translation, scale and in-plane rotation (roll)', () => {
    const base = paramsSignature(params())
    for (const opts of [
      { cx: 300, cy: 200, scale: 8 },
      { cx: 900, cy: 500, scale: 22 },
      { roll: 0.35 },
      { roll: -0.5, scale: 30, cx: 640, cy: 380 },
    ]) {
      expect(maxAbsDiff(paramsSignature(params(canonicalVertices(), opts)), base)).toBeLessThan(1e-4)
    }
  })

  it('handles portrait sources (non-square pixels are not assumed)', () => {
    const base = paramsSignature(params())
    const portrait = params(canonicalVertices(), { imageWidth: 720, imageHeight: 1280, cx: 360, cy: 600 })
    expect(maxAbsDiff(paramsSignature(portrait), base)).toBeLessThan(1e-4)
  })

  it('stays stable under moderate yaw / pitch (frontalised measurements)', () => {
    const base = params()
    for (const opts of [{ yaw: 0.3 }, { yaw: -0.3 }, { pitch: 0.2 }, { pitch: -0.25, yaw: 0.15 }]) {
      const p = params(canonicalVertices(), opts)
      expect(Math.abs(p.eyeSpacing - base.eyeSpacing)).toBeLessThan(0.02)
      expect(Math.abs(p.mouth.width - base.mouth.width)).toBeLessThan(0.02)
      expect(Math.abs(p.eyes.left.openness - base.eyes.left.openness)).toBeLessThan(0.04)
      expect(Math.abs(p.nose.width - base.nose.width)).toBeLessThan(0.02)
    }
  })

  it('maps asymmetry to the correct DISPLAY side depending on mirroring', () => {
    const v = canonicalVertices()
    // raise the SUBJECT's left brow by 0.6 cm
    shift(v, [...BROW_L.upper, ...BROW_L.lower], 0, 0.6)
    const mirrored = params(v, {}, true)
    const plain = params(v, {}, false)
    // selfie preview: the subject's left side is on the display left
    expect(mirrored.brows.left.lift).toBeGreaterThan(mirrored.brows.right.lift + 0.02)
    // un-mirrored photo: the subject's left side appears on the display right
    expect(plain.brows.right.lift).toBeGreaterThan(plain.brows.left.lift + 0.02)
    // a symmetric face is identical either way
    expect(maxAbsDiff(paramsSignature(params(canonicalVertices(), {}, true)), paramsSignature(params(canonicalVertices(), {}, false)))).toBeLessThan(1e-4)
  })

  it('captures individual differences in eyes, brows, nose and mouth', () => {
    const base = params()

    const wideEyes = canonicalVertices()
    shift(wideEyes, EYE_R.contour, -0.5, 0)
    shift(wideEyes, EYE_L.contour, 0.5, 0)
    expect(params(wideEyes).eyeSpacing).toBeGreaterThan(base.eyeSpacing + 0.05)

    const narrowEyes = canonicalVertices()
    scaleAbout(narrowEyes, EYE_R.contour, 1, 0.5)
    scaleAbout(narrowEyes, EYE_L.contour, 1, 0.5)
    expect(params(narrowEyes).eyes.left.openness).toBeLessThan(base.eyes.left.openness * 0.6)

    const wideMouth = canonicalVertices()
    scaleAbout(wideMouth, LIP_IDS, 1.3, 1)
    expect(params(wideMouth).mouth.width).toBeGreaterThan(base.mouth.width * 1.2)

    const smile = canonicalVertices()
    shift(smile, [LIPS.cornerL, LIPS.cornerR, 78, 308], 0, 0.6)
    const s = params(smile)
    expect(s.mouth.cornerLiftLeft).toBeGreaterThan(base.mouth.cornerLiftLeft + 0.05)
    expect(s.mouth.cornerLiftRight).toBeGreaterThan(base.mouth.cornerLiftRight + 0.05)

    const angryBrows = canonicalVertices()
    // lower the inner brow ends (both sides)
    shift(angryBrows, [BROW_R.upper[0], BROW_R.lower[0], BROW_L.upper[0], BROW_L.lower[0]], 0, -0.5)
    const a = params(angryBrows)
    expect(a.brows.left.angle).toBeGreaterThan(base.brows.left.angle + 0.05)
    expect(a.brows.right.angle).toBeGreaterThan(base.brows.right.angle + 0.05)

    const openMouth = canonicalVertices()
    shift(openMouth, [...LIPS.outerLower, ...LIPS.innerLower].filter((i) => i !== 61 && i !== 291 && i !== 78 && i !== 308), 0, -1.2)
    expect(params(openMouth).mouth.openness).toBeGreaterThan(base.mouth.openness + 0.15)
  })
})

describe('facePoseFromFrame', () => {
  const pose = (opts: Parameters<typeof projectToLandmarks>[1], mirrored: boolean) =>
    facePoseFromFrame(normalizeLandmarks(projectToLandmarks(canonicalVertices(), opts), W, H, mirrored)!.frame)

  it('reports a level, frontal pose for a frontal face', () => {
    const p = pose({}, true)
    expect(Math.abs(p.roll)).toBeLessThan(1e-3)
    expect(Math.abs(p.yaw)).toBeLessThan(1e-3)
    expect(Math.abs(p.pitch)).toBeLessThan(0.02)
  })

  it('inverts roll and yaw in the mirrored (selfie) display space', () => {
    const plain = pose({ roll: 0.3, yaw: 0.25 }, false)
    const mirrored = pose({ roll: 0.3, yaw: 0.25 }, true)
    expect(plain.roll).toBeCloseTo(0.3, 2)
    expect(mirrored.roll).toBeCloseTo(-0.3, 2)
    expect(plain.yaw).toBeGreaterThan(0.15)
    expect(mirrored.yaw).toBeLessThan(-0.15)
  })

  it('anchors at the eye midpoint in display coordinates', () => {
    const p = pose({ cx: 400, cy: 300 }, true)
    const q = pose({ cx: 400, cy: 300 }, false)
    // mirroring flips x around the image centre
    expect(p.anchorNorm.x).toBeCloseTo(1 - q.anchorNorm.x, 5)
    expect(p.anchorNorm.y).toBeCloseTo(q.anchorNorm.y, 5)
    // eyes are above the face centre (smaller y in image space)
    expect(q.anchorNorm.y).toBeLessThan(300 / H)
  })

  it('returns an orthonormal rotation', () => {
    const r = pose({ roll: 0.2, yaw: -0.3, pitch: 0.1 }, true).rotation
    const col = (c: number) => [r[c * 3]!, r[c * 3 + 1]!, r[c * 3 + 2]!]
    const dot = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!
    for (let i = 0; i < 3; i++) {
      expect(dot(col(i), col(i))).toBeCloseTo(1, 5)
      for (let j = i + 1; j < 3; j++) expect(Math.abs(dot(col(i), col(j)))).toBeLessThan(1e-5)
    }
  })
})

describe('averageParams', () => {
  it('averages snapshots and returns null for an empty list', () => {
    expect(averageParams([])).toBeNull()
    const a = params()
    const wide = canonicalVertices()
    scaleAbout(wide, LIP_IDS, 1.4, 1)
    const b = params(wide)
    const avg = averageParams([a, b])!
    expect(avg.mouth.width).toBeCloseTo((a.mouth.width + b.mouth.width) / 2, 6)
    expect(avg.mirrored).toBe(true)
  })

  it('keeps computeFaceParams deterministic', () => {
    const face = normalizeLandmarks(projectToLandmarks(canonicalVertices()), W, H, true)!
    expect(paramsSignature(computeFaceParams(face))).toEqual(paramsSignature(computeFaceParams(face)))
  })
})
