import { describe, expect, it } from 'vitest'
import { FaceTrackMatcher, MAX_FACES, detectionFromLandmarks, type FaceDetection } from '../app/utils/faceTracks'

const det = (index: number, x: number, y: number, size = 0.3): FaceDetection => ({ index, x, y, size })
const idOf = (out: Array<{ id: number; index: number }>, index: number) => out.find((a) => a.index === index)?.id

describe('FaceTrackMatcher', () => {
  it('keeps identities when the detector reorders faces', () => {
    const m = new FaceTrackMatcher()
    const first = m.update([det(0, 0.4, 0.5), det(1, 1.2, 0.5)], 0)
    const left = idOf(first, 0)!
    const right = idOf(first, 1)!
    expect(left).not.toBe(right)
    // next frame: both moved a little and the detector swapped their order
    const second = m.update([det(0, 1.25, 0.52), det(1, 0.43, 0.49)], 0.05)
    expect(idOf(second, 1)).toBe(left)
    expect(idOf(second, 0)).toBe(right)
  })

  it('follows people walking past each other at normal speed', () => {
    const m = new FaceTrackMatcher()
    let a = 0.3
    let b = 1.3
    const start = m.update([det(0, a, 0.5), det(1, b, 0.5)], 0)
    const idA = idOf(start, 0)!
    for (let i = 1; i <= 20; i++) {
      a += 0.02
      b -= 0.02
      const out = m.update([det(0, b, 0.5), det(1, a, 0.5)], i * 0.05)
      expect(idOf(out, 1)).toBe(idA)
    }
  })

  it('gives a new id to a newcomer and forgets people who left', () => {
    const m = new FaceTrackMatcher({ forgetAfter: 0.5 })
    const a = idOf(m.update([det(0, 0.5, 0.5)], 0), 0)!
    const both = m.update([det(0, 0.52, 0.5), det(1, 1.4, 0.5)], 0.1)
    expect(idOf(both, 0)).toBe(a)
    const b = idOf(both, 1)!
    expect(b).not.toBe(a)
    // b leaves; a stays
    for (const t of [0.3, 0.5, 0.7, 0.9, 1.0]) m.update([det(0, 0.52, 0.5)], t)
    expect(m.activeIds).toEqual([a])
    // someone appears where b was, much later: a fresh identity
    const later = m.update([det(0, 0.52, 0.5), det(1, 1.4, 0.5)], 1.1)
    expect(idOf(later, 1)).not.toBe(b)
  })

  it('does not jump between people of very different size or far away', () => {
    const m = new FaceTrackMatcher()
    const id = idOf(m.update([det(0, 0.5, 0.5, 0.3)], 0), 0)!
    // a much smaller face far away is a different person
    const out = m.update([det(0, 1.6, 0.4, 0.1)], 0.05)
    expect(idOf(out, 0)).not.toBe(id)
  })

  it('tracks at most maxTracks people, preferring the largest faces', () => {
    const m = new FaceTrackMatcher({ maxTracks: 2 })
    const out = m.update([det(0, 0.2, 0.5, 0.1), det(1, 0.6, 0.5, 0.3), det(2, 1.0, 0.5, 0.25), det(3, 1.4, 0.5, 0.05)], 0)
    expect(out.map((a) => a.index).sort()).toEqual([1, 2])
    expect(new FaceTrackMatcher({ maxTracks: 99 }).update(Array.from({ length: 8 }, (_, i) => det(i, i * 0.4, 0.5)), 0)).toHaveLength(
      MAX_FACES,
    )
  })

  it('replaces the stalest track when full and a new person appears', () => {
    const m = new FaceTrackMatcher({ maxTracks: 2, forgetAfter: 5 })
    const first = m.update([det(0, 0.3, 0.5), det(1, 1.3, 0.5)], 0)
    const stays = idOf(first, 0)!
    m.update([det(0, 0.31, 0.5)], 0.3) // the right person is gone (not yet forgotten)
    const out = m.update([det(0, 0.31, 0.5), det(1, 2.2, 0.5)], 0.6)
    expect(idOf(out, 0)).toBe(stays)
    expect(idOf(out, 1)).toBeDefined()
    expect(m.activeIds).toHaveLength(2)
  })
})

describe('detectionFromLandmarks', () => {
  const lm = (ax: number, bx: number, y = 0.5) => {
    const arr = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }))
    arr[234] = { x: ax, y, z: 0 }
    arr[454] = { x: bx, y, z: 0 }
    return arr
  }

  it('measures centre and width in height units and mirrors x for selfies', () => {
    const d = detectionFromLandmarks(lm(0.2, 0.4), 3, 1280, 720, false)!
    expect(d.index).toBe(3)
    expect(d.x).toBeCloseTo(0.3 * (1280 / 720), 9)
    expect(d.size).toBeCloseTo(0.2 * (1280 / 720), 9)
    const m = detectionFromLandmarks(lm(0.2, 0.4), 3, 1280, 720, true)!
    expect(m.x).toBeCloseTo(0.7 * (1280 / 720), 9)
    expect(m.size).toBeCloseTo(d.size, 9)
  })

  it('rejects missing landmarks and empty images', () => {
    expect(detectionFromLandmarks([], 0, 100, 100, false)).toBeNull()
    expect(detectionFromLandmarks(lm(0.2, 0.4), 0, 0, 100, false)).toBeNull()
    expect(detectionFromLandmarks(lm(0.3, 0.3), 0, 100, 100, false)).toBeNull()
  })
})
