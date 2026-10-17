// Expression extraction + temporal smoothing.
//
// Expression values are in 0..1 and use DISPLAY sides (see faceMapping.ts).
// MediaPipe blendshape names refer to the SUBJECT's side ("eyeBlinkLeft" is
// the subject's left eye); in a mirrored selfie view the subject's left eye is
// on the display left, in an unmirrored photo it is on the display right.

import { clamp01, smoothstep } from './math'
import { REFERENCE_FACE, type PumpkinFaceParams } from './faceMapping'

export type BlendshapeMap = Readonly<Record<string, number>>

export interface ExpressionState {
  /** Eye closure of the display-left / display-right eye. */
  blinkLeft: number
  blinkRight: number
  smile: number
  mouthOpen: number
  browRaise: number
  browFrown: number
}

export const NEUTRAL_EXPRESSION: ExpressionState = Object.freeze({
  blinkLeft: 0,
  blinkRight: 0,
  smile: 0,
  mouthOpen: 0,
  browRaise: 0,
  browFrown: 0,
})

export function blendshapesToMap(
  categories: ReadonlyArray<{ categoryName: string; score: number }> | null | undefined,
): BlendshapeMap | null {
  if (!categories || categories.length === 0) return null
  const map: Record<string, number> = {}
  for (const c of categories) {
    if (c && typeof c.categoryName === 'string' && Number.isFinite(c.score)) map[c.categoryName] = c.score
  }
  return Object.keys(map).length ? map : null
}

function bs(map: BlendshapeMap | null | undefined, name: string): number | null {
  const v = map?.[name]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * Combines geometric measurements (always available, side-correct) with
 * blendshape scores (person-normalised by the model, when available).
 */
export function deriveExpression(params: PumpkinFaceParams, blendshapes?: BlendshapeMap | null): ExpressionState {
  const mirrored = params.mirrored
  // Geometric fallbacks.
  const geoBlink = (openness: number) => 1 - smoothstep(0.07, 0.2, openness)
  const meanLift = (params.mouth.cornerLiftLeft + params.mouth.cornerLiftRight) / 2
  const geoSmile = smoothstep(0.01, 0.09, meanLift - REFERENCE_FACE.mouthCornerLift)
  const geoOpen = smoothstep(0.06, 0.45, params.mouth.openness)
  const meanBrowLift = (params.brows.left.lift + params.brows.right.lift) / 2
  const geoBrowRaise = smoothstep(0.015, 0.06, meanBrowLift - REFERENCE_FACE.browLift)

  const subjL = (name: string) => bs(blendshapes, `${name}Left`)
  const subjR = (name: string) => bs(blendshapes, `${name}Right`)
  const dispL = (name: string) => (mirrored ? subjL(name) : subjR(name))
  const dispR = (name: string) => (mirrored ? subjR(name) : subjL(name))

  const blinkScore = (v: number | null, geo: number) => (v === null ? geo : Math.max(smoothstep(0.32, 0.62, v), geo * 0.6))

  const smileL = subjL('mouthSmile')
  const smileR = subjR('mouthSmile')
  const smileBs = smileL !== null && smileR !== null ? smoothstep(0.08, 0.65, (smileL + smileR) / 2) : null

  const jaw = bs(blendshapes, 'jawOpen')
  const openBs = jaw !== null ? smoothstep(0.04, 0.55, jaw) : null

  const inner = bs(blendshapes, 'browInnerUp')
  const outerL = subjL('browOuterUp')
  const outerR = subjR('browOuterUp')
  const raiseBs =
    inner !== null ? smoothstep(0.12, 0.65, Math.max(inner, ((outerL ?? 0) + (outerR ?? 0)) / 2)) : null

  const downL = subjL('browDown')
  const downR = subjR('browDown')
  const frownBs = downL !== null && downR !== null ? smoothstep(0.08, 0.55, (downL + downR) / 2) : null

  return {
    blinkLeft: clamp01(blinkScore(dispL('eyeBlink'), geoBlink(params.eyes.left.openness))),
    blinkRight: clamp01(blinkScore(dispR('eyeBlink'), geoBlink(params.eyes.right.openness))),
    smile: clamp01(smileBs === null ? geoSmile : Math.max(smileBs, geoSmile * 0.7)),
    mouthOpen: clamp01(openBs === null ? geoOpen : Math.max(openBs, geoOpen)),
    browRaise: clamp01(raiseBs === null ? geoBrowRaise : Math.max(raiseBs, geoBrowRaise * 0.7)),
    browFrown: clamp01(frownBs ?? 0),
  }
}

/** Glow response to expression: an open mouth "roars", a smile warms the flame. */
export function expressionGlow(e: ExpressionState): { intensity: number; warmth: number } {
  return {
    intensity: 1 + 0.55 * e.mouthOpen + 0.15 * e.smile,
    warmth: clamp01(0.5 + 0.5 * e.smile - 0.25 * e.browFrown),
  }
}

// ---------------------------------------------------------------------------
// Smoothing

/**
 * One Euro filter (Casiez et al. 2012): low jitter when still, low lag when
 * moving. `t` is in seconds.
 */
export class OneEuroFilter {
  private prev: number | null = null
  private dPrev = 0
  private tPrev = 0

  constructor(
    public minCutoff = 1.0,
    public beta = 0.0,
    public dCutoff = 1.0,
  ) {}

  private static alpha(cutoff: number, dt: number): number {
    const tau = 1 / (2 * Math.PI * cutoff)
    return 1 / (1 + tau / dt)
  }

  reset(): void {
    this.prev = null
    this.dPrev = 0
  }

  filter(x: number, t: number): number {
    if (this.prev === null || !Number.isFinite(this.prev)) {
      this.prev = x
      this.tPrev = t
      this.dPrev = 0
      return x
    }
    const dt = Math.max(1e-3, t - this.tPrev)
    this.tPrev = t
    const dx = (x - this.prev) / dt
    const aD = OneEuroFilter.alpha(this.dCutoff, dt)
    this.dPrev = this.dPrev + aD * (dx - this.dPrev)
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dPrev)
    const a = OneEuroFilter.alpha(cutoff, dt)
    this.prev = this.prev + a * (x - this.prev)
    return this.prev
  }
}

/** One Euro filter over a fixed-length numeric vector. */
export class OneEuroVector {
  private filters: OneEuroFilter[]
  private out: Float32Array

  constructor(size: number, minCutoff = 1.0, beta = 0.0, dCutoff = 1.0) {
    this.filters = Array.from({ length: size }, () => new OneEuroFilter(minCutoff, beta, dCutoff))
    this.out = new Float32Array(size)
  }

  get size(): number {
    return this.filters.length
  }

  reset(): void {
    for (const f of this.filters) f.reset()
  }

  filter(values: ArrayLike<number>, t: number): Float32Array {
    const n = Math.min(values.length, this.filters.length)
    for (let i = 0; i < n; i++) this.out[i] = this.filters[i]!.filter(values[i]!, t)
    return this.out
  }
}

/** Frame-rate independent exponential approach (used to interpolate between detections). */
export function dampFactor(dtSeconds: number, timeConstantSeconds: number): number {
  if (timeConstantSeconds <= 0) return 1
  return 1 - Math.exp(-Math.max(0, dtSeconds) / timeConstantSeconds)
}

export function smoothExpression(
  current: ExpressionState,
  target: ExpressionState,
  dtSeconds: number,
  timeConstant = 0.06,
): ExpressionState {
  const k = dampFactor(dtSeconds, timeConstant)
  // Blinks are fast: close quickly, open a little slower.
  const kBlinkClose = dampFactor(dtSeconds, timeConstant * 0.35)
  const blink = (c: number, t: number) => c + (t - c) * (t > c ? kBlinkClose : k)
  return {
    blinkLeft: blink(current.blinkLeft, target.blinkLeft),
    blinkRight: blink(current.blinkRight, target.blinkRight),
    smile: current.smile + (target.smile - current.smile) * k,
    mouthOpen: current.mouthOpen + (target.mouthOpen - current.mouthOpen) * k,
    browRaise: current.browRaise + (target.browRaise - current.browRaise) * k,
    browFrown: current.browFrown + (target.browFrown - current.browFrown) * k,
  }
}
