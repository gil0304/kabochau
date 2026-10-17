// Placement math for stamps on a result image. Shared by the editor (CSS
// percentages) and the PNG compositor (canvas pixels), so both agree.
//
// Coordinates are normalised to the exported image:
//   x, y      stamp centre, 0..1 from the image's left / top edge
//   w         stamp width as a fraction of the image WIDTH (height follows
//             the stamp's own aspect ratio)
//   rotation  radians, clockwise on screen (CSS rotate() and canvas rotate()
//             agree because both use a y-down space)

import { clamp, type Vec2 } from './math'
import type { StickerDef, StickerId } from './stickerCatalog'

export interface PlacedSticker {
  uid: string
  type: StickerId
  x: number
  y: number
  w: number
  rotation: number
}

export interface FrameSize {
  w: number
  h: number
}

export const STICKER_MIN_WIDTH = 0.05
export const STICKER_MAX_WIDTH = 1.4
export const MAX_STICKERS = 24
/** Soft shadow blur as a fraction of the image width (same in editor and PNG). */
export const STICKER_SHADOW_BLUR = 0.012

function wrapAngle(a: number): number {
  const t = Math.PI * 2
  let r = a % t
  if (r > Math.PI) r -= t
  if (r <= -Math.PI) r += t
  return r
}

/** Keeps the centre on the image (so a stamp can always be grabbed again) and the size sane. */
export function clampSticker(s: PlacedSticker): PlacedSticker {
  return {
    ...s,
    x: clamp(Number.isFinite(s.x) ? s.x : 0.5, 0, 1),
    y: clamp(Number.isFinite(s.y) ? s.y : 0.5, 0, 1),
    w: clamp(Number.isFinite(s.w) ? s.w : 0.3, STICKER_MIN_WIDTH, STICKER_MAX_WIDTH),
    rotation: Number.isFinite(s.rotation) ? wrapAngle(s.rotation) : 0,
  }
}

/**
 * A new stamp near the centre. Successive stamps are spread on a golden-angle
 * spiral so they don't land exactly on top of each other.
 */
export function createSticker(def: StickerDef, index: number, uid: string): PlacedSticker {
  const golden = 2.399963229728653
  const r = index === 0 ? 0 : 0.06 + 0.035 * Math.sqrt(index)
  const a = index * golden
  const tilt = ((index % 5) - 2) * 0.07
  return clampSticker({
    uid,
    type: def.id,
    x: 0.5 + Math.cos(a) * r,
    y: 0.42 + Math.sin(a) * r * 0.7,
    w: def.defaultWidth,
    rotation: def.width / def.height > 2 ? tilt * 0.5 : tilt,
  })
}

/** Translate by a pointer delta given in frame pixels. */
export function moveSticker(s: PlacedSticker, dx: number, dy: number, frame: FrameSize): PlacedSticker {
  if (frame.w <= 0 || frame.h <= 0) return s
  return clampSticker({ ...s, x: s.x + dx / frame.w, y: s.y + dy / frame.h })
}

/**
 * Applies the similarity transform that maps segment a0→b0 onto a1→b1
 * (frame pixels) to a stamp captured at gesture start.
 *  - pinch:  a/b are the two fingers
 *  - handle: a0 = a1 = stamp centre, b is the corner handle (rotate + scale in place)
 */
export function transformSticker(s: PlacedSticker, a0: Vec2, b0: Vec2, a1: Vec2, b1: Vec2, frame: FrameSize): PlacedSticker {
  if (frame.w <= 0 || frame.h <= 0) return s
  const v0x = b0.x - a0.x
  const v0y = b0.y - a0.y
  const v1x = b1.x - a1.x
  const v1y = b1.y - a1.y
  const l0 = Math.hypot(v0x, v0y)
  const l1 = Math.hypot(v1x, v1y)
  if (l0 < 1e-3 || l1 < 1e-3) return s
  const w = clamp(s.w * (l1 / l0), STICKER_MIN_WIDTH, STICKER_MAX_WIDTH)
  const k = w / s.w
  const dr = Math.atan2(v1y, v1x) - Math.atan2(v0y, v0x)
  const cos = Math.cos(dr)
  const sin = Math.sin(dr)
  // centre relative to a0, rotated + scaled, re-anchored at a1
  const cx = s.x * frame.w - a0.x
  const cy = s.y * frame.h - a0.y
  const nx = a1.x + (cx * cos - cy * sin) * k
  const ny = a1.y + (cx * sin + cy * cos) * k
  return clampSticker({ ...s, x: nx / frame.w, y: ny / frame.h, w, rotation: s.rotation + dr })
}

export function scaleSticker(s: PlacedSticker, factor: number): PlacedSticker {
  return clampSticker({ ...s, w: s.w * factor })
}

export function rotateSticker(s: PlacedSticker, radians: number): PlacedSticker {
  return clampSticker({ ...s, rotation: s.rotation + radians })
}

export interface StickerDrawTransform {
  /** centre in image pixels */
  tx: number
  ty: number
  rotation: number
  /** viewBox units → image pixels */
  scale: number
  /** stamp size in image pixels */
  width: number
  height: number
}

export function stickerDrawTransform(s: PlacedSticker, def: StickerDef, imageW: number, imageH: number): StickerDrawTransform {
  const width = s.w * imageW
  const scale = width / def.width
  return { tx: s.x * imageW, ty: s.y * imageH, rotation: s.rotation, scale, width, height: def.height * scale }
}

/** CSS placement inside a frame that shows the image at any size. */
export function stickerCssPlacement(s: PlacedSticker, def: StickerDef): Record<string, string> {
  const pct = (n: number) => `${(n * 100).toFixed(4)}%`
  return {
    left: pct(s.x),
    top: pct(s.y),
    width: pct(s.w),
    aspectRatio: `${def.width} / ${def.height}`,
    transform: `translate(-50%, -50%) rotate(${s.rotation.toFixed(5)}rad)`,
  }
}

/** Stable key for caching a composited PNG. */
export function stickersSignature(list: readonly PlacedSticker[]): string {
  return list.map((s) => `${s.type}@${s.x.toFixed(5)},${s.y.toFixed(5)},${s.w.toFixed(5)},${s.rotation.toFixed(5)}`).join(';')
}
