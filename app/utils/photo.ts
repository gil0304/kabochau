// Decodes a user-selected photo into a downscaled canvas for still-image
// face detection. The image is only drawn into an offscreen canvas in this
// tab — it is never uploaded and never rendered into the CARVE result.

export const MAX_PHOTO_EDGE = 1280

/** Target size that keeps the aspect ratio and caps the longest edge. */
export function fitWithin(width: number, height: number, maxEdge = MAX_PHOTO_EDGE): { width: number; height: number } {
  if (!(width > 0 && height > 0)) return { width: 0, height: 0 }
  const s = Math.min(1, maxEdge / Math.max(width, height))
  return { width: Math.max(1, Math.round(width * s)), height: Math.max(1, Math.round(height * s)) }
}

export class PhotoLoadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PhotoLoadError'
  }
}

export async function loadPhoto(file: File): Promise<HTMLCanvasElement> {
  if (!file.type.startsWith('image/') && !/\.(jpe?g|png|webp|heic|heif|gif|bmp)$/i.test(file.name)) {
    throw new PhotoLoadError('not an image')
  }
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.decoding = 'async'
    // modern browsers apply EXIF orientation when decoding <img>
    img.src = url
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new PhotoLoadError('decode failed'))
    })
    const { width, height } = fitWithin(img.naturalWidth, img.naturalHeight)
    if (!width || !height) throw new PhotoLoadError('empty image')
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new PhotoLoadError('2D canvas unavailable')
    ctx.drawImage(img, 0, 0, width, height)
    return canvas
  } finally {
    URL.revokeObjectURL(url)
  }
}
