import { describe, expect, it } from 'vitest'
import { mapTileLandmarks, mergeFaceCandidates, photoTiles, touchesTileEdge, type FaceCandidate, type Tile } from '../app/utils/photoTiles'
import type { LandmarkLike } from '../app/utils/faceMapping'

const WHOLE: Tile = { x: 0, y: 0, w: 1, h: 1 }

/** Minimal face: cheeks (234/454), forehead (10) and chin (152) around a centre. */
function face(cx: number, cy: number, halfW: number, aspect = 1): LandmarkLike[] {
  const lm: LandmarkLike[] = Array.from({ length: 478 }, () => ({ x: cx, y: cy, z: 0 }))
  lm[234] = { x: cx - halfW / aspect, y: cy, z: 0 }
  lm[454] = { x: cx + halfW / aspect, y: cy, z: 0 }
  lm[10] = { x: cx, y: cy - halfW * 1.2, z: 0 }
  lm[152] = { x: cx, y: cy + halfW * 1.3, z: 0 }
  return lm
}
const cand = (landmarks: LandmarkLike[], full: boolean, tile: Tile = WHOLE): FaceCandidate<string> => ({
  landmarks,
  blendshapes: full ? 'full' : 'tile',
  full,
  tile,
})

describe('photoTiles', () => {
  it('covers the whole image with overlapping tiles', () => {
    for (const [w, h] of [
      [1600, 900],
      [900, 1600],
      [1000, 1000],
      [2400, 800],
    ] as const) {
      const tiles = photoTiles(w, h)
      expect(tiles.length).toBeGreaterThanOrEqual(2)
      for (const t of tiles) {
        expect(t.x).toBeGreaterThanOrEqual(0)
        expect(t.y).toBeGreaterThanOrEqual(0)
        expect(t.x + t.w).toBeLessThanOrEqual(1 + 1e-9)
        expect(t.y + t.h).toBeLessThanOrEqual(1 + 1e-9)
      }
      // every point of a grid is inside some tile, and tiles overlap
      for (let gx = 0; gx <= 10; gx++)
        for (let gy = 0; gy <= 10; gy++) {
          const p = { x: gx / 10, y: gy / 10 }
          expect(tiles.some((t) => p.x >= t.x - 1e-9 && p.x <= t.x + t.w + 1e-9 && p.y >= t.y - 1e-9 && p.y <= t.y + t.h + 1e-9)).toBe(true)
        }
    }
    expect(photoTiles(2400, 800)).toHaveLength(3)
    expect(photoTiles(1000, 1000)).toHaveLength(4)
    expect(photoTiles(0, 100)).toEqual([])
  })
})

describe('mapTileLandmarks', () => {
  it('maps tile-normalised landmarks (incl. width-relative z) back to the full image', () => {
    const tile = { x: 0.4, y: 0.1, w: 0.5, h: 0.8 }
    const [p] = mapTileLandmarks([{ x: 0.5, y: 0.25, z: -0.2 }], tile)
    expect(p!.x).toBeCloseTo(0.65, 12)
    expect(p!.y).toBeCloseTo(0.3, 12)
    expect(p!.z).toBeCloseTo(-0.1, 12)
  })
})

describe('mergeFaceCandidates', () => {
  it('keeps full-image detections and adds only new faces found on tiles', () => {
    const left: Tile = { x: 0, y: 0, w: 0.625, h: 1 }
    const right: Tile = { x: 0.375, y: 0, w: 0.625, h: 1 }
    const a = face(0.2, 0.5, 0.06)
    const b = face(0.8, 0.5, 0.06)
    const merged = mergeFaceCandidates(
      [
        cand(a, true),
        // same person again from the left tile (slightly different landmarks)
        cand(face(0.205, 0.5, 0.061), false, left),
        // a second person only found on the right tile
        cand(b, false, right),
      ],
      1600,
      900,
    )
    expect(merged).toHaveLength(2)
    expect(merged[0]!.blendshapes).toBe('full')
    expect(merged.map((m) => m.landmarks[234]!.x).sort()).toEqual([a[234]!.x, b[234]!.x].sort())
  })

  it('drops tile detections cut by an inner tile edge', () => {
    const left: Tile = { x: 0, y: 0, w: 0.625, h: 1 }
    const cut = face(0.6, 0.5, 0.06) // its right cheek is past the tile's inner edge
    expect(touchesTileEdge(cut, left)).toBe(true)
    expect(touchesTileEdge(cut, WHOLE)).toBe(false)
    expect(mergeFaceCandidates([cand(cut, false, left)], 1600, 900)).toHaveLength(0)
    expect(mergeFaceCandidates([cand(cut, true)], 1600, 900)).toHaveLength(1)
  })
})
