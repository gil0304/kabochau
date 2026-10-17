// Procedural textures (generated once on the client; no image downloads).
import * as THREE from 'three'

function makeNoise(seed: number) {
  const perm = new Uint8Array(512)
  const p = new Uint8Array(256)
  for (let i = 0; i < 256; i++) p[i] = i
  let s = seed >>> 0 || 1
  for (let i = 255; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    const j = s % (i + 1)
    const t = p[i]!
    p[i] = p[j]!
    p[j] = t
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255]!
  const fade = (t: number) => t * t * (3 - 2 * t)
  /** Value noise, periodic in x with period `px` (so textures wrap around the pumpkin). */
  return (x: number, y: number, px: number): number => {
    const xi = Math.floor(x)
    const yi = Math.floor(y)
    const xf = x - xi
    const yf = y - yi
    const x0 = ((xi % px) + px) % px
    const x1 = (x0 + 1) % px
    const h = (a: number, b: number) => perm[(perm[a & 255]! + (b & 255)) & 511]! / 255
    const u = fade(xf)
    const v = fade(yf)
    const a = h(x0, yi)
    const b = h(x1, yi)
    const c = h(x0, yi + 1)
    const d = h(x1, yi + 1)
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
  }
}

export interface PumpkinTextures {
  skin: THREE.CanvasTexture
  bump: THREE.CanvasTexture
  stem: THREE.CanvasTexture
  dispose(): void
}

/**
 * Pumpkin rind colour + bump maps in the shell's (θ, φ) parametrisation:
 * vertical streaks along meridians, blotches, speckles, a greenish crown and
 * a darker blossom end. Size is reduced on low-end devices.
 */
export function createPumpkinTextures(size: 'high' | 'low' = 'high'): PumpkinTextures {
  const W = size === 'high' ? 1024 : 512
  const H = W / 2
  const noise = makeNoise(7)
  const colorCanvas = document.createElement('canvas')
  const bumpCanvas = document.createElement('canvas')
  colorCanvas.width = bumpCanvas.width = W
  colorCanvas.height = bumpCanvas.height = H
  const cctx = colorCanvas.getContext('2d')!
  const bctx = bumpCanvas.getContext('2d')!
  const cimg = cctx.createImageData(W, H)
  const bimg = bctx.createImageData(W, H)
  const streakPeriod = 220
  const blotchPeriod = 9
  for (let y = 0; y < H; y++) {
    const v = y / (H - 1) // 0 top .. 1 bottom (φ / π)
    for (let x = 0; x < W; x++) {
      const u = x / W
      const streak =
        0.6 * noise(u * streakPeriod, v * 3.0, streakPeriod) + 0.4 * noise(u * streakPeriod * 2.3, v * 6.0 + 11, Math.round(streakPeriod * 2.3))
      const blotch = noise(u * blotchPeriod, v * 4 + 3, blotchPeriod)
      const fine = noise(u * 600, v * 300, 600)
      // base orange with variation
      let r = 0.9 + 0.06 * blotch - 0.055 * (1 - streak)
      let g = 0.39 + 0.07 * blotch - 0.05 * (1 - streak) + 0.02 * fine
      let b = 0.05 + 0.03 * blotch
      // crown (near the stem) and blossom end
      const crown = Math.max(0, 1 - v / 0.09)
      const blossom = Math.max(0, (v - 0.9) / 0.1)
      r = r * (1 - 0.45 * crown) + 0.38 * crown
      g = g * (1 - 0.35 * crown) + 0.34 * crown
      b = b * (1 - 0.3 * crown) + 0.12 * crown
      r *= 1 - 0.35 * blossom
      g *= 1 - 0.4 * blossom
      // speckles
      if (fine > 0.93) {
        r += 0.06
        g += 0.06
        b += 0.03
      }
      const i = (y * W + x) * 4
      cimg.data[i] = Math.min(255, r * 255)
      cimg.data[i + 1] = Math.min(255, g * 255)
      cimg.data[i + 2] = Math.min(255, b * 255)
      cimg.data[i + 3] = 255
      const bump = 0.55 * streak + 0.25 * fine + 0.2 * blotch
      const bv = Math.min(255, bump * 255)
      bimg.data[i] = bimg.data[i + 1] = bimg.data[i + 2] = bv
      bimg.data[i + 3] = 255
    }
  }
  cctx.putImageData(cimg, 0, 0)
  bctx.putImageData(bimg, 0, 0)

  const stemCanvas = document.createElement('canvas')
  stemCanvas.width = 128
  stemCanvas.height = 256
  const sctx = stemCanvas.getContext('2d')!
  const simg = sctx.createImageData(128, 256)
  for (let y = 0; y < 256; y++) {
    const v = y / 255
    for (let x = 0; x < 128; x++) {
      const fib = noise((x / 128) * 40, v * 3, 40)
      const fine = noise((x / 128) * 120, v * 20 + 5, 120)
      // canvas row 0 maps to the stem tip (v = 1 after flipY): dry tan there, green-brown at the base
      const dry = 1 - v
      const r = 0.36 + 0.2 * dry + 0.12 * fib
      const g = 0.33 + 0.12 * dry + 0.1 * fib - 0.04 * fine
      const b = 0.16 + 0.06 * dry + 0.04 * fine
      const i = (y * 128 + x) * 4
      simg.data[i] = r * 255
      simg.data[i + 1] = g * 255
      simg.data[i + 2] = b * 255
      simg.data[i + 3] = 255
    }
  }
  sctx.putImageData(simg, 0, 0)

  const skin = new THREE.CanvasTexture(colorCanvas)
  skin.colorSpace = THREE.SRGBColorSpace
  skin.wrapS = THREE.RepeatWrapping
  skin.anisotropy = 4
  const bump = new THREE.CanvasTexture(bumpCanvas)
  bump.wrapS = THREE.RepeatWrapping
  const stem = new THREE.CanvasTexture(stemCanvas)
  stem.colorSpace = THREE.SRGBColorSpace
  stem.wrapS = THREE.RepeatWrapping
  return {
    skin,
    bump,
    stem,
    dispose() {
      skin.dispose()
      bump.dispose()
      stem.dispose()
    },
  }
}

/** Soft radial sprite used for the candle flame and halos. */
export function createRadialTexture(inner = 'rgba(255,255,255,1)', outer = 'rgba(255,255,255,0)', size = 128): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = size
  const ctx = c.getContext('2d')!
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  g.addColorStop(0, inner)
  g.addColorStop(0.35, inner.replace(/[\d.]+\)$/, '0.55)'))
  g.addColorStop(1, outer)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

/** Teardrop flame sprite. */
export function createFlameTexture(): THREE.CanvasTexture {
  const w = 64
  const h = 128
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')!
  const g = ctx.createRadialGradient(w / 2, h * 0.68, 2, w / 2, h * 0.62, h * 0.5)
  g.addColorStop(0, 'rgba(255,250,230,1)')
  g.addColorStop(0.25, 'rgba(255,214,120,0.95)')
  g.addColorStop(0.55, 'rgba(255,140,40,0.55)')
  g.addColorStop(1, 'rgba(255,90,10,0)')
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.moveTo(w / 2, 4)
  ctx.bezierCurveTo(w * 0.95, h * 0.5, w * 0.9, h * 0.95, w / 2, h - 4)
  ctx.bezierCurveTo(w * 0.1, h * 0.95, w * 0.05, h * 0.5, w / 2, 4)
  ctx.fill()
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

/**
 * Straw texture for the hay bale the back row of a MAKE group sits on:
 * thousands of short, mostly horizontal straws over an ochre base, plus two
 * twine bands. Deterministic (seeded) so every render looks the same.
 */
export function createHayTexture(size: 'high' | 'low' = 'high'): THREE.CanvasTexture {
  const W = size === 'high' ? 512 : 256
  const H = W / 2
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#b08a3a'
  ctx.fillRect(0, 0, W, H)
  let s = 12345
  const rnd = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
  const palette = ['#e8c66a', '#d4ad52', '#f2da8e', '#a8842f', '#c79b45', '#7a5a22']
  const strokes = Math.round((W * H) / 14)
  ctx.lineCap = 'round'
  for (let i = 0; i < strokes; i++) {
    const x = rnd() * W
    const y = rnd() * H
    const len = 8 + rnd() * (W / 9)
    const a = (rnd() - 0.5) * 0.7
    ctx.strokeStyle = palette[Math.floor(rnd() * palette.length)]!
    ctx.globalAlpha = 0.55 + rnd() * 0.4
    ctx.lineWidth = 0.8 + rnd() * 1.8
    ctx.beginPath()
    // wrap horizontally so the texture tiles along the bale
    for (const dx of [0, -W, W]) {
      ctx.moveTo(x + dx, y)
      ctx.lineTo(x + dx + Math.cos(a) * len, y + Math.sin(a) * len)
    }
    ctx.stroke()
  }
  ctx.globalAlpha = 1
  for (const u of [0.27, 0.73]) {
    const x = u * W
    ctx.fillStyle = 'rgba(70, 46, 18, 0.7)'
    ctx.fillRect(x - W * 0.005, 0, W * 0.01, H)
    ctx.fillStyle = 'rgba(190, 160, 100, 0.5)'
    ctx.fillRect(x - W * 0.002, 0, W * 0.002, H)
  }
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.wrapS = THREE.RepeatWrapping
  t.anisotropy = 4
  return t
}
