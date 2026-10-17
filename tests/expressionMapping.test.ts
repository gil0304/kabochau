import { describe, expect, it } from 'vitest'
import {
  NEUTRAL_EXPRESSION,
  OneEuroFilter,
  OneEuroVector,
  blendshapesToMap,
  dampFactor,
  deriveExpression,
  expressionGlow,
  smoothExpression,
} from '../app/utils/expressionMapping'
import { landmarksToParams } from '../app/utils/faceMapping'
import { EYE_L, EYE_R } from '../app/utils/landmarkIndices'
import { canonicalVertices, projectToLandmarks, scaleAbout } from './helpers/faceFixture'

const neutralParams = (mirrored: boolean) => landmarksToParams(projectToLandmarks(canonicalVertices()), 1280, 720, mirrored)!

describe('blendshapesToMap', () => {
  it('ignores empty or malformed categories', () => {
    expect(blendshapesToMap(undefined)).toBeNull()
    expect(blendshapesToMap([])).toBeNull()
    expect(blendshapesToMap([{ categoryName: 'jawOpen', score: Number.NaN }])).toBeNull()
    expect(blendshapesToMap([{ categoryName: 'jawOpen', score: 0.4 }])).toEqual({ jawOpen: 0.4 })
  })
})

describe('deriveExpression', () => {
  it('is neutral for the average face without blendshapes', () => {
    const e = deriveExpression(neutralParams(true), null)
    expect(e.blinkLeft).toBeLessThan(0.05)
    expect(e.blinkRight).toBeLessThan(0.05)
    expect(e.smile).toBeLessThan(0.1)
    expect(e.browFrown).toBe(0)
  })

  it('maps subject-side blendshapes to display sides according to mirroring', () => {
    const shapes = { eyeBlinkLeft: 0.9, eyeBlinkRight: 0.02 }
    const selfie = deriveExpression(neutralParams(true), shapes)
    expect(selfie.blinkLeft).toBeGreaterThan(0.9)
    expect(selfie.blinkRight).toBeLessThan(0.1)
    const photo = deriveExpression(neutralParams(false), shapes)
    expect(photo.blinkRight).toBeGreaterThan(0.9)
    expect(photo.blinkLeft).toBeLessThan(0.1)
  })

  it('falls back to geometry when blendshapes are missing', () => {
    const v = canonicalVertices()
    scaleAbout(v, [...EYE_R.contour, ...EYE_L.contour], 1, 0.15)
    const closed = landmarksToParams(projectToLandmarks(v), 1280, 720, true)!
    const e = deriveExpression(closed, null)
    expect(e.blinkLeft).toBeGreaterThan(0.9)
    expect(e.blinkRight).toBeGreaterThan(0.9)
  })

  it('keeps every channel inside 0..1 for out-of-range scores', () => {
    const e = deriveExpression(neutralParams(true), {
      jawOpen: 5,
      mouthSmileLeft: 3,
      mouthSmileRight: 3,
      browInnerUp: -2,
      browDownLeft: 9,
      browDownRight: 9,
    })
    for (const v of Object.values(e)) {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
    }
    expect(expressionGlow(e).intensity).toBeGreaterThan(1)
  })
})

describe('smoothing', () => {
  it('One Euro: passes constants through and suppresses jitter', () => {
    const f = new OneEuroFilter(1.5, 0.01)
    for (let i = 0; i < 30; i++) expect(f.filter(2, i / 30)).toBeCloseTo(2, 6)
    const g = new OneEuroFilter(1.0, 0.0)
    let rawVar = 0
    let outVar = 0
    let seed = 1
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.1
    for (let i = 0; i < 300; i++) {
      const raw = 1 + rnd()
      const out = g.filter(raw, i / 30)
      if (i > 30) {
        rawVar += (raw - 1) ** 2
        outVar += (out - 1) ** 2
      }
    }
    expect(outVar).toBeLessThan(rawVar * 0.5)
  })

  it('One Euro: follows a step change', () => {
    const f = new OneEuroFilter(1.0, 0.5)
    f.filter(0, 0)
    let v = 0
    for (let i = 1; i <= 30; i++) v = f.filter(1, i / 30)
    expect(v).toBeGreaterThan(0.9)
    f.reset()
    expect(f.filter(5, 2)).toBe(5)
  })

  it('vector filter and damping are frame-rate independent', () => {
    const vf = new OneEuroVector(3)
    expect(Array.from(vf.filter([1, 2, 3], 0))).toEqual([1, 2, 3])
    // two 8 ms steps == one 16 ms step
    const a = 1 - (1 - dampFactor(0.008, 0.05)) ** 2
    expect(a).toBeCloseTo(dampFactor(0.016, 0.05), 10)
    expect(dampFactor(0.016, 0)).toBe(1)
    const s = smoothExpression(NEUTRAL_EXPRESSION, { ...NEUTRAL_EXPRESSION, blinkLeft: 1, smile: 1 }, 0.016)
    // blinks close faster than other channels move
    expect(s.blinkLeft).toBeGreaterThan(s.smile)
  })
})
