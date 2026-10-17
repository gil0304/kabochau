// Multi-person tracking: MediaPipe returns faces in no particular order and
// without identities, so detections are matched to persistent tracks frame by
// frame. Each track keeps its own pumpkin, filters and expression state, which
// keeps a person's pumpkin from jumping to someone else when faces reorder.
//
// Positions are in "height units" of the source frame (x and y both divided
// by the image HEIGHT) so distances are isotropic; sizes are face widths in
// the same unit. Matching cost is the anchor distance in face widths.

import type { PumpkinFaceParams, LandmarkLike } from './faceMapping'
import type { ExpressionState } from './expressionMapping'

/** Hard upper bound of simultaneously tracked people (MediaPipe numFaces). */
export const MAX_FACES = 4

export interface FaceDetection {
  /** index into the detector result */
  index: number
  /** display-space anchor (mirrored for selfies), height units */
  x: number
  y: number
  /** face width, height units */
  size: number
}

export interface TrackAssignment {
  id: number
  index: number
}

export interface CarveFaceInput {
  params: PumpkinFaceParams
  expression: ExpressionState
}

const CHEEK_RIGHT = 234
const CHEEK_LEFT = 454

/** Anchor + size of one face from its landmarks (cheek-to-cheek midpoint and width). */
export function detectionFromLandmarks(
  landmarks: readonly LandmarkLike[],
  index: number,
  imageWidth: number,
  imageHeight: number,
  mirrored: boolean,
): FaceDetection | null {
  const a = landmarks[CHEEK_RIGHT]
  const b = landmarks[CHEEK_LEFT]
  if (!a || !b || !(imageWidth > 0) || !(imageHeight > 0)) return null
  const aspect = imageWidth / imageHeight
  const ax = mirrored ? 1 - a.x : a.x
  const bx = mirrored ? 1 - b.x : b.x
  const x = ((ax + bx) / 2) * aspect
  const y = (a.y + b.y) / 2
  const size = Math.hypot((ax - bx) * aspect, a.y - b.y)
  if (![x, y, size].every(Number.isFinite) || size <= 0) return null
  return { index, x, y, size }
}

interface Track {
  id: number
  x: number
  y: number
  size: number
  lastSeen: number
}

export interface FaceTrackMatcherOptions {
  maxTracks?: number
  /** seconds without a match before a track is forgotten */
  forgetAfter?: number
  /** max anchor jump between detections, in face widths */
  maxJump?: number
}

export class FaceTrackMatcher {
  private tracks: Track[] = []
  private nextId = 1
  private maxTracks: number
  private forgetAfter: number
  private maxJump: number

  constructor(opts: FaceTrackMatcherOptions = {}) {
    this.maxTracks = Math.max(1, Math.min(MAX_FACES, opts.maxTracks ?? MAX_FACES))
    this.forgetAfter = opts.forgetAfter ?? 0.8
    this.maxJump = opts.maxJump ?? 1.2
  }

  /** Ids of tracks that are still remembered. */
  get activeIds(): number[] {
    return this.tracks.map((t) => t.id)
  }

  reset(): void {
    this.tracks = []
  }

  /**
   * Matches detections (any order) to tracks. Only the `maxTracks` largest
   * faces are considered. Returns one assignment per tracked detection.
   */
  update(detections: readonly FaceDetection[], time: number): TrackAssignment[] {
    this.tracks = this.tracks.filter((t) => time - t.lastSeen <= this.forgetAfter)
    const dets = [...detections].sort((a, b) => b.size - a.size).slice(0, this.maxTracks)

    // greedy matching on ascending cost (few faces → exact enough, no Hungarian needed)
    const pairs: Array<{ t: number; d: number; cost: number }> = []
    this.tracks.forEach((tr, ti) => {
      dets.forEach((det, di) => {
        const scale = Math.max(tr.size, det.size)
        const ratio = det.size / tr.size
        if (ratio < 0.5 || ratio > 2) return
        const cost = Math.hypot(det.x - tr.x, det.y - tr.y) / scale
        if (cost <= this.maxJump) pairs.push({ t: ti, d: di, cost })
      })
    })
    pairs.sort((a, b) => a.cost - b.cost)
    const trackUsed = new Set<number>()
    const detUsed = new Set<number>()
    const out: TrackAssignment[] = []
    for (const p of pairs) {
      if (trackUsed.has(p.t) || detUsed.has(p.d)) continue
      trackUsed.add(p.t)
      detUsed.add(p.d)
      const tr = this.tracks[p.t]!
      const det = dets[p.d]!
      tr.x = det.x
      tr.y = det.y
      tr.size = det.size
      tr.lastSeen = time
      out.push({ id: tr.id, index: det.index })
    }
    // unmatched detections start new tracks; when full, the stalest unmatched track is replaced
    dets.forEach((det, di) => {
      if (detUsed.has(di)) return
      if (this.tracks.length >= this.maxTracks) {
        let stalest = -1
        this.tracks.forEach((tr, ti) => {
          if (trackUsed.has(ti)) return
          if (stalest < 0 || tr.lastSeen < this.tracks[stalest]!.lastSeen) stalest = ti
        })
        if (stalest < 0) return
        this.tracks.splice(stalest, 1)
        // indices in trackUsed refer to positions before the splice
        const shifted = new Set<number>()
        for (const ti of trackUsed) shifted.add(ti > stalest ? ti - 1 : ti)
        trackUsed.clear()
        for (const ti of shifted) trackUsed.add(ti)
      }
      const tr: Track = { id: this.nextId++, x: det.x, y: det.y, size: det.size, lastSeen: time }
      this.tracks.push(tr)
      trackUsed.add(this.tracks.length - 1)
      out.push({ id: tr.id, index: det.index })
    })
    return out
  }
}
