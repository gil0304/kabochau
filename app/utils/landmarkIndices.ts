// MediaPipe Face Landmarker topology (478 points: 468 mesh + 10 iris).
//
// Naming follows MediaPipe: "R" / "L" are the SUBJECT's right / left. In an
// unmirrored camera image the subject's right eye appears on the image's LEFT
// (small x). Display-side selection (viewer left/right) happens in
// faceMapping.ts depending on whether the source is mirrored.
//
// Orderings were verified against the canonical face model:
//   eye contour: outer corner -> lower lid -> inner corner -> upper lid
//   brow arrays: outer -> inner
//   lip arrays:  subject-right corner -> subject-left corner (upper), and back (lower)

export const LANDMARK_COUNT = 478
export const MESH_LANDMARK_COUNT = 468

export const EYE_R = {
  contour: [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246],
  outer: 33,
  inner: 133,
  /** upper lid from inner corner to outer corner */
  upper: [133, 173, 157, 158, 159, 160, 161, 246, 33],
  /** lower lid from inner corner to outer corner */
  lower: [133, 155, 154, 153, 145, 144, 163, 7, 33],
  iris: 468,
} as const

export const EYE_L = {
  contour: [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466],
  outer: 263,
  inner: 362,
  upper: [362, 398, 384, 385, 386, 387, 388, 466, 263],
  lower: [362, 382, 381, 380, 374, 373, 390, 249, 263],
  iris: 473,
} as const

/** Brow arrays run from the INNER end to the OUTER end. */
export const BROW_R = {
  upper: [107, 66, 105, 63, 70],
  lower: [55, 65, 52, 53, 46],
} as const

export const BROW_L = {
  upper: [336, 296, 334, 293, 300],
  lower: [285, 295, 282, 283, 276],
} as const

export const NOSE = {
  bridgeTop: 168,
  bridgeMid: 6,
  tip: 1,
  tipUpper: 4,
  subnasale: 2,
  alaR: 129,
  alaL: 358,
  nostrilR: 98,
  nostrilL: 327,
} as const

export const LIPS = {
  cornerR: 61,
  cornerL: 291,
  /** outer upper lip, subject-right corner -> subject-left corner */
  outerUpper: [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291],
  /** outer lower lip, subject-right corner -> subject-left corner */
  outerLower: [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291],
  /** inner upper lip, subject-right -> subject-left */
  innerUpper: [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308],
  /** inner lower lip, subject-right -> subject-left */
  innerLower: [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308],
  upperOuterMid: 0,
  lowerOuterMid: 17,
  upperInnerMid: 13,
  lowerInnerMid: 14,
} as const

export const FACE = {
  forehead: 10,
  chin: 152,
  cheekR: 234,
  cheekL: 454,
  jawR: 172,
  jawL: 397,
  oval: [
    10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150,
    136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
  ],
} as const

/**
 * Symmetric pairs [subject-right, subject-left] used to estimate the face's
 * horizontal axis robustly (averaging reduces per-landmark noise).
 */
export const SYMMETRIC_PAIRS: ReadonlyArray<readonly [number, number]> = [
  [33, 263],
  [133, 362],
  [234, 454],
  [61, 291],
  [70, 300],
  [172, 397],
  [129, 358],
  [127, 356],
]

/** Contours drawn by the CARVE "scan" overlay. */
export const SCAN_CONTOURS: ReadonlyArray<readonly number[]> = [
  EYE_R.contour,
  EYE_L.contour,
  [...BROW_R.upper, ...[...BROW_R.lower].reverse()],
  [...BROW_L.upper, ...[...BROW_L.lower].reverse()],
  [...LIPS.outerUpper, ...[...LIPS.outerLower].reverse().slice(1, -1)],
  [...LIPS.innerUpper, ...[...LIPS.innerLower].reverse().slice(1, -1)],
  [168, 6, 197, 195, 5, 4, 1],
  [98, 97, 2, 326, 327],
  FACE.oval,
]
