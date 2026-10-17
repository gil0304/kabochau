// Device quality tiers + an adaptive governor that steps quality down when
// frames are consistently slow (mobile thermals, low-end GPUs).

export interface QualityTier {
  name: 'high' | 'medium' | 'low'
  /** Max devicePixelRatio used for the canvas. */
  maxPixelRatio: number
  bloom: boolean
  msaaSamples: number
  maskSize: number
  shellSegments: [number, number]
  textures: 'high' | 'low'
  /** People tracked / carved at once (each gets its own pumpkin). */
  maxFaces: number
}

const TIERS: Record<QualityTier['name'], QualityTier> = {
  high: { name: 'high', maxPixelRatio: 2, bloom: true, msaaSamples: 4, maskSize: 1024, shellSegments: [144, 96], textures: 'high', maxFaces: 4 },
  medium: { name: 'medium', maxPixelRatio: 1.75, bloom: true, msaaSamples: 0, maskSize: 1024, shellSegments: [112, 80], textures: 'high', maxFaces: 4 },
  low: { name: 'low', maxPixelRatio: 1.25, bloom: false, msaaSamples: 0, maskSize: 512, shellSegments: [80, 56], textures: 'low', maxFaces: 2 },
}

export function detectQualityTier(): QualityTier {
  if (typeof navigator === 'undefined') return TIERS.medium
  const nav = navigator as Navigator & { deviceMemory?: number }
  const memory = nav.deviceMemory ?? 4
  const cores = nav.hardwareConcurrency ?? 4
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
  if (memory <= 2 || cores <= 2) return TIERS.low
  if (coarse) return TIERS.medium
  return TIERS.high
}

export function lowerTier(t: QualityTier): QualityTier {
  return t.name === 'high' ? TIERS.medium : TIERS.low
}

/**
 * Tracks frame time; returns a reduced pixel ratio / bloom decision when the
 * average stays above the budget. Never steps back up automatically (avoids
 * oscillation); a remount resets it.
 */
export class FrameGovernor {
  private samples: number[] = []
  private cooldownUntil = 0
  pixelRatio: number
  bloom: boolean

  constructor(
    initialPixelRatio: number,
    bloom: boolean,
    private budgetMs = 30,
    private minPixelRatio = 0.75,
  ) {
    this.pixelRatio = initialPixelRatio
    this.bloom = bloom
  }

  /** Returns true when settings changed. */
  push(frameMs: number, nowMs: number): boolean {
    if (!Number.isFinite(frameMs) || frameMs <= 0 || frameMs > 500) return false
    this.samples.push(frameMs)
    if (this.samples.length > 90) this.samples.shift()
    if (nowMs < this.cooldownUntil || this.samples.length < 90) return false
    const avg = this.samples.reduce((a, b) => a + b, 0) / this.samples.length
    if (avg <= this.budgetMs) return false
    this.samples = []
    this.cooldownUntil = nowMs + 2500
    if (this.pixelRatio > this.minPixelRatio + 0.01) {
      this.pixelRatio = Math.max(this.minPixelRatio, this.pixelRatio - 0.25)
      return true
    }
    if (this.bloom) {
      this.bloom = false
      return true
    }
    return false
  }
}
