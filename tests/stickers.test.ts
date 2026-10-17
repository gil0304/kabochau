import { describe, expect, it } from 'vitest'
import { STICKERS, STICKER_BY_ID, isStickerId, type StickerDef } from '../app/utils/stickerCatalog'
import {
  MAX_STICKERS,
  STICKER_MAX_WIDTH,
  STICKER_MIN_WIDTH,
  clampSticker,
  createSticker,
  moveSticker,
  rotateSticker,
  scaleSticker,
  stickerCssPlacement,
  stickerDrawTransform,
  stickersSignature,
  transformSticker,
  type PlacedSticker,
} from '../app/utils/stickers'
import { containSize } from '../app/utils/imageExport'

// --- minimal SVG path reader: validates argument counts and collects every
// absolute coordinate (end + control points) so we can check the art stays
// inside its viewBox. Path2D silently drops everything after a syntax error,
// so a typo would otherwise only show up as a half-drawn stamp.
const ARGS: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 }

function readPath(d: string): { points: { x: number; y: number }[] } {
  const tokens = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/g) ?? []
  expect(tokens.join('').length).toBeGreaterThan(0)
  const points: { x: number; y: number }[] = []
  let i = 0
  let cx = 0
  let cy = 0
  let sx = 0
  let sy = 0
  let cmd = ''
  while (i < tokens.length) {
    const t = tokens[i]!
    if (/[a-zA-Z]/.test(t)) {
      cmd = t
      i++
      if (cmd.toUpperCase() === 'Z') {
        cx = sx
        cy = sy
        continue
      }
    }
    const upper = cmd.toUpperCase()
    const n = ARGS[upper]
    if (n === undefined) throw new Error(`unsupported command ${cmd} in ${d}`)
    const nums = tokens.slice(i, i + n).map(Number)
    if (nums.length !== n || nums.some((v) => !Number.isFinite(v))) throw new Error(`bad arguments for ${cmd} in ${d}`)
    i += n
    const rel = cmd !== upper
    const X = (v: number) => (rel ? cx + v : v)
    const Y = (v: number) => (rel ? cy + v : v)
    switch (upper) {
      case 'M':
      case 'L':
      case 'T':
        cx = X(nums[0]!)
        cy = Y(nums[1]!)
        if (upper === 'M') {
          sx = cx
          sy = cy
          if (cmd === 'M') cmd = 'L'
          else cmd = 'l'
        }
        points.push({ x: cx, y: cy })
        break
      case 'H':
        cx = X(nums[0]!)
        points.push({ x: cx, y: cy })
        break
      case 'V':
        cy = rel ? cy + nums[0]! : nums[0]!
        points.push({ x: cx, y: cy })
        break
      case 'C':
      case 'S':
      case 'Q': {
        for (let k = 0; k < n; k += 2) points.push({ x: X(nums[k]!), y: Y(nums[k + 1]!) })
        cx = X(nums[n - 2]!)
        cy = Y(nums[n - 1]!)
        break
      }
      case 'A':
        expect(nums[0]).toBeGreaterThan(0)
        expect(nums[1]).toBeGreaterThan(0)
        expect([0, 1]).toContain(nums[3])
        expect([0, 1]).toContain(nums[4])
        cx = X(nums[5]!)
        cy = Y(nums[6]!)
        points.push({ x: cx, y: cy })
        break
    }
  }
  return { points }
}

const sticker = (over: Partial<PlacedSticker> = {}): PlacedSticker => ({
  uid: 't',
  type: 'ghost',
  x: 0.5,
  y: 0.5,
  w: 0.3,
  rotation: 0,
  ...over,
})

describe('sticker catalog', () => {
  it('has unique ids, accessible labels and sane sizes', () => {
    const ids = STICKERS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(STICKERS.length).toBeGreaterThanOrEqual(12)
    for (const s of STICKERS) {
      expect(s.label.trim().length).toBeGreaterThan(0)
      expect(s.width).toBeGreaterThan(0)
      expect(s.height).toBeGreaterThan(0)
      expect(s.defaultWidth).toBeGreaterThanOrEqual(STICKER_MIN_WIDTH)
      expect(s.defaultWidth).toBeLessThanOrEqual(0.8)
      expect(s.layers.length).toBeGreaterThan(0)
      expect(STICKER_BY_ID[s.id]).toBe(s)
      expect(isStickerId(s.id)).toBe(true)
    }
    expect(isStickerId('nope')).toBe(false)
  })

  it('uses well-formed path data that stays inside each viewBox', () => {
    const margin = 1
    for (const s of STICKERS) {
      for (const l of s.layers) {
        if (l.kind !== 'path') continue
        const { points } = readPath(l.d)
        expect(points.length, `${s.id} has an empty path`).toBeGreaterThan(1)
        for (const p of points) {
          expect(p.x, `${s.id} x`).toBeGreaterThanOrEqual(-margin)
          expect(p.x, `${s.id} x`).toBeLessThanOrEqual(s.width + margin)
          expect(p.y, `${s.id} y`).toBeGreaterThanOrEqual(-margin)
          expect(p.y, `${s.id} y`).toBeLessThanOrEqual(s.height + margin)
        }
      }
    }
  })

  it('keeps text runs within the stamp width and every fill/stroke defined', () => {
    for (const s of STICKERS) {
      for (const l of s.layers) {
        if (l.kind === 'text') {
          expect(l.text.trim().length).toBeGreaterThan(0)
          expect(l.x - l.width / 2).toBeGreaterThanOrEqual(0)
          expect(l.x + l.width / 2).toBeLessThanOrEqual(s.width)
          expect(l.y).toBeLessThanOrEqual(s.height)
          expect(l.y - l.size * 0.75).toBeGreaterThanOrEqual(0)
        } else {
          expect(l.fill || l.stroke, `${s.id} layer paints nothing`).toBeTruthy()
        }
      }
      if (s.layers.some((l) => l.outline)) expect(s.outline).not.toBeNull()
    }
  })
})

describe('sticker placement', () => {
  const def = STICKER_BY_ID.ghost as StickerDef

  it('creates stamps near the centre without stacking them exactly', () => {
    const placed = Array.from({ length: MAX_STICKERS }, (_, i) => createSticker(def, i, `s${i}`))
    for (const p of placed) {
      expect(p.x).toBeGreaterThan(0.2)
      expect(p.x).toBeLessThan(0.8)
      expect(p.y).toBeGreaterThan(0.15)
      expect(p.y).toBeLessThan(0.7)
      expect(p.w).toBe(def.defaultWidth)
    }
    const keys = new Set(placed.map((p) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`))
    expect(keys.size).toBe(placed.length)
  })

  it('moves by frame pixels and keeps the centre on the image', () => {
    const frame = { w: 300, h: 600 }
    const m = moveSticker(sticker(), 30, -60, frame)
    expect(m.x).toBeCloseTo(0.6, 9)
    expect(m.y).toBeCloseTo(0.4, 9)
    const off = moveSticker(sticker(), 5000, 5000, frame)
    expect(off.x).toBe(1)
    expect(off.y).toBe(1)
  })

  it('pinch: scales, rotates and follows the fingers', () => {
    const frame = { w: 400, h: 800 }
    const s = sticker({ x: 0.5, y: 0.5, w: 0.2 })
    // fingers centred on the stamp spread to double distance and turn 90° clockwise
    const a0 = { x: 150, y: 400 }
    const b0 = { x: 250, y: 400 }
    const a1 = { x: 200, y: 300 }
    const b1 = { x: 200, y: 500 }
    const t = transformSticker(s, a0, b0, a1, b1, frame)
    expect(t.w).toBeCloseTo(0.4, 9)
    expect(t.rotation).toBeCloseTo(Math.PI / 2, 9)
    expect(t.x).toBeCloseTo(0.5, 9)
    expect(t.y).toBeCloseTo(0.5, 9)
    // pure two-finger pan moves the centre by the same amount
    const pan = transformSticker(s, a0, b0, { x: 190, y: 440 }, { x: 290, y: 440 }, frame)
    expect(pan.w).toBeCloseTo(0.2, 9)
    expect(pan.rotation).toBeCloseTo(0, 9)
    expect(pan.x).toBeCloseTo(0.5 + 40 / 400, 9)
    expect(pan.y).toBeCloseTo(0.5 + 40 / 800, 9)
  })

  it('corner handle: rotates and scales in place around the centre', () => {
    const frame = { w: 400, h: 800 }
    const s = sticker({ x: 0.25, y: 0.75, w: 0.3 })
    const c = { x: 100, y: 600 }
    const t = transformSticker(s, c, { x: 160, y: 660 }, c, { x: 100, y: 600 + 60 * Math.SQRT2 * 1.5 }, frame)
    expect(t.x).toBeCloseTo(0.25, 9)
    expect(t.y).toBeCloseTo(0.75, 9)
    expect(t.w).toBeCloseTo(0.45, 9)
    expect(t.rotation).toBeCloseTo(Math.PI / 4, 9)
  })

  it('clamps size and wraps rotation; ignores degenerate gestures', () => {
    expect(scaleSticker(sticker(), 100).w).toBe(STICKER_MAX_WIDTH)
    expect(scaleSticker(sticker(), 0.001).w).toBe(STICKER_MIN_WIDTH)
    const r = rotateSticker(sticker({ rotation: 3 }), 1)
    expect(r.rotation).toBeCloseTo(4 - 2 * Math.PI, 9)
    const p = { x: 10, y: 10 }
    expect(transformSticker(sticker(), p, p, p, { x: 20, y: 10 }, { w: 100, h: 100 })).toEqual(sticker())
    const fixed = clampSticker(sticker({ x: Number.NaN, w: Number.POSITIVE_INFINITY, rotation: Number.NaN }))
    expect(fixed.x).toBe(0.5)
    expect(fixed.w).toBeLessThanOrEqual(STICKER_MAX_WIDTH)
    expect(fixed.rotation).toBe(0)
  })
})

describe('editor ↔ export agreement', () => {
  it('maps the same normalised stamp to CSS % and to export pixels', () => {
    const def = STICKER_BY_ID.bat as StickerDef
    const s = sticker({ type: 'bat', x: 0.25, y: 0.1, w: 0.4, rotation: -0.3 })
    const t = stickerDrawTransform(s, def, 1080, 1920)
    expect(t.tx).toBeCloseTo(270, 9)
    expect(t.ty).toBeCloseTo(192, 9)
    expect(t.width).toBeCloseTo(432, 9)
    expect(t.height / t.width).toBeCloseTo(def.height / def.width, 9)
    expect(t.rotation).toBe(-0.3)
    const css = stickerCssPlacement(s, def)
    expect(css.left).toBe('25.0000%')
    expect(css.top).toBe('10.0000%')
    expect(css.width).toBe('40.0000%')
    expect(css.aspectRatio).toBe(`${def.width} / ${def.height}`)
    expect(css.transform).toContain('rotate(-0.30000rad)')
    // a smaller fallback export scales everything proportionally
    const small = stickerDrawTransform(s, def, 720, 1280)
    expect(small.tx / 720).toBeCloseTo(t.tx / 1080, 9)
    expect(small.width / 720).toBeCloseTo(t.width / 1080, 9)
  })

  it('fits the preview frame to the PNG aspect ratio', () => {
    expect(containSize(390, 600, 9 / 16)).toEqual({ w: 600 * (9 / 16), h: 600 })
    const wide = containSize(300, 900, 9 / 16)
    expect(wide.w).toBe(300)
    expect(wide.h).toBeCloseTo(300 * (16 / 9), 9)
    expect(containSize(0, 100, 1)).toEqual({ w: 0, h: 0 })
  })

  it('changes the cache signature whenever a stamp changes', () => {
    const a = [sticker(), sticker({ uid: 'u', type: 'bat', x: 0.2 })]
    const b = [a[0]!, { ...a[1]!, rotation: 0.01 }]
    expect(stickersSignature(a)).not.toBe(stickersSignature(b))
    expect(stickersSignature(a)).toBe(stickersSignature(a.map((s) => ({ ...s }))))
    expect(stickersSignature([a[1]!, a[0]!])).not.toBe(stickersSignature(a))
  })
})
