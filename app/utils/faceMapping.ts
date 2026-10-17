// Landmark normalisation and the shared PumpkinFaceParams model used by BOTH
// LIVE (per-frame) and CARVE (snapshot / photo).
//
// Coordinate conventions (see README "Coordinate systems"):
//
// 1. MediaPipe landmark space: x, y in [0, 1] of the *unmirrored* source image,
//    y pointing DOWN; z = relative depth in roughly the same scale as x,
//    smaller (negative) = closer to the camera.
//
// 2. Display space ("as shown to the user"): if `mirrored` (selfie preview),
//    x is flipped (x -> 1 - x). We work in pixels of the source image with a
//    right-handed, Y-UP frame so it matches three.js camera space:
//        X = xd * W,   Y = -y * H,   Z = -z * W      (xd = mirrored ? 1 - x : x)
//    "left" / "right" in every exported structure means DISPLAY (viewer)
//    left / right, never the subject's anatomical side.
//
// 3. Face frame: origin = midpoint of the two eye centres, x̂ = display
//    left -> right (average of symmetric landmark pairs), ŷ = chin -> forehead
//    orthogonalised against x̂, ẑ = x̂ × ŷ (towards the viewer for a frontal
//    face). The unit length is the 3D face width (cheek 234 <-> cheek 454), so
//    the measurements are invariant to translation, scale, roll and (largely)
//    yaw / pitch.

import {
  type Vec2,
  type Vec3,
  add3,
  clamp,
  cross3,
  dot3,
  len3,
  mid3,
  normalize3,
  scale3,
  sub3,
  v2,
  v3,
} from './math'
import {
  BROW_L,
  BROW_R,
  EYE_L,
  EYE_R,
  FACE,
  LANDMARK_COUNT,
  LIPS,
  MESH_LANDMARK_COUNT,
  NOSE,
  SYMMETRIC_PAIRS,
} from './landmarkIndices'

export interface LandmarkLike {
  x: number
  y: number
  z?: number
}

export interface FaceFrame {
  /** Eye midpoint in display space, normalised to the source image (x right, y DOWN, 0..1). */
  originNorm: Vec2
  /** Eye midpoint in display 3D pixel space (y up). */
  origin: Vec3
  xAxis: Vec3
  yAxis: Vec3
  zAxis: Vec3
  /** 3D face width in source pixels. */
  faceWidthPx: number
  imageWidth: number
  imageHeight: number
  mirrored: boolean
}

export interface NormalizedFace {
  frame: FaceFrame
  /** Face-frame coordinates (u, v, w) per landmark, unit = face width. */
  points: Float32Array
  count: number
}

export interface EyeParams {
  /** Corner midpoint in face-frame coordinates. */
  center: Vec2
  /** Corner-to-corner distance. */
  width: number
  /** Lid extent (upper arch + lower arch) / width. ~0.26 open, <0.08 closed. */
  openness: number
  /** Radians, positive = outer corner higher than the inner corner. */
  tilt: number
  /** 0..1 position (inner -> outer) of the upper-lid peak. */
  peak: number
  /** Max height of the upper lid above the corner chord / width. */
  upperArch: number
  /** Max depth of the lower lid below the corner chord / width. */
  lowerArch: number
}

export interface BrowParams {
  /** Centre-line end points and peak, face-frame coordinates. */
  inner: Vec2
  outer: Vec2
  peak: Vec2
  /** Radians, positive = outer end higher than inner end. */
  angle: number
  /** Peak height above the inner-outer chord / chord length. */
  arch: number
  /** Mean upper-lower edge distance. */
  thickness: number
  /** Mean centre-line height above the eye centre on the same side. */
  lift: number
}

export interface NoseParams {
  /** Alar width. */
  width: number
  /** Bridge top (168) to subnasale (2) vertical distance. */
  length: number
  tip: Vec2
  base: Vec2
  bridgeTop: Vec2
  /** Tip depth relative to the alae / face width. */
  protrusion: number
  /** Radians, slope of the display-left -> display-right alar line. */
  tilt: number
}

export interface MouthParams {
  /** Horizontal: corner midpoint. Vertical: inner-lip midline. */
  center: Vec2
  width: number
  /** Inner-lip gap / width. */
  openness: number
  /** Corner heights relative to the lip midline / width (positive = up = smile). */
  cornerLiftLeft: number
  cornerLiftRight: number
  upperLip: number
  lowerLip: number
  /** Cupid's-bow depth / width. */
  bow: number
}

export interface PumpkinFaceParams {
  version: 1
  mirrored: boolean
  /** Forehead (10) to chin (152) height / face width. */
  faceAspect: number
  /** Jaw width (172 <-> 397) / face width. */
  jawRatio: number
  /** Forehead height above the eye line / face width. */
  foreheadRatio: number
  /** Distance between eye centres / face width. */
  eyeSpacing: number
  eyes: { left: EyeParams; right: EyeParams }
  brows: { left: BrowParams; right: BrowParams }
  nose: NoseParams
  mouth: MouthParams
}

export interface FacePose {
  /** Eye midpoint in display space normalised to the source (y down). */
  anchorNorm: Vec2
  /** Face width in source pixels. */
  faceWidthPx: number
  /** Column-major 3x3 rotation (display space, y up): columns = x̂, ŷ, ẑ. */
  rotation: [number, number, number, number, number, number, number, number, number]
  yaw: number
  pitch: number
  roll: number
}

function toDisplay3D(l: LandmarkLike, w: number, h: number, mirrored: boolean): Vec3 {
  const x = mirrored ? 1 - l.x : l.x
  return v3(x * w, -l.y * h, -(l.z ?? 0) * w)
}

/**
 * Converts raw landmarks into face-frame coordinates. Returns null for
 * missing / degenerate data (fewer than 468 points, NaNs, zero-size face).
 */
export function normalizeLandmarks(
  landmarks: readonly LandmarkLike[] | null | undefined,
  imageWidth: number,
  imageHeight: number,
  mirrored: boolean,
): NormalizedFace | null {
  if (!landmarks || landmarks.length < MESH_LANDMARK_COUNT) return null
  if (!(imageWidth > 0) || !(imageHeight > 0)) return null
  const count = Math.min(landmarks.length, LANDMARK_COUNT)
  const P: Vec3[] = new Array(count)
  for (let i = 0; i < count; i++) {
    const l = landmarks[i]
    if (!l || !Number.isFinite(l.x) || !Number.isFinite(l.y) || (l.z !== undefined && !Number.isFinite(l.z))) {
      return null
    }
    P[i] = toDisplay3D(l, imageWidth, imageHeight, mirrored)
  }
  const at = (i: number): Vec3 => P[i]!

  // Horizontal axis from symmetric pairs (display left -> display right).
  let xRaw = v3(0, 0, 0)
  for (const [subjR, subjL] of SYMMETRIC_PAIRS) {
    const left = mirrored ? subjL : subjR
    const right = mirrored ? subjR : subjL
    xRaw = add3(xRaw, sub3(at(right), at(left)))
  }
  const xAxis = normalize3(xRaw)
  const yRaw = sub3(at(FACE.forehead), at(FACE.chin))
  const yAxis = normalize3(sub3(yRaw, scale3(xAxis, dot3(yRaw, xAxis))))
  const zAxis = cross3(xAxis, yAxis)
  if (len3(xAxis) < 0.5 || len3(yAxis) < 0.5) return null

  const faceWidthPx = len3(sub3(at(FACE.cheekL), at(FACE.cheekR)))
  if (!(faceWidthPx > 1e-6)) return null

  const eyeCenter = (ids: readonly number[]): Vec3 => {
    let c = v3(0, 0, 0)
    for (const i of ids) c = add3(c, at(i))
    return scale3(c, 1 / ids.length)
  }
  const origin = mid3(eyeCenter(EYE_R.contour), eyeCenter(EYE_L.contour))

  const points = new Float32Array(count * 3)
  const inv = 1 / faceWidthPx
  for (let i = 0; i < count; i++) {
    const d = sub3(at(i), origin)
    points[i * 3] = dot3(d, xAxis) * inv
    points[i * 3 + 1] = dot3(d, yAxis) * inv
    points[i * 3 + 2] = dot3(d, zAxis) * inv
  }

  return {
    frame: {
      originNorm: v2(origin.x / imageWidth, -origin.y / imageHeight),
      origin,
      xAxis,
      yAxis,
      zAxis,
      faceWidthPx,
      imageWidth,
      imageHeight,
      mirrored,
    },
    points,
    count,
  }
}

export function facePoseFromFrame(frame: FaceFrame): FacePose {
  const { xAxis: x, yAxis: y, zAxis: z } = frame
  return {
    anchorNorm: frame.originNorm,
    faceWidthPx: frame.faceWidthPx,
    rotation: [x.x, x.y, x.z, y.x, y.y, y.z, z.x, z.y, z.z],
    yaw: Math.atan2(z.x, z.z),
    pitch: Math.asin(clamp(z.y, -1, 1)),
    roll: Math.atan2(x.y, x.x),
  }
}

// ---------------------------------------------------------------------------
// Feature measurement

type PointAt = (i: number) => Vec2

function eyeParams(at: PointAt, eye: typeof EYE_L | typeof EYE_R, side: 'left' | 'right'): EyeParams {
  const inner = at(eye.inner)
  const outer = at(eye.outer)
  const dx = outer.x - inner.x
  const dy = outer.y - inner.y
  const width = Math.hypot(dx, dy)
  const ux = dx / (width || 1)
  const uy = dy / (width || 1)
  // "up" normal of the inner->outer chord (positive y for a level eye).
  const nx = side === 'right' ? -uy : uy
  const ny = side === 'right' ? ux : -ux
  let upperArch = 0
  let peak = 0.5
  for (const i of eye.upper) {
    const p = at(i)
    const h = (p.x - inner.x) * nx + (p.y - inner.y) * ny
    if (h > upperArch) {
      upperArch = h
      peak = ((p.x - inner.x) * ux + (p.y - inner.y) * uy) / (width || 1)
    }
  }
  let lowerArch = 0
  for (const i of eye.lower) {
    const p = at(i)
    const h = -((p.x - inner.x) * nx + (p.y - inner.y) * ny)
    if (h > lowerArch) lowerArch = h
  }
  const w = width || 1
  return {
    center: v2((inner.x + outer.x) / 2, (inner.y + outer.y) / 2),
    width,
    openness: (upperArch + lowerArch) / w,
    tilt: Math.atan2(dy, side === 'right' ? dx : -dx),
    peak: clamp(peak, 0.15, 0.85),
    upperArch: upperArch / w,
    lowerArch: lowerArch / w,
  }
}

function browParams(at: PointAt, brow: typeof BROW_L | typeof BROW_R, eyeCenter: Vec2): BrowParams {
  const centre: Vec2[] = brow.upper.map((ui, k) => {
    const a = at(ui)
    const b = at(brow.lower[k]!)
    return v2((a.x + b.x) / 2, (a.y + b.y) / 2)
  })
  const inner = centre[0]!
  const outer = centre[centre.length - 1]!
  const dx = outer.x - inner.x
  const dy = outer.y - inner.y
  const length = Math.hypot(dx, dy) || 1
  // up-normal of the chord independent of direction
  let nx = -dy / length
  let ny = dx / length
  if (ny < 0) {
    nx = -nx
    ny = -ny
  }
  let arch = -Infinity
  let peak = inner
  let thickness = 0
  let meanY = 0
  centre.forEach((c, k) => {
    const h = (c.x - inner.x) * nx + (c.y - inner.y) * ny
    if (h > arch) {
      arch = h
      peak = c
    }
    const a = at(brow.upper[k]!)
    const b = at(brow.lower[k]!)
    thickness += Math.hypot(a.x - b.x, a.y - b.y)
    meanY += c.y
  })
  return {
    inner,
    outer,
    peak,
    angle: Math.atan2(dy, Math.abs(dx)),
    arch: Math.max(0, arch) / length,
    thickness: thickness / centre.length,
    lift: meanY / centre.length - eyeCenter.y,
  }
}

/** Measures PumpkinFaceParams from a normalised face. */
export function computeFaceParams(face: NormalizedFace): PumpkinFaceParams {
  const pts = face.points
  const at: PointAt = (i) => v2(pts[i * 3]!, pts[i * 3 + 1]!)
  const depth = (i: number): number => pts[i * 3 + 2]!
  const mirrored = face.frame.mirrored

  // Display-side selection: unmirrored -> subject's right is on the display left.
  const eyeDispL = mirrored ? EYE_L : EYE_R
  const eyeDispR = mirrored ? EYE_R : EYE_L
  const browDispL = mirrored ? BROW_L : BROW_R
  const browDispR = mirrored ? BROW_R : BROW_L

  const left = eyeParams(at, eyeDispL, 'left')
  const right = eyeParams(at, eyeDispR, 'right')

  const nose = (() => {
    const alaDispL = at(mirrored ? NOSE.alaL : NOSE.alaR)
    const alaDispR = at(mirrored ? NOSE.alaR : NOSE.alaL)
    const bridgeTop = at(NOSE.bridgeTop)
    const base = at(NOSE.subnasale)
    return {
      width: Math.hypot(alaDispR.x - alaDispL.x, alaDispR.y - alaDispL.y),
      length: Math.max(0, bridgeTop.y - base.y),
      tip: at(NOSE.tip),
      base,
      bridgeTop,
      protrusion: depth(NOSE.tip) - (depth(NOSE.alaL) + depth(NOSE.alaR)) / 2,
      tilt: Math.atan2(alaDispR.y - alaDispL.y, alaDispR.x - alaDispL.x),
    } satisfies NoseParams
  })()

  const mouth = (() => {
    const cDispL = at(mirrored ? LIPS.cornerL : LIPS.cornerR)
    const cDispR = at(mirrored ? LIPS.cornerR : LIPS.cornerL)
    const width = Math.hypot(cDispR.x - cDispL.x, cDispR.y - cDispL.y) || 1
    const upIn = at(LIPS.upperInnerMid)
    const loIn = at(LIPS.lowerInnerMid)
    const upOut = at(LIPS.upperOuterMid)
    const loOut = at(LIPS.lowerOuterMid)
    const midY = (upIn.y + loIn.y) / 2
    const peakL = at(37)
    const peakR = at(267)
    return {
      center: v2((cDispL.x + cDispR.x) / 2, midY),
      width,
      openness: Math.max(0, upIn.y - loIn.y) / width,
      cornerLiftLeft: (cDispL.y - midY) / width,
      cornerLiftRight: (cDispR.y - midY) / width,
      upperLip: Math.max(0, upOut.y - upIn.y) / width,
      lowerLip: Math.max(0, loIn.y - loOut.y) / width,
      bow: Math.max(0, (peakL.y + peakR.y) / 2 - upOut.y) / width,
    } satisfies MouthParams
  })()

  const jawL = at(FACE.jawL)
  const jawR = at(FACE.jawR)

  return {
    version: 1,
    mirrored,
    faceAspect: at(FACE.forehead).y - at(FACE.chin).y,
    jawRatio: Math.hypot(jawL.x - jawR.x, jawL.y - jawR.y),
    foreheadRatio: at(FACE.forehead).y,
    eyeSpacing: Math.hypot(right.center.x - left.center.x, right.center.y - left.center.y),
    eyes: { left, right },
    brows: {
      left: browParams(at, browDispL, left.center),
      right: browParams(at, browDispR, right.center),
    },
    nose,
    mouth,
  }
}

/** Convenience: raw landmarks -> params (null when the data is unusable). */
export function landmarksToParams(
  landmarks: readonly LandmarkLike[] | null | undefined,
  imageWidth: number,
  imageHeight: number,
  mirrored: boolean,
): PumpkinFaceParams | null {
  const face = normalizeLandmarks(landmarks, imageWidth, imageHeight, mirrored)
  return face ? computeFaceParams(face) : null
}

/**
 * Averages several parameter snapshots (CARVE capture uses the last few
 * frames to suppress single-frame jitter). Angles are small so a plain mean is fine.
 */
export function averageParams(list: readonly PumpkinFaceParams[]): PumpkinFaceParams | null {
  if (list.length === 0) return null
  const first = list[0]!
  const avg = (fn: (p: PumpkinFaceParams) => number): number => list.reduce((s, p) => s + fn(p), 0) / list.length
  const avgV = (fn: (p: PumpkinFaceParams) => Vec2): Vec2 => v2(avg((p) => fn(p).x), avg((p) => fn(p).y))
  const eye = (side: 'left' | 'right'): EyeParams => ({
    center: avgV((p) => p.eyes[side].center),
    width: avg((p) => p.eyes[side].width),
    openness: avg((p) => p.eyes[side].openness),
    tilt: avg((p) => p.eyes[side].tilt),
    peak: avg((p) => p.eyes[side].peak),
    upperArch: avg((p) => p.eyes[side].upperArch),
    lowerArch: avg((p) => p.eyes[side].lowerArch),
  })
  const brow = (side: 'left' | 'right'): BrowParams => ({
    inner: avgV((p) => p.brows[side].inner),
    outer: avgV((p) => p.brows[side].outer),
    peak: avgV((p) => p.brows[side].peak),
    angle: avg((p) => p.brows[side].angle),
    arch: avg((p) => p.brows[side].arch),
    thickness: avg((p) => p.brows[side].thickness),
    lift: avg((p) => p.brows[side].lift),
  })
  return {
    version: 1,
    mirrored: first.mirrored,
    faceAspect: avg((p) => p.faceAspect),
    jawRatio: avg((p) => p.jawRatio),
    foreheadRatio: avg((p) => p.foreheadRatio),
    eyeSpacing: avg((p) => p.eyeSpacing),
    eyes: { left: eye('left'), right: eye('right') },
    brows: { left: brow('left'), right: brow('right') },
    nose: {
      width: avg((p) => p.nose.width),
      length: avg((p) => p.nose.length),
      tip: avgV((p) => p.nose.tip),
      base: avgV((p) => p.nose.base),
      bridgeTop: avgV((p) => p.nose.bridgeTop),
      protrusion: avg((p) => p.nose.protrusion),
      tilt: avg((p) => p.nose.tilt),
    },
    mouth: {
      center: avgV((p) => p.mouth.center),
      width: avg((p) => p.mouth.width),
      openness: avg((p) => p.mouth.openness),
      cornerLiftLeft: avg((p) => p.mouth.cornerLiftLeft),
      cornerLiftRight: avg((p) => p.mouth.cornerLiftRight),
      upperLip: avg((p) => p.mouth.upperLip),
      lowerLip: avg((p) => p.mouth.lowerLip),
      bow: avg((p) => p.mouth.bow),
    },
  }
}

/** Flattens params to a numeric signature (used for distance metrics, hashing, tests). */
export function paramsSignature(p: PumpkinFaceParams): number[] {
  const e = (x: EyeParams) => [x.center.x, x.center.y, x.width, x.openness, x.tilt, x.peak, x.upperArch, x.lowerArch]
  const b = (x: BrowParams) => [x.inner.x, x.inner.y, x.outer.x, x.outer.y, x.angle, x.arch, x.thickness, x.lift]
  return [
    p.faceAspect,
    p.jawRatio,
    p.foreheadRatio,
    p.eyeSpacing,
    ...e(p.eyes.left),
    ...e(p.eyes.right),
    ...b(p.brows.left),
    ...b(p.brows.right),
    p.nose.width,
    p.nose.length,
    p.nose.tip.x,
    p.nose.tip.y,
    p.nose.protrusion,
    p.nose.tilt,
    p.mouth.center.x,
    p.mouth.center.y,
    p.mouth.width,
    p.mouth.openness,
    p.mouth.cornerLiftLeft,
    p.mouth.cornerLiftRight,
    p.mouth.upperLip,
    p.mouth.lowerLip,
    p.mouth.bow,
  ]
}

/**
 * Average-face reference values, measured by running computeFaceParams on the
 * MediaPipe canonical face model (tests/faceMapping.test.ts re-derives these
 * numbers and fails if they drift). CARVE exaggerates deviations from them.
 */
export const REFERENCE_FACE = {
  faceAspect: 1.1525,
  jawRatio: 0.7751,
  foreheadRatio: 0.3672,
  eyeSpacing: 0.4112,
  eyeWidth: 0.169,
  eyeOpenness: 0.2629,
  eyeTilt: 0.0276,
  eyeCenterY: -0.0013,
  browAngle: -0.1273,
  browLift: 0.1272,
  browThickness: 0.0438,
  browArch: 0.1295,
  noseWidth: 0.233,
  noseLength: 0.349,
  noseTipY: -0.2428,
  noseBaseY: -0.3067,
  noseTopY: 0.0423,
  mouthWidth: 0.3205,
  /** The canonical mesh has slightly parted lips; a closed mouth measures ~0.0-0.03. */
  mouthOpenness: 0.1111,
  mouthCornerLift: -0.0177,
  mouthCenterY: -0.4495,
} as const
