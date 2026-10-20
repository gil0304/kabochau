// Composition / export math shared by the on-screen preview and the PNG export.
//
// All crops are expressed in DISPLAY-normalised source coordinates (x right,
// y DOWN, 0..1, after the optional selfie mirror). The preview and the export
// use exactly the same functions, so the pumpkin stays registered to the face
// regardless of CSS size, devicePixelRatio or output resolution — nothing
// relies on CSS object-fit.

import { type Vec2, clamp, v2 } from './math'

export interface CropRect {
  x: number
  y: number
  w: number
  h: number
}

export const EXPORT_WIDTH = 1080
export const EXPORT_HEIGHT = 1920
export const FALLBACK_EXPORT_WIDTH = 720
export const FALLBACK_EXPORT_HEIGHT = 1280

/**
 * "Cover" crop of a sw×sh source for a dw×dh destination. `focus` (display
 * normalised) recentres the crop while keeping it inside the source.
 */
export function coverCrop(sw: number, sh: number, dw: number, dh: number, focus?: Vec2 | null): CropRect {
  if (!(sw > 0 && sh > 0 && dw > 0 && dh > 0)) return { x: 0, y: 0, w: 1, h: 1 }
  const srcAspect = sw / sh
  const dstAspect = dw / dh
  let w = 1
  let h = 1
  if (srcAspect > dstAspect) w = dstAspect / srcAspect
  else h = srcAspect / dstAspect
  const cx = focus ? focus.x : 0.5
  const cy = focus ? focus.y : 0.5
  return { x: clamp(cx - w / 2, 0, 1 - w), y: clamp(cy - h / 2, 0, 1 - h), w, h }
}

/** Display-normalised source point -> destination pixel (y down). */
export function sourceToViewport(p: Vec2, crop: CropRect, dw: number, dh: number): Vec2 {
  return v2(((p.x - crop.x) / crop.w) * dw, ((p.y - crop.y) / crop.h) * dh)
}

/** Destination pixels per source pixel (uniform because crops preserve aspect). */
export function sourcePixelScale(sw: number, crop: CropRect, dw: number): number {
  return dw / (crop.w * sw)
}

/**
 * UV transform for sampling the camera texture in a full-screen quad:
 * texUV = viewportUV * scale + offset, where viewportUV has v pointing UP
 * (GL convention) and the texture is uploaded with flipY (three.js default).
 * Mirroring is applied here — never via CSS transforms — so preview and
 * export share it.
 */
export function videoUvTransform(crop: CropRect, mirrored: boolean): { sx: number; sy: number; ox: number; oy: number } {
  return {
    sx: mirrored ? -crop.w : crop.w,
    sy: crop.h,
    ox: mirrored ? 1 - crop.x : crop.x,
    oy: 1 - crop.y - crop.h,
  }
}

/**
 * LIVE export crop (9:16). Starts from the preview's centre so the framing
 * matches what was on screen, then shifts horizontally/vertically just enough
 * to keep every face (plus a pumpkin-sized margin) inside the frame.
 *
 * When the people themselves do not fit (their faces — `radius * coreRatio` —
 * e.g. side by side on a landscape webcam), the crop zooms out instead of
 * cutting anyone off, framing the whole pumpkins; it may then extend beyond
 * the camera frame (w or h > 1), which the renderer shows as letterbox bars.
 * A pumpkin merely overhanging the frame edge never triggers the zoom-out.
 */
export function liveExportCrop(
  sw: number,
  sh: number,
  previewCrop: CropRect,
  faces: ReadonlyArray<{ anchor: Vec2; radius: number }>,
  dw = EXPORT_WIDTH,
  dh = EXPORT_HEIGHT,
  coreRatio = 0.45,
): CropRect {
  const centre = v2(previewCrop.x + previewCrop.w / 2, previewCrop.y + previewCrop.h / 2)
  const crop = coverCrop(sw, sh, dw, dh, centre)
  if (faces.length === 0) return crop
  const bounds = (scale: number) => {
    const b = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity }
    for (const f of faces) {
      const rx = f.radius * scale
      const ry = (f.radius * scale * sw) / sh
      b.minX = Math.min(b.minX, f.anchor.x - rx)
      b.maxX = Math.max(b.maxX, f.anchor.x + rx)
      b.minY = Math.min(b.minY, f.anchor.y - ry)
      b.maxY = Math.max(b.maxY, f.anchor.y + ry)
    }
    return b
  }
  const core = bounds(coreRatio)
  const { minX, maxX, minY, maxY } = bounds(1)
  // small tolerance: a face grazing the frame edge is not worth a zoom-out
  if (core.maxX - core.minX > crop.w * 1.04 || core.maxY - core.minY > crop.h * 1.04) {
    const k = Math.max(((maxX - minX) * 1.06) / crop.w, ((maxY - minY) * 1.06) / crop.h, 1)
    const w = crop.w * k
    const h = crop.h * k
    const x = w >= 1 ? 0.5 - w / 2 : clamp((minX + maxX) / 2 - w / 2, 0, 1 - w)
    const y = h >= 1 ? 0.5 - h / 2 : clamp((minY + maxY) / 2 - h / 2, 0, 1 - h)
    return { x, y, w, h }
  }
  const fit = (lo: number, hi: number, start: number, size: number) => {
    if (lo < start) return lo
    if (hi > start + size) return hi - size
    return start
  }
  const x = fit(minX, maxX, crop.x, crop.w)
  const y = fit(minY, maxY, crop.y, crop.h)
  return { ...crop, x: clamp(x, 0, 1 - crop.w), y: clamp(y, 0, 1 - crop.h) }
}

/**
 * Depth at which a LIVE pumpkin is placed. Bigger (nearer) faces get a
 * smaller depth so overlapping pumpkins occlude each other in the right
 * order; the pumpkin is scaled by the same factor, so its projected size and
 * registration on screen do not change.
 */
export function liveFaceDepth(faceWidth: number, baseDepth = 10, referenceWidth = 0.35): number {
  const fw = Number.isFinite(faceWidth) && faceWidth > 0 ? faceWidth : referenceWidth
  return baseDepth * clamp(referenceWidth / fw, 0.4, 3)
}

/** Largest box with `aspect` (w / h) that fits inside boxW × boxH ("contain"). */
export function containSize(boxW: number, boxH: number, aspect: number): { w: number; h: number } {
  if (!(boxW > 0) || !(boxH > 0) || !(aspect > 0)) return { w: 0, h: 0 }
  return boxW / boxH > aspect ? { w: boxH * aspect, h: boxH } : { w: boxW, h: boxW / aspect }
}

export interface ExportSize {
  width: number
  height: number
  fallback: boolean
}

/**
 * 1080×1920 when the GPU can render it, otherwise an explicit 720×1280
 * fallback (low-end devices / small renderbuffer limits).
 */
export function chooseExportSize(maxRenderbufferSize: number, maxViewportHeight = Infinity, lowEnd = false): ExportSize {
  const limit = Math.min(maxRenderbufferSize || 0, maxViewportHeight)
  if (!lowEnd && limit >= EXPORT_HEIGHT) return { width: EXPORT_WIDTH, height: EXPORT_HEIGHT, fallback: false }
  return { width: FALLBACK_EXPORT_WIDTH, height: FALLBACK_EXPORT_HEIGHT, fallback: true }
}

/**
 * Camera distance so that a bounding sphere of `radius` (centred on the view
 * axis) fits inside a perspective frustum with vertical FOV `fovYDeg` and
 * `aspect` = width / height, leaving `margin` (fraction) free on each side.
 */
/**
 * LIVE saves follow the screen orientation: a landscape preview (e.g. a PC
 * window) exports landscape (1920×1080) so nothing on screen is cut off;
 * portrait previews (phones) keep the 1080×1920 story format.
 */
export function orientExportSize(size: ExportSize, viewWidth: number, viewHeight: number): ExportSize {
  return viewWidth > viewHeight ? { ...size, width: size.height, height: size.width } : size
}

export function fitDistanceForSphere(radius: number, fovYDeg: number, aspect: number, margin = 0.08): number {
  const fovY = (fovYDeg * Math.PI) / 180
  const fovX = 2 * Math.atan(Math.tan(fovY / 2) * aspect)
  const limiting = Math.min(fovY, fovX)
  const usable = Math.atan(Math.tan(limiting / 2) * (1 - 2 * margin))
  return radius / Math.sin(usable)
}

/** Projected radius (fraction of the half-height) of a sphere at `distance` — used to check framing. */
/**
 * Camera distance that fits an axis-aligned box (half extents, centred on the
 * camera target) into a perspective view. Tighter than a bounding sphere for
 * wide groups, which matters in a 9:16 portrait frame.
 */
export function fitDistanceForBox(halfW: number, halfH: number, halfD: number, fovYDeg: number, aspect: number, margin = 0.08): number {
  const tanY = Math.tan((fovYDeg * Math.PI) / 360)
  const tanX = tanY * aspect
  return Math.max(halfH / tanY, halfW / tanX) * (1 + margin) + halfD
}

export function projectedSphereFraction(radius: number, distance: number, fovYDeg: number): number {
  const fovY = (fovYDeg * Math.PI) / 180
  const angular = Math.asin(Math.min(1, radius / distance))
  return Math.tan(angular) / Math.tan(fovY / 2)
}

export function exportFileName(mode: 'live' | 'carve', date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  const stamp = `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  // file names use the visible mode names (the 'carve' mode is shown as MAKE)
  return `kabochau-${mode === 'carve' ? 'make' : 'live'}-${stamp}.png`
}

/** canvas.toBlob with a dataURL fallback (some older WebKit builds return null). */
export function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const fallback = () => {
      try {
        const url = canvas.toDataURL('image/png')
        const bin = atob(url.split(',')[1] ?? '')
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        if (bytes.length < 100) reject(new Error('empty PNG'))
        else resolve(new Blob([bytes], { type: 'image/png' }))
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    }
    try {
      canvas.toBlob((blob) => (blob && blob.size > 0 ? resolve(blob) : fallback()), 'image/png')
    } catch {
      fallback()
    }
  })
}
