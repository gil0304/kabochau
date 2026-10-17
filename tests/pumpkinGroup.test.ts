import { describe, expect, it } from 'vitest'
import { MAX_GROUP, RISER_RATIO, RISER_TOTAL_RATIO, arrangePumpkinGroup, type GroupMember } from '../app/utils/pumpkinGroup'
import { CARVE_TIMELINE, carveTimeline } from '../app/utils/pumpkinGeometry'
import { fitDistanceForBox } from '../app/utils/imageExport'

const member = (over: Partial<GroupMember> = {}): GroupMember => ({
  halfWidth: 1.05,
  halfDepth: 1.0,
  bodyHeight: 1.7,
  totalHeight: 2.05,
  ...over,
})

function boxes(members: GroupMember[]) {
  const a = arrangePumpkinGroup(members)
  return {
    a,
    pumpkins: a.slots.map((s, i) => ({
      minX: s.x - members[i]!.halfWidth,
      maxX: s.x + members[i]!.halfWidth,
      minY: s.y,
      maxY: s.y + members[i]!.bodyHeight,
      minZ: s.z - members[i]!.halfDepth,
      maxZ: s.z + members[i]!.halfDepth,
    })),
  }
}

const overlap = (
  p: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number },
  q: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number },
) => p.minX < q.maxX - 1e-9 && q.minX < p.maxX - 1e-9 && p.minY < q.maxY - 1e-9 && q.minY < p.maxY - 1e-9 && p.minZ < q.maxZ - 1e-9 && q.minZ < p.maxZ - 1e-9

describe('arrangePumpkinGroup', () => {
  it('keeps a single pumpkin at the origin with no riser', () => {
    const a = arrangePumpkinGroup([member()])
    expect(a.slots).toEqual([{ x: 0, y: 0, z: 0, row: 'front' }])
    expect(a.risers).toHaveLength(0)
  })

  it('never lets pumpkins (or the hay bale) intersect, for every group size and mixed sizes', () => {
    const sizes = [member(), member({ halfWidth: 1.15, bodyHeight: 1.95, totalHeight: 2.4 }), member({ halfWidth: 0.95, halfDepth: 0.9 }), member({ halfWidth: 1.1 })]
    for (let n = 1; n <= MAX_GROUP; n++) {
      const { a, pumpkins } = boxes(sizes.slice(0, n))
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) expect(overlap(pumpkins[i]!, pumpkins[j]!), `n=${n} ${i}/${j}`).toBe(false)
      for (const r of a.risers) {
        const riser = { minX: r.x - r.width / 2, maxX: r.x + r.width / 2, minY: 0, maxY: r.height, minZ: r.z - r.depth / 2, maxZ: r.z + r.depth / 2 }
        a.slots.forEach((s, i) => {
          if (s.row === 'front') expect(overlap(pumpkins[i]!, riser)).toBe(false)
          else {
            // back-row pumpkins stand on the bale, within its footprint
            expect(s.y).toBeCloseTo(r.height, 9)
            expect(pumpkins[i]!.minX).toBeGreaterThanOrEqual(riser.minX)
            expect(pumpkins[i]!.maxX).toBeLessThanOrEqual(riser.maxX)
          }
        })
      }
    }
  })

  it('keeps people in left-to-right order', () => {
    for (let n = 2; n <= MAX_GROUP; n++) {
      const { slots } = arrangePumpkinGroup(Array.from({ length: n }, () => member()))
      for (let i = 1; i < n; i++) expect(slots[i]!.x).toBeGreaterThanOrEqual(slots[i - 1]!.x - 1e-9)
      expect(slots[n - 1]!.x).toBeGreaterThan(slots[0]!.x)
    }
  })

  it('raises the back row so its carved mouths clear the front pumpkins', () => {
    for (const n of [3, 4]) {
      const ms = Array.from({ length: n }, () => member())
      const { slots } = arrangePumpkinGroup(ms)
      const frontTop = Math.max(...slots.map((s, i) => (s.row === 'front' ? s.y + ms[i]!.bodyHeight : 0)))
      const frontStemTop = Math.max(...slots.map((s, i) => (s.row === 'front' ? s.y + ms[i]!.totalHeight : 0)))
      slots.forEach((s, i) => {
        if (s.row !== 'back') return
        expect(s.z).toBeLessThan(0)
        // the mouth sits around the lower 40% of the body: clear of the front bodies…
        expect(s.y + ms[i]!.bodyHeight * 0.4).toBeGreaterThan(frontTop)
        // …and the bale is tall enough relative to the front stems
        expect(s.y).toBeGreaterThanOrEqual(frontStemTop * RISER_TOTAL_RATIO - 1e-9)
      })
      expect(RISER_RATIO).toBeGreaterThan(0.6)
    }
  })

  it('reports bounds containing every pumpkin and stays portrait-friendly (≤ 2 per row)', () => {
    for (let n = 1; n <= MAX_GROUP; n++) {
      const ms = Array.from({ length: n }, () => member())
      const { a, pumpkins } = boxes(ms)
      for (const p of pumpkins) {
        expect(p.minX).toBeGreaterThanOrEqual(a.min.x - 1e-9)
        expect(p.maxX).toBeLessThanOrEqual(a.max.x + 1e-9)
        expect(p.minZ).toBeGreaterThanOrEqual(a.min.z - 1e-9)
        expect(p.maxZ).toBeLessThanOrEqual(a.max.z + 1e-9)
      }
      const width = a.max.x - a.min.x
      expect(width).toBeLessThan(2 * 2 * 1.05 + 0.6)
    }
  })

  it('caps the group at MAX_GROUP', () => {
    expect(arrangePumpkinGroup(Array.from({ length: 7 }, () => member())).slots).toHaveLength(MAX_GROUP)
    expect(arrangePumpkinGroup([]).slots).toHaveLength(0)
  })
})

describe('carveTimeline', () => {
  it('matches the single-pumpkin timeline and waits for the last carver in groups', () => {
    expect(carveTimeline(1)).toEqual({ ...CARVE_TIMELINE })
    const t4 = carveTimeline(4, 0.14)
    expect(t4.end).toBeCloseTo(CARVE_TIMELINE.end + 3 * 0.14, 9)
    expect(t4.igniteStart).toBeCloseTo(CARVE_TIMELINE.igniteStart + 3 * 0.14, 9)
    expect(t4.carveStart).toBe(CARVE_TIMELINE.carveStart)
    // the last person's carving ends at the same moment relative to ignition as a single pumpkin's
    const done = (T: typeof t4, delay: number) => T.carveStart + delay + 5 * T.carveStagger + T.carveDuration - T.igniteStart
    expect(done(t4, 3 * 0.14)).toBeCloseTo(done(carveTimeline(1), 0), 9)
    expect(carveTimeline(9, 0.14).end).toBeCloseTo(t4.end, 9)
  })
})

describe('fitDistanceForBox', () => {
  it('fits the wider of the two half extents and is tighter than a bounding sphere for wide groups', () => {
    const fov = 30
    const aspect = 9 / 16
    const d = fitDistanceForBox(2.2, 1.8, 1.0, fov, aspect, 0)
    const tanY = Math.tan((fov * Math.PI) / 360)
    // width-limited in portrait: the box edge lands on the frame edge (minus the depth allowance)
    expect(((d - 1.0) * tanY * aspect) / 2.2).toBeCloseTo(1, 9)
    const sphere = Math.hypot(2.2, 1.8, 1.0)
    const sphereDistance = sphere / Math.sin(Math.atan(tanY * aspect))
    expect(d).toBeLessThan(sphereDistance)
  })
})
