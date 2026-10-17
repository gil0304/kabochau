import { describe, expect, it } from 'vitest'
import { MAX_PHOTO_EDGE, fitWithin } from '../app/utils/photo'

describe('fitWithin (photo downscale before detection)', () => {
  it('caps the longest edge and keeps the aspect ratio', () => {
    expect(fitWithin(4032, 3024)).toEqual({ width: MAX_PHOTO_EDGE, height: 960 })
    expect(fitWithin(3024, 4032)).toEqual({ width: 960, height: MAX_PHOTO_EDGE })
  })
  it('never upscales small images', () => {
    expect(fitWithin(640, 480)).toEqual({ width: 640, height: 480 })
  })
  it('handles empty / invalid sizes', () => {
    expect(fitWithin(0, 100)).toEqual({ width: 0, height: 0 })
    expect(fitWithin(Number.NaN, 100)).toEqual({ width: 0, height: 0 })
  })
})
