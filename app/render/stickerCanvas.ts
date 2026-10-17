// Canvas 2D renderer for stamps + PNG compositor. Mirrors StickerArt.vue:
// same layers, same order, same text-run stretching, same soft shadow, so the
// saved PNG matches what the editor shows.

import {
  STICKER_BY_ID,
  STICKER_FONT_FAMILY,
  STICKER_FONT_WEIGHT,
  type StickerDef,
  type StickerTextLayer,
} from '../utils/stickerCatalog'
import { STICKER_SHADOW_BLUR, stickerDrawTransform, type PlacedSticker } from '../utils/stickers'
import { canvasToPngBlob } from '../utils/imageExport'

export const STICKER_SHADOW_COLOR = 'rgba(0, 0, 0, 0.5)'

export function stickerFont(size: number): string {
  return `${STICKER_FONT_WEIGHT} ${size}px ${STICKER_FONT_FAMILY}`
}

let measureCtx: CanvasRenderingContext2D | null = null
const runScaleCache = new Map<string, number>()

/**
 * Horizontal stretch that makes a text run exactly `layer.width` wide with
 * whatever font the device resolves. Used by both the SVG and canvas paths.
 */
export function textRunScale(layer: StickerTextLayer): number {
  const key = `${layer.size}|${layer.width}|${layer.text}`
  const hit = runScaleCache.get(key)
  if (hit !== undefined) return hit
  if (typeof document === 'undefined') return 1
  measureCtx ??= document.createElement('canvas').getContext('2d')
  if (!measureCtx) return 1
  measureCtx.font = stickerFont(layer.size)
  const w = measureCtx.measureText(layer.text).width
  if (!(w > 0)) return 1
  const s = layer.width / w
  runScaleCache.set(key, s)
  return s
}

const pathCache = new Map<string, Path2D>()
function toPath(d: string): Path2D {
  let p = pathCache.get(d)
  if (!p) {
    p = new Path2D(d)
    pathCache.set(d, p)
  }
  return p
}

function textRun(ctx: CanvasRenderingContext2D, layer: StickerTextLayer, draw: () => void): void {
  ctx.save()
  ctx.font = stickerFont(layer.size)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'alphabetic'
  ctx.translate(layer.x, layer.y)
  ctx.scale(textRunScale(layer), 1)
  draw()
  ctx.restore()
}

/** Paints a stamp in its own viewBox units (caller sets the transform). */
export function paintSticker(ctx: CanvasRenderingContext2D, def: StickerDef): void {
  ctx.save()
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  const o = def.outline
  if (o) {
    ctx.strokeStyle = o.color
    for (const l of def.layers) {
      if (!l.outline) continue
      const inner = l.stroke ? (l.strokeWidth ?? 1) : 0
      if (l.kind === 'path') {
        ctx.lineWidth = o.width * 2 + inner
        ctx.stroke(toPath(l.d))
      } else {
        textRun(ctx, l, () => {
          ctx.lineWidth = o.width * 2 + inner
          ctx.strokeText(l.text, 0, 0)
        })
      }
    }
  }
  for (const l of def.layers) {
    if (l.kind === 'path') {
      ctx.globalAlpha = l.opacity ?? 1
      const p = toPath(l.d)
      if (l.fill) {
        ctx.fillStyle = l.fill
        ctx.fill(p, l.fillRule ?? 'nonzero')
      }
      if (l.stroke) {
        ctx.strokeStyle = l.stroke
        ctx.lineWidth = l.strokeWidth ?? 1
        ctx.stroke(p)
      }
    } else {
      ctx.globalAlpha = 1
      textRun(ctx, l, () => {
        if (l.stroke) {
          ctx.strokeStyle = l.stroke
          ctx.lineWidth = l.strokeWidth ?? 1
          ctx.strokeText(l.text, 0, 0)
        }
        ctx.fillStyle = l.fill
        ctx.fillText(l.text, 0, 0)
      })
    }
  }
  ctx.restore()
}

/**
 * Draws one placed stamp onto an image-sized context. The stamp is painted
 * upright into a scratch canvas first and then drawn rotated with a canvas
 * shadow, which reproduces CSS `drop-shadow()` on the whole silhouette.
 */
export function drawPlacedSticker(ctx: CanvasRenderingContext2D, s: PlacedSticker, imageW: number, imageH: number): void {
  const def = STICKER_BY_ID[s.type]
  if (!def) return
  const t = stickerDrawTransform(s, def, imageW, imageH)
  const pad = Math.ceil(((def.outline?.width ?? 0) + 12) * t.scale)
  const scratch = document.createElement('canvas')
  scratch.width = Math.max(1, Math.ceil(t.width) + pad * 2)
  scratch.height = Math.max(1, Math.ceil(t.height) + pad * 2)
  const sctx = scratch.getContext('2d')
  if (!sctx) throw new Error('2D canvas unavailable')
  sctx.translate(pad, pad)
  sctx.scale(t.scale, t.scale)
  paintSticker(sctx, def)

  ctx.save()
  ctx.translate(t.tx, t.ty)
  ctx.rotate(t.rotation)
  ctx.shadowColor = STICKER_SHADOW_COLOR
  ctx.shadowBlur = STICKER_SHADOW_BLUR * imageW
  ctx.shadowOffsetX = 0
  ctx.shadowOffsetY = 0
  ctx.drawImage(scratch, -t.width / 2 - pad, -t.height / 2 - pad)
  ctx.restore()
  scratch.width = scratch.height = 0
}

async function decodeBlob(blob: Blob): Promise<{ image: CanvasImageSource; release: () => void }> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(blob)
      return { image: bmp, release: () => bmp.close() }
    } catch {
      // fall through to <img> decoding (older Safari)
    }
  }
  const url = URL.createObjectURL(blob)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    return { image: img, release: () => undefined }
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** Base PNG + stamps → new PNG at the same size. Runs entirely on-device. */
export async function composeStickers(base: Blob, width: number, height: number, stickers: readonly PlacedSticker[]): Promise<Blob> {
  const source = await decodeBlob(base)
  const canvas = document.createElement('canvas')
  try {
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('2D canvas unavailable')
    ctx.drawImage(source.image, 0, 0, width, height)
    for (const s of stickers) drawPlacedSticker(ctx, s, width, height)
    return await canvasToPngBlob(canvas)
  } finally {
    source.release()
    canvas.width = canvas.height = 0
  }
}
