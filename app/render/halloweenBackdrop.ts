// LIVE Halloween backdrop: moon, bats, ghosts, a castle on the horizon, mist
// and embers. Drawn as sprites far behind the pumpkins (depth-tested, no depth
// writes) and BEFORE the segmented person layer, so with a person mask they
// appear behind the people and their pumpkin heads.
//
// Everything is laid out in fractions of the current frame (x right, y down),
// so preview and the 9:16 export frame it the same way. Art is procedural
// (Canvas 2D from the stamp vector paths) — no image downloads.

import * as THREE from 'three'
import { STICKER_BY_ID } from '../utils/stickerCatalog'
import { createRadialTexture } from './textures'

export const BACKDROP_DEPTH = 60

type Updater = (t: number, frame: Frame, ground: number) => void
interface Frame {
  halfW: number
  halfH: number
  /** world size of 1.0 = min(frame width, frame height) */
  unit: number
}

const CASTLE_PATHS = [
  'M44 72 h16 v52 h-16 Z',
  'M41 72 L52 42 L63 72 Z',
  'M58 86 h56 v38 h-56 Z',
  'M58 86 h6 v-5 h6 v5 h6 v-5 h6 v5 h6 v-5 h6 v5 h6 v-5 h6 v5 Z',
  'M96 54 h22 v70 h-22 Z',
  'M93 54 L107 14 L121 54 Z',
  'M118 80 h14 v44 h-14 Z',
  'M115 80 L125 58 L135 80 Z',
  'M107 14 v-8 l8 3.5 l-8 3.5',
]
const CASTLE_WINDOWS: Array<[number, number, number, number]> = [
  [49, 84, 5, 8],
  [103, 66, 6, 10],
  [103, 88, 6, 9],
  [74, 98, 5, 8],
  [122, 92, 5, 7],
]

function canvasTexture(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')!
  draw(ctx)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

function moonTexture() {
  return canvasTexture(256, 256, (ctx) => {
    const g = ctx.createRadialGradient(110, 104, 10, 128, 128, 118)
    g.addColorStop(0, '#fff6d2')
    g.addColorStop(0.65, '#ffd98a')
    g.addColorStop(1, '#f0a845')
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(128, 128, 116, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = 'rgba(205, 140, 60, 0.32)'
    for (const [x, y, r] of [
      [92, 96, 18],
      [150, 150, 26],
      [168, 86, 11],
      [104, 168, 13],
      [176, 122, 8],
    ] as const) {
      ctx.beginPath()
      ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.fill()
    }
  })
}

function stickerTexture(id: 'bat' | 'ghost', size: number, paint: (ctx: CanvasRenderingContext2D, layerIndex: number, p: Path2D) => void) {
  const def = STICKER_BY_ID[id]
  const s = size / def.width
  return canvasTexture(size, Math.round(def.height * s), (ctx) => {
    ctx.scale(s, s)
    def.layers.forEach((l, i) => {
      if (l.kind === 'path') paint(ctx, i, new Path2D(l.d))
    })
  })
}

function batTexture() {
  return stickerTexture('bat', 256, (ctx, i, p) => {
    if (i === 0) {
      ctx.fillStyle = '#170a1f'
      ctx.shadowColor = 'rgba(255, 170, 70, 0.45)'
      ctx.shadowBlur = 3
      ctx.fill(p)
      ctx.shadowBlur = 0
    } else if (i === 1) {
      ctx.fillStyle = '#ffcf5a'
      ctx.fill(p)
    }
  })
}

function ghostTexture() {
  return stickerTexture('ghost', 256, (ctx, i, p) => {
    if (i <= 1) {
      ctx.fillStyle = 'rgba(246, 241, 255, 0.95)'
      ctx.shadowColor = 'rgba(200, 180, 255, 0.9)'
      ctx.shadowBlur = 6
      ctx.fill(p)
      ctx.shadowBlur = 0
    } else if (i === 2) {
      ctx.fillStyle = '#2a1736'
      ctx.fill(p)
    } else {
      ctx.fillStyle = 'rgba(255, 159, 192, 0.6)'
      ctx.fill(p)
    }
  })
}

function castleTexture() {
  // castle drawn in the 30..150 × 4..124 viewBox of the first-view scene
  return canvasTexture(512, 512, (ctx) => {
    ctx.scale(512 / 120, 512 / 120)
    ctx.translate(-30, -4)
    ctx.fillStyle = '#12061a'
    for (const d of CASTLE_PATHS) ctx.fill(new Path2D(d))
    ctx.fillStyle = '#ffb347'
    ctx.shadowColor = 'rgba(255, 160, 50, 0.95)'
    ctx.shadowBlur = 4
    for (const [x, y, w, h] of CASTLE_WINDOWS) {
      ctx.beginPath()
      ctx.roundRect(x, y, w, h, w / 2)
      ctx.fill()
    }
  })
}

function mistTexture() {
  return canvasTexture(256, 64, (ctx) => {
    const g = ctx.createLinearGradient(0, 0, 0, 64)
    g.addColorStop(0, 'rgba(150, 110, 200, 0)')
    g.addColorStop(1, 'rgba(150, 110, 200, 0.55)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, 256, 64)
  })
}

export class HalloweenBackdrop {
  readonly group = new THREE.Group()
  private textures: THREE.Texture[] = []
  private materials: THREE.SpriteMaterial[] = []
  private updaters: Updater[] = []

  constructor() {
    const moon = moonTexture()
    const glow = createRadialTexture('rgba(255,205,120,1)', 'rgba(255,150,60,0)')
    const bat = batTexture()
    const ghost = ghostTexture()
    const castle = castleTexture()
    const mist = mistTexture()
    const ember = createRadialTexture('rgba(255,190,90,1)', 'rgba(255,120,30,0)', 64)
    this.textures.push(moon, glow, bat, ghost, castle, mist, ember)

    // moon + halo (upper right)
    const halo = this.sprite(glow, { additive: true, opacity: 0.55 })
    const disc = this.sprite(moon)
    this.updaters.push((t, f) => {
      this.place(halo, f, 0.8, 0.13, 0.62, 1)
      this.place(disc, f, 0.8, 0.13, 0.2, 1)
      ;(halo.material as THREE.SpriteMaterial).opacity = 0.5 + 0.05 * Math.sin(t * 0.7)
    })

    // castle on the horizon (lower left) + mist band
    const fort = this.sprite(castle)
    const fog = this.sprite(mist, { opacity: 0.8 })
    this.updaters.push((t, f, ground) => {
      this.place(fort, f, 0.16, 0.86, 0.42, 1)
      fort.visible = fog.visible = ground > 0.01
      ;(fort.material as THREE.SpriteMaterial).opacity = ground
      ;(fog.material as THREE.SpriteMaterial).opacity = 0.8 * ground
      const w = (f.halfW * 2) / f.unit
      this.place(fog, f, 0.5 + 0.02 * Math.sin(t * 0.2), 0.94, w * 1.1, 0.25 / (w * 1.1))
    })

    // bats crossing the upper sky (both directions; the bat is symmetric)
    const bats = [
      { y: 0.12, amp: 0.03, speed: 0.045, phase: 0.1, size: 0.1, flap: 13 },
      { y: 0.22, amp: 0.04, speed: -0.035, phase: 0.55, size: 0.075, flap: 11 },
      { y: 0.08, amp: 0.02, speed: 0.028, phase: 0.8, size: 0.06, flap: 10 },
      { y: 0.3, amp: 0.035, speed: -0.05, phase: 0.3, size: 0.085, flap: 14 },
      { y: 0.18, amp: 0.025, speed: 0.06, phase: 0.65, size: 0.065, flap: 12 },
    ]
    for (const b of bats) {
      const s = this.sprite(bat)
      this.updaters.push((t, f) => {
        const u = (((b.phase + t * b.speed) % 1) + 1) % 1
        const x = -0.15 + u * 1.3
        const y = b.y + b.amp * Math.sin(t * 1.3 + b.phase * 9)
        const flap = 0.5 + 0.5 * Math.abs(Math.sin(t * b.flap + b.phase * 7))
        this.place(s, f, x, y, b.size, (70 / 120) * flap)
      })
    }

    // ghosts drifting at the sides
    const ghosts = [
      { x: 0.1, y: 0.42, size: 0.15, phase: 0 },
      { x: 0.9, y: 0.5, size: 0.12, phase: 2.1 },
    ]
    for (const g of ghosts) {
      const s = this.sprite(ghost, { opacity: 0.7 })
      this.updaters.push((t, f) => {
        this.place(s, f, g.x + 0.025 * Math.sin(t * 0.35 + g.phase), g.y + 0.02 * Math.sin(t * 0.9 + g.phase), g.size, 1)
        ;(s.material as THREE.SpriteMaterial).opacity = 0.55 + 0.15 * Math.sin(t * 0.6 + g.phase)
      })
    }

    // embers rising from the bottom
    for (let i = 0; i < 18; i++) {
      const seed = Math.sin(i * 91.7) * 0.5 + 0.5
      const s = this.sprite(ember, { additive: true })
      this.updaters.push((t, f, ground) => {
        const life = (t * (0.05 + seed * 0.04) + seed * 7.3 + i * 0.137) % 1
        const x = ((i * 0.618 + seed * 0.3) % 1) + 0.03 * Math.sin(t * 0.8 + i)
        this.place(s, f, x, 1.02 - life * 0.75, 0.018 + seed * 0.012, 1)
        ;(s.material as THREE.SpriteMaterial).opacity = Math.sin(Math.PI * life) * 0.85 * ground
      })
    }
  }

  private sprite(map: THREE.Texture, opts: { additive?: boolean; opacity?: number } = {}): THREE.Sprite {
    const m = new THREE.SpriteMaterial({
      map,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      opacity: opts.opacity ?? 1,
      blending: opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      fog: false,
    })
    this.materials.push(m)
    const s = new THREE.Sprite(m)
    s.renderOrder = -900
    s.frustumCulled = false
    this.group.add(s)
    return s
  }

  /**
   * Centres a sprite at frame fraction (fx, fy); width = `size` × min(frame
   * w, h), height = width × `aspect`.
   */
  private place(s: THREE.Sprite, f: Frame, fx: number, fy: number, size: number, aspect: number) {
    s.position.set((fx - 0.5) * 2 * f.halfW, (0.5 - fy) * 2 * f.halfH, -BACKDROP_DEPTH)
    s.scale.set(size * f.unit, size * aspect * f.unit, 1)
  }

  /**
   * `ground` (0..1): how reliably people are masked out. Objects in the lower
   * part of the frame (castle, mist, embers) only show with a person mask,
   * otherwise they would be drawn over bodies; the sky objects always show.
   */
  update(t: number, camera: THREE.PerspectiveCamera, ground = 1): void {
    const halfH = BACKDROP_DEPTH * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))
    const halfW = halfH * camera.aspect
    const frame = { halfW, halfH, unit: 2 * Math.min(halfW, halfH) }
    for (const u of this.updaters) u(t, frame, ground)
  }

  set visible(v: boolean) {
    this.group.visible = v
  }

  dispose(): void {
    for (const m of this.materials) m.dispose()
    for (const t of this.textures) t.dispose()
    this.group.clear()
  }
}
