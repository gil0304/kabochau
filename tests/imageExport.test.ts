import { describe, expect, it } from 'vitest'
import {
  EXPORT_HEIGHT,
  EXPORT_WIDTH,
  chooseExportSize,
  coverCrop,
  exportFileName,
  fitDistanceForSphere,
  liveExportCrop,
  liveFaceDepth,
  projectedSphereFraction,
  sourcePixelScale,
  sourceToViewport,
  videoUvTransform,
} from '../app/utils/imageExport'

describe('coverCrop', () => {
  it('crops the wider dimension and preserves aspect ratio', () => {
    // 16:9 landscape camera into a 9:19.5 phone screen
    const c = coverCrop(1280, 720, 390, 844)
    expect(c.h).toBe(1)
    expect((c.w * 1280) / (c.h * 720)).toBeCloseTo(390 / 844, 6)
    expect(c.x).toBeCloseTo((1 - c.w) / 2, 6)
    // portrait camera into a landscape window
    const d = coverCrop(720, 1280, 1600, 900)
    expect(d.w).toBe(1)
    expect((d.w * 720) / (d.h * 1280)).toBeCloseTo(1600 / 900, 6)
  })

  it('recentres on a focus point but never leaves the source', () => {
    const c = coverCrop(1920, 1080, 1080, 1920, { x: 0.95, y: 0.5 })
    expect(c.x + c.w).toBeCloseTo(1, 6)
    const d = coverCrop(1920, 1080, 1080, 1920, { x: 0.02, y: 0.5 })
    expect(d.x).toBe(0)
  })

  it('degrades safely for invalid sizes', () => {
    expect(coverCrop(0, 720, 100, 100)).toEqual({ x: 0, y: 0, w: 1, h: 1 })
  })
})

describe('preview / export registration', () => {
  it('maps the same source point consistently at any output resolution', () => {
    const crop = coverCrop(1280, 720, 1080, 1920)
    const p = { x: 0.52, y: 0.4 }
    const small = sourceToViewport(p, crop, 270, 480)
    const big = sourceToViewport(p, crop, 1080, 1920)
    expect(big.x / 1080).toBeCloseTo(small.x / 270, 9)
    expect(big.y / 1920).toBeCloseTo(small.y / 480, 9)
    // uniform scale: x and y scale factors agree
    const sx = sourcePixelScale(1280, crop, 1080)
    expect(sx).toBeCloseTo(1920 / (crop.h * 720), 9)
  })

  it('mirrors the camera texture in UV space (no CSS transforms)', () => {
    const crop = { x: 0.2, y: 0, w: 0.6, h: 1 }
    const m = videoUvTransform(crop, true)
    // viewport left edge samples the right edge of the crop in the raw camera image
    expect(0 * m.sx + m.ox).toBeCloseTo(0.8, 9)
    expect(1 * m.sx + m.ox).toBeCloseTo(0.2, 9)
    const n = videoUvTransform(crop, false)
    expect(0 * n.sx + n.ox).toBeCloseTo(0.2, 9)
    // v: bottom of viewport (v=0) samples the bottom of the crop (texture v = 1 - y_bottom)
    const c2 = { x: 0, y: 0.1, w: 1, h: 0.5 }
    const t = videoUvTransform(c2, false)
    expect(0 * t.sy + t.oy).toBeCloseTo(1 - 0.6, 9)
    expect(1 * t.sy + t.oy).toBeCloseTo(1 - 0.1, 9)
  })

  it('a display point and its texture sample agree (mirror round trip)', () => {
    const crop = coverCrop(1280, 720, 390, 844)
    for (const mirrored of [true, false]) {
      const tf = videoUvTransform(crop, mirrored)
      // a landmark at raw-camera x = 0.3 appears at display x = mirrored ? 0.7 : 0.3
      const rawX = 0.45
      const dispX = mirrored ? 1 - rawX : rawX
      const vp = sourceToViewport({ x: dispX, y: 0.5 }, crop, 390, 844)
      const u = vp.x / 390
      expect(u * tf.sx + tf.ox).toBeCloseTo(rawX, 9)
    }
  })
})

describe('liveExportCrop', () => {
  it('matches the preview centre on a portrait phone', () => {
    const preview = coverCrop(720, 1280, 390, 844)
    const exp = liveExportCrop(720, 1280, preview, [{ anchor: { x: 0.5, y: 0.45 }, radius: 0.2 }])
    expect(exp.x + exp.w / 2).toBeCloseTo(preview.x + preview.w / 2, 6)
    expect((exp.w * 720) / (exp.h * 1280)).toBeCloseTo(EXPORT_WIDTH / EXPORT_HEIGHT, 6)
  })

  it('keeps an off-centre face inside the 9:16 frame on a landscape desktop camera', () => {
    const preview = coverCrop(1280, 720, 1600, 900)
    const face = { anchor: { x: 0.8, y: 0.5 }, radius: 0.08 }
    const exp = liveExportCrop(1280, 720, preview, [face])
    expect(face.anchor.x - face.radius).toBeGreaterThanOrEqual(exp.x - 1e-9)
    expect(face.anchor.x + face.radius).toBeLessThanOrEqual(exp.x + exp.w + 1e-9)
    expect(exp.x + exp.w).toBeLessThanOrEqual(1 + 1e-9)
  })

  it('keeps every person of a group inside the frame when they fit', () => {
    const preview = coverCrop(1280, 720, 1600, 900)
    const faces = [
      { anchor: { x: 0.42, y: 0.5 }, radius: 0.05 },
      { anchor: { x: 0.58, y: 0.45 }, radius: 0.05 },
    ]
    const exp = liveExportCrop(1280, 720, preview, faces)
    for (const f of faces) {
      expect(f.anchor.x - f.radius).toBeGreaterThanOrEqual(exp.x - 1e-9)
      expect(f.anchor.x + f.radius).toBeLessThanOrEqual(exp.x + exp.w + 1e-9)
    }
  })

  it('zooms out (letterbox) instead of cutting people off when a group is wider than 9:16', () => {
    const preview = coverCrop(1280, 720, 1600, 900)
    const faces = [
      { anchor: { x: 0.3, y: 0.5 }, radius: 0.12 },
      { anchor: { x: 0.72, y: 0.48 }, radius: 0.12 },
    ]
    const exp = liveExportCrop(1280, 720, preview, faces)
    for (const f of faces) {
      expect(f.anchor.x - f.radius).toBeGreaterThanOrEqual(exp.x - 1e-9)
      expect(f.anchor.x + f.radius).toBeLessThanOrEqual(exp.x + exp.w + 1e-9)
    }
    // still exactly 9:16, centred vertically on the frame with bars above and below
    expect((exp.w * 1280) / (exp.h * 720)).toBeCloseTo(EXPORT_WIDTH / EXPORT_HEIGHT, 6)
    expect(exp.h).toBeGreaterThan(1)
    expect(exp.y + exp.h / 2).toBeCloseTo(0.5, 6)
    // the far edges of the frame: crop spans the whole width, centred
    const wide = liveExportCrop(1280, 720, preview, [
      { anchor: { x: 0.08, y: 0.5 }, radius: 0.08 },
      { anchor: { x: 0.92, y: 0.5 }, radius: 0.08 },
    ])
    expect(wide.w).toBeGreaterThanOrEqual(1)
    expect(wide.x + wide.w / 2).toBeCloseTo(0.5, 6)
  })

  it('does not zoom out just because big pumpkin heads overhang a portrait frame', () => {
    // two people filling a portrait phone frame; their pumpkins reach past the edges
    const preview = coverCrop(720, 1280, 390, 844)
    const faces = [
      { anchor: { x: 0.25, y: 0.42 }, radius: 0.46 },
      { anchor: { x: 0.75, y: 0.42 }, radius: 0.46 },
    ]
    const exp = liveExportCrop(720, 1280, preview, faces)
    expect(exp.w).toBeLessThanOrEqual(1 + 1e-9)
    expect(exp.h).toBeLessThanOrEqual(1 + 1e-9)
    expect(exp.x).toBeGreaterThanOrEqual(0)
    // no faces: plain preview-centred crop
    const plain = liveExportCrop(1280, 720, preview, [])
    expect(plain.x + plain.w / 2).toBeCloseTo(preview.x + preview.w / 2, 6)
  })
})

describe('liveFaceDepth', () => {
  it('puts nearer (bigger) faces closer and keeps the projected size unchanged', () => {
    const near = liveFaceDepth(0.5)
    const far = liveFaceDepth(0.2)
    expect(near).toBeLessThan(far)
    expect(liveFaceDepth(0.35)).toBeCloseTo(10, 9)
    // world size scales with depth, so projected size = worldSize / depth is invariant
    const worldSize = (d: number, faceWidthPx: number) => faceWidthPx * ((2 * d * Math.tan(Math.PI / 22.5)) / 1920)
    expect(worldSize(near, 300) / near).toBeCloseTo(worldSize(far, 300) / far, 12)
    expect(liveFaceDepth(Number.NaN)).toBeCloseTo(10, 9)
    expect(liveFaceDepth(10)).toBeCloseTo(4, 9)
  })
})

describe('export sizing & framing', () => {
  it('uses 1080x1920 when supported and an explicit fallback otherwise', () => {
    expect(chooseExportSize(8192)).toEqual({ width: 1080, height: 1920, fallback: false })
    expect(chooseExportSize(1024)).toEqual({ width: 720, height: 1280, fallback: true })
    expect(chooseExportSize(8192, Infinity, true).fallback).toBe(true)
  })

  it('fits the whole pumpkin in a 9:16 frame', () => {
    const fov = 30
    const aspect = 1080 / 1920
    const radius = 1.25
    const d = fitDistanceForSphere(radius, fov, aspect, 0.08)
    // narrow dimension is horizontal: projected radius in x must be <= 1 - margin
    const fracY = projectedSphereFraction(radius, d, fov)
    const fracX = fracY / aspect
    expect(fracX).toBeLessThanOrEqual(0.84 + 1e-6)
    expect(fracX).toBeGreaterThan(0.8)
    expect(fracY).toBeLessThan(1)
  })

  it('creates timestamped PNG names', () => {
    expect(exportFileName('carve', new Date(2026, 9, 31, 21, 5, 9))).toBe('pumpkin-me-make-20261031-210509.png')
  })
})
