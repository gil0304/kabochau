import { describe, expect, it } from 'vitest'
import { landmarksToParams, type PumpkinFaceParams } from '../app/utils/faceMapping'
import { NEUTRAL_EXPRESSION } from '../app/utils/expressionMapping'
import {
  CARVE_STYLE,
  DEFAULT_PUMPKIN_SHAPE,
  LIVE_HEAD_CENTER_Y,
  LIVE_HEAD_SCALE,
  LIVE_PUMPKIN_SHAPE,
  LIVE_STYLE,
  buildCarveLayout,
  buildCutWalls,
  buildShellMesh,
  buildStemMesh,
  carveProgress,
  frontSurfaceZ,
  layoutIsValid,
  layoutMetrics,
  pumpkinShapeFromParams,
  scaleOutline,
  shellRadius,
  stemFromParams,
  type CarveLayout,
} from '../app/utils/pumpkinGeometry'
import { pointInPolygon, polygonArea } from '../app/utils/math'
import { BROW_L, BROW_R, EYE_L, EYE_R, LIPS } from '../app/utils/landmarkIndices'
import { canonicalVertices, projectToLandmarks, scaleAbout, shift, type Vertex } from './helpers/faceFixture'

const LIP_IDS = [...LIPS.outerUpper, ...LIPS.outerLower, ...LIPS.innerUpper, ...LIPS.innerLower]

function paramsOf(v: Vertex[] = canonicalVertices()): PumpkinFaceParams {
  return landmarksToParams(projectToLandmarks(v), 1280, 720, true)!
}

/** A small "population" of distinct synthetic faces. */
function population(): Record<string, PumpkinFaceParams> {
  const wideEyes = canonicalVertices()
  shift(wideEyes, EYE_R.contour, -0.45, 0)
  shift(wideEyes, EYE_L.contour, 0.45, 0)
  const narrowEyes = canonicalVertices()
  scaleAbout(narrowEyes, [...EYE_R.contour, ...EYE_L.contour], 0.9, 0.55)
  const wideMouth = canonicalVertices()
  scaleAbout(wideMouth, LIP_IDS, 1.3, 1)
  const smiley = canonicalVertices()
  shift(smiley, [61, 291, 78, 308], 0, 0.45)
  const angry = canonicalVertices()
  shift(angry, [BROW_R.upper[0], BROW_R.lower[0], BROW_L.upper[0], BROW_L.lower[0]], 0, -0.45)
  const longNose = canonicalVertices()
  shift(longNose, [2, 98, 327, 97, 326, 1, 4], 0, -0.4)
  scaleAbout(longNose, [129, 358, 98, 327, 64, 294], 1.25, 1)
  return {
    average: paramsOf(),
    wideEyes: paramsOf(wideEyes),
    narrowEyes: paramsOf(narrowEyes),
    wideMouth: paramsOf(wideMouth),
    smiley: paramsOf(smiley),
    angry: paramsOf(angry),
    longNose: paramsOf(longNose),
  }
}

function expectWellFormed(layout: CarveLayout, fitRadius: number, shape = DEFAULT_PUMPKIN_SHAPE) {
  expect(layout.features.map((f) => f.id).sort()).toEqual(['browLeft', 'browRight', 'eyeLeft', 'eyeRight', 'mouth', 'nose'])
  expect(layoutIsValid(layout)).toBe(true)
  for (const f of layout.features) {
    expect(polygonArea(f.outline)).toBeGreaterThan(0)
    for (const p of f.outline) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true)
      expect(Math.hypot(p.x / shape.radiusX, p.y / shape.radiusY)).toBeLessThanOrEqual(fitRadius + 1e-6)
      // every outline point must lie on the carvable front surface
      expect(frontSurfaceZ(shape, p.x, p.y)).not.toBeNull()
    }
  }
  // no two openings overlap
  for (const a of layout.features) {
    for (const b of layout.features) {
      if (a === b) continue
      for (const p of a.outline) expect(pointInPolygon(p, b.outline)).toBe(false)
    }
  }
}

describe('shell', () => {
  it('has a positive, finite radius everywhere', () => {
    for (let i = 0; i <= 40; i++) {
      for (let j = 0; j <= 20; j++) {
        const r = shellRadius(DEFAULT_PUMPKIN_SHAPE, -Math.PI + (i / 40) * 2 * Math.PI, (j / 20) * Math.PI)
        expect(r).toBeGreaterThan(0.4)
        expect(r).toBeLessThan(1.3)
      }
    }
  })

  it('builds a consistent mesh with outward unit normals', () => {
    const m = buildShellMesh(DEFAULT_PUMPKIN_SHAPE, 32, 24)
    expect(m.positions.length).toBe(33 * 25 * 3)
    expect(m.indices.length).toBe(32 * 24 * 6)
    let outward = 0
    for (let k = 0; k < m.positions.length / 3; k++) {
      const n = [m.normals[k * 3]!, m.normals[k * 3 + 1]!, m.normals[k * 3 + 2]!]
      expect(Math.hypot(n[0]!, n[1]!, n[2]!)).toBeCloseTo(1, 4)
      const d = n[0]! * m.positions[k * 3]! + n[1]! * m.positions[k * 3 + 1]! + n[2]! * m.positions[k * 3 + 2]!
      if (d > 0) outward++
    }
    expect(outward / (m.positions.length / 3)).toBeGreaterThan(0.97)
    for (const i of m.indices) expect(i).toBeLessThan(m.positions.length / 3)
  })

  it('solves the front surface accurately and rejects points outside the silhouette', () => {
    const shape = DEFAULT_PUMPKIN_SHAPE
    const z0 = frontSurfaceZ(shape, 0, 0)!
    expect(z0).toBeCloseTo(shellRadius(shape, 0, Math.PI / 2), 4)
    expect(frontSurfaceZ(shape, 1.5, 0)).toBeNull()
    expect(frontSurfaceZ(shape, 0, 1.2)).toBeNull()
    for (const [x, y] of [
      [0.3, 0.2],
      [-0.5, -0.3],
      [0.1, 0.55],
      [0.6, -0.1],
    ] as const) {
      const z = frontSurfaceZ(shape, x, y)!
      const r = Math.hypot(x, y, z)
      const phi = Math.acos(y / r)
      const theta = Math.atan2(x, z)
      expect(r).toBeCloseTo(shellRadius(shape, theta, phi), 4)
      expect(z).toBeGreaterThan(0)
    }
  })

  it('builds a stem rooted in the top dimple', () => {
    const stem = buildStemMesh(stemFromParams(null), DEFAULT_PUMPKIN_SHAPE)
    expect(stem.positions.length % 3).toBe(0)
    let minY = Infinity
    for (let i = 1; i < stem.positions.length; i += 3) minY = Math.min(minY, stem.positions[i]!)
    const top = shellRadius(DEFAULT_PUMPKIN_SHAPE, 0, 0) * 1
    expect(minY).toBeLessThan(top)
    for (const i of stem.indices) expect(i).toBeLessThan(stem.positions.length / 3)
  })
})

describe('buildCarveLayout', () => {
  const pop = population()

  it('produces valid, non-overlapping openings on the carvable front for every face and style', () => {
    for (const p of Object.values(pop)) {
      expectWellFormed(buildCarveLayout(p, LIVE_STYLE, NEUTRAL_EXPRESSION, LIVE_PUMPKIN_SHAPE), LIVE_STYLE.fitRadius, LIVE_PUMPKIN_SHAPE)
      const shape = pumpkinShapeFromParams(p)
      expectWellFormed(buildCarveLayout(p, CARVE_STYLE, NEUTRAL_EXPRESSION, shape), CARVE_STYLE.fitRadius, shape)
    }
  })

  it('stays valid under extreme expressions', () => {
    const extremes = [
      { ...NEUTRAL_EXPRESSION, blinkLeft: 1, blinkRight: 1 },
      { ...NEUTRAL_EXPRESSION, mouthOpen: 1, smile: 1 },
      { ...NEUTRAL_EXPRESSION, browRaise: 1, mouthOpen: 1 },
      { ...NEUTRAL_EXPRESSION, browFrown: 1, smile: 1, blinkLeft: 1 },
    ]
    for (const e of extremes) {
      for (const p of Object.values(pop)) expectWellFormed(buildCarveLayout(p, LIVE_STYLE, e, LIVE_PUMPKIN_SHAPE), LIVE_STYLE.fitRadius, LIVE_PUMPKIN_SHAPE)
    }
  })

  it('reflects individual geometry: different faces give measurably different carvings', () => {
    const m = (p: PumpkinFaceParams) => layoutMetrics(buildCarveLayout(p, CARVE_STYLE, NEUTRAL_EXPRESSION, pumpkinShapeFromParams(p)))
    const avg = m(pop.average!)
    expect(m(pop.wideEyes!).eyeSpacing).toBeGreaterThan(avg.eyeSpacing * 1.15)
    expect(m(pop.narrowEyes!).eyeLeftHeight).toBeLessThan(avg.eyeLeftHeight * 0.75)
    expect(m(pop.wideMouth!).mouthWidth).toBeGreaterThan(avg.mouthWidth * 1.15)
    // a smile lifts the mouth corners: same width, but a taller (curved) bounding box
    expect(m(pop.smiley!).mouthHeight).toBeGreaterThan(avg.mouthHeight * 1.1)
    // angry brows slope down towards the nose
    expect(m(pop.angry!).browLeftSlope).toBeGreaterThan(avg.browLeftSlope + 0.1)
    expect(m(pop.angry!).browRightSlope).toBeGreaterThan(avg.browRightSlope + 0.1)
    expect(m(pop.longNose!).noseWidth).toBeGreaterThan(avg.noseWidth * 1.1)
  })

  it('never collapses different people onto the same carving (no canned presets)', () => {
    const sigs = Object.entries(pop).map(([name, p]) => {
      const metrics = layoutMetrics(buildCarveLayout(p, CARVE_STYLE, NEUTRAL_EXPRESSION, pumpkinShapeFromParams(p)))
      return { name, v: Object.values(metrics) }
    })
    for (let i = 0; i < sigs.length; i++) {
      for (let j = i + 1; j < sigs.length; j++) {
        const d = sigs[i]!.v.reduce((s, x, k) => s + Math.abs(x - sigs[j]!.v[k]!), 0)
        expect(d, `${sigs[i]!.name} vs ${sigs[j]!.name}`).toBeGreaterThan(0.05)
      }
    }
  })

  it('caricatures more in CARVE than in LIVE', () => {
    const live = (p: PumpkinFaceParams) => layoutMetrics(buildCarveLayout(p, LIVE_STYLE, NEUTRAL_EXPRESSION, LIVE_PUMPKIN_SHAPE)).eyeSpacing
    const carve = (p: PumpkinFaceParams) => layoutMetrics(buildCarveLayout(p, CARVE_STYLE)).eyeSpacing
    const liveGain = live(pop.wideEyes!) / live(pop.average!)
    const carveGain = carve(pop.wideEyes!) / carve(pop.average!)
    expect(carveGain).toBeGreaterThan(liveGain)
  })

  it('keeps LIVE eye openings registered to the measured eye centres', () => {
    const p = pop.average!
    const layout = buildCarveLayout(p, LIVE_STYLE, NEUTRAL_EXPRESSION, LIVE_PUMPKIN_SHAPE)
    const eye = layout.features.find((f) => f.id === 'eyeRight')!
    const expectedX = p.eyes.right.center.x * LIVE_STYLE.faceScale
    expect(Math.abs(eye.centroid.x - expectedX)).toBeLessThan(0.04)
  })

  it('sizes the LIVE pumpkin to cover the whole head (chin to top of hair, ears), not just the face', () => {
    const p = pop.average!
    // pumpkin centre relative to the eye midpoint, in face widths (y up)
    const centreY = LIVE_HEAD_CENTER_Y
    const halfW = LIVE_HEAD_SCALE * LIVE_PUMPKIN_SHAPE.radiusX
    const halfH = LIVE_HEAD_SCALE * LIVE_PUMPKIN_SHAPE.radiusY
    // chin (canonical: -0.79 below the eye line) is covered
    const chinY = p.faceAspect - p.foreheadRatio
    expect(centreY - halfH).toBeLessThan(-chinY - 0.05)
    // skull top (~0.72) plus ~0.1 of hair is covered (top dimple included)
    const top = centreY + LIVE_HEAD_SCALE * shellRadius(LIVE_PUMPKIN_SHAPE, 0, 0)
    expect(top).toBeGreaterThan(0.8)
    // ears / hair at the sides: head width with ears ≈ 1.15 face widths
    expect(halfW).toBeGreaterThan(0.6 + 0.3)
    // the pumpkin is about twice the face width
    expect(2 * halfW).toBeGreaterThan(1.9)
  })

  it('centres the LIVE mouth opening on the measured lip line', () => {
    const p = pop.average!
    const layout = buildCarveLayout(p, LIVE_STYLE, NEUTRAL_EXPRESSION, LIVE_PUMPKIN_SHAPE)
    const mouth = layout.features.find((f) => f.id === 'mouth')!
    let minY = Infinity
    let maxY = -Infinity
    for (const q of mouth.outline) {
      if (Math.abs(q.x - mouth.centroid.x) < 0.05) {
        minY = Math.min(minY, q.y)
        maxY = Math.max(maxY, q.y)
      }
    }
    const expectedY = LIVE_STYLE.anchorY * LIVE_PUMPKIN_SHAPE.radiusY + p.mouth.center.y * LIVE_STYLE.faceScale
    expect(Math.abs((minY + maxY) / 2 - expectedY)).toBeLessThan(0.03)
  })

  it('animates expressions in LIVE: blink -> slit, open mouth -> taller opening, smile -> lifted corners', () => {
    const p = pop.average!
    const base = layoutMetrics(buildCarveLayout(p, LIVE_STYLE, NEUTRAL_EXPRESSION, LIVE_PUMPKIN_SHAPE))
    const blink = layoutMetrics(buildCarveLayout(p, LIVE_STYLE, { ...NEUTRAL_EXPRESSION, blinkLeft: 1 }, LIVE_PUMPKIN_SHAPE))
    expect(blink.eyeLeftHeight).toBeLessThan(base.eyeLeftHeight * 0.75)
    expect(blink.eyeRightHeight).toBeCloseTo(base.eyeRightHeight, 6)
    const open = layoutMetrics(buildCarveLayout(p, LIVE_STYLE, { ...NEUTRAL_EXPRESSION, mouthOpen: 1 }, LIVE_PUMPKIN_SHAPE))
    expect(open.mouthArea).toBeGreaterThan(base.mouthArea * 1.8)
    const smile = layoutMetrics(buildCarveLayout(p, LIVE_STYLE, { ...NEUTRAL_EXPRESSION, smile: 1 }, LIVE_PUMPKIN_SHAPE))
    expect(smile.mouthHeight).toBeGreaterThan(base.mouthHeight)
  })
})

describe('personalised anatomy', () => {
  it('derives deterministic, bounded pumpkin proportions from the face', () => {
    const pop = population()
    const shapes = Object.values(pop).map(pumpkinShapeFromParams)
    for (const s of shapes) {
      expect(s.radiusY).toBeGreaterThanOrEqual(0.7)
      expect(s.radiusY).toBeLessThanOrEqual(1)
      expect(s.ribs).toBeGreaterThanOrEqual(8)
      expect(s.ribs).toBeLessThanOrEqual(12)
    }
    expect(pumpkinShapeFromParams(pop.average!)).toEqual(pumpkinShapeFromParams(pop.average!))
    expect(pumpkinShapeFromParams(null)).toEqual({ ...DEFAULT_PUMPKIN_SHAPE })
    const longFace = canonicalVertices()
    shift(longFace, [152, 148, 377, 176, 400], 0, -1.5)
    expect(pumpkinShapeFromParams(paramsOf(longFace)).radiusY).toBeGreaterThan(pumpkinShapeFromParams(pop.average!).radiusY)
  })
})

describe('buildCutWalls', () => {
  it('extrudes every outline from the skin inwards', () => {
    const layout = buildCarveLayout(population().average!, CARVE_STYLE)
    const outlines = layout.features.map((f) => f.outline)
    const walls = buildCutWalls(DEFAULT_PUMPKIN_SHAPE, outlines, 0.09)
    const total = outlines.reduce((s, o) => s + o.length, 0)
    expect(walls.vertexCount).toBe(total * 2)
    expect(walls.indexCount).toBe(total * 6)
    for (let v = 0; v < walls.vertexCount; v += 2) {
      const o = [walls.positions[v * 3]!, walls.positions[v * 3 + 1]!, walls.positions[v * 3 + 2]!]
      const i = [walls.positions[v * 3 + 3]!, walls.positions[v * 3 + 4]!, walls.positions[v * 3 + 5]!]
      const ro = Math.hypot(o[0]!, o[1]!, o[2]!)
      const ri = Math.hypot(i[0]!, i[1]!, i[2]!)
      expect(ro - ri).toBeCloseTo(0.092, 3)
      expect(walls.depth[v]).toBe(0)
      expect(walls.depth[v + 1]).toBe(1)
      // outer edge sits on the skin
      const phi = Math.acos(o[1]! / ro)
      const theta = Math.atan2(o[0]!, o[2]!)
      expect(Math.abs(ro - 0.002 - shellRadius(DEFAULT_PUMPKIN_SHAPE, theta, phi))).toBeLessThan(1e-3)
    }
    for (let k = 0; k < walls.indexCount; k++) expect(walls.indices[k]).toBeLessThan(walls.vertexCount)
  })

  it('reuses a large-enough target buffer and skips outlines off the silhouette', () => {
    const first = buildCutWalls(DEFAULT_PUMPKIN_SHAPE, [[{ x: 0, y: 0 }, { x: 0.1, y: 0 }, { x: 0, y: 0.1 }]], 0.1)
    const second = buildCutWalls(DEFAULT_PUMPKIN_SHAPE, [[{ x: 0.05, y: 0 }, { x: 0.1, y: 0 }, { x: 0, y: 0.1 }]], 0.1, first)
    expect(second).toBe(first)
    const off = buildCutWalls(DEFAULT_PUMPKIN_SHAPE, [[{ x: 3, y: 0 }, { x: 3.1, y: 0 }, { x: 3, y: 0.1 }]], 0.1)
    expect(off.vertexCount).toBe(0)
  })
})

describe('animation helpers', () => {
  it('scales outlines about the centroid and staggers carve progress', () => {
    const tri = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
    ]
    const half = scaleOutline(tri, { x: 0, y: 0 }, 0.5)
    expect(half[1]).toEqual({ x: 0.5, y: 0 })
    expect(carveProgress(0, 0, 1, 0.2, 0.5)).toBe(0)
    expect(carveProgress(1.25, 0, 1, 0.2, 0.5)).toBeCloseTo(0.5)
    expect(carveProgress(1.25, 1, 1, 0.2, 0.5)).toBeCloseTo(0.1)
    expect(carveProgress(10, 5, 1, 0.2, 0.5)).toBe(1)
  })
})
