// MAKE (internally "carve") stage: one personalised jack-o'-lantern per
// person in a dark cinematic scene. The human photo / camera frame is NOT part
// of this scene — only the parameters measured from it (PumpkinFaceParams).
//
// Timeline: darkness -> silhouette reveal (rim + moon light) -> features are
// carved one by one (each person's pumpkin slightly after the previous one)
// -> candles ignite (glow + bloom + embers) -> final idle.
//
// Groups (2–4 people) are arranged by utils/pumpkinGroup.ts: two in front,
// the rest raised behind them on a hay bale, framed to fit the 9:16 export.

import * as THREE from 'three'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { clamp, clamp01, lerp, smoothstep } from '../utils/math'
import { expressionGlow } from '../utils/expressionMapping'
import type { CarveFaceInput } from '../utils/faceTracks'
import {
  CARVE_STYLE,
  FEATURE_ORDER,
  buildCarveLayout,
  carveProgress,
  carveTimeline,
  type CarveTimeline,
  pumpkinShapeFromParams,
  scaleOutline,
  stemFromParams,
  type CarveLayout,
} from '../utils/pumpkinGeometry'
import { GROUP_CARVE_STAGGER, MAX_GROUP, arrangePumpkinGroup, type GroupSlot } from '../utils/pumpkinGroup'
import { canvasToPngBlob, chooseExportSize, fitDistanceForBox, fitDistanceForSphere } from '../utils/imageExport'
import { applyOrbitDrag, orbitCameraPosition, type OrbitOffset } from '../utils/orbit'
import { PumpkinModel, excludeCandleLights } from './pumpkinModel'
import { PostFx, createRenderer, snapshotCanvas } from './postfx'
import { createHayTexture, createPumpkinTextures, createRadialTexture, type PumpkinTextures } from './textures'
import type { QualityTier } from './quality'
import type { CaptureResult } from './liveCompositor'

const FOV = 30
const FOG_DENSITY = 0.1
/** Radius the single-pumpkin framing is tuned for (fog / atmosphere reference). */
const REFERENCE_RADIUS = 1.1

const easeOutCubic = (x: number) => 1 - Math.pow(1 - clamp01(x), 3)
const easeOutBack = (x: number) => {
  const c1 = 1.5
  const c3 = c1 + 1
  const t = clamp01(x)
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2)
}

const skyVertex = /* glsl */ `
  varying vec3 vDir;
  void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`
const skyFragment = /* glsl */ `
  uniform float uLight;
  uniform vec3 uMoonDir;
  varying vec3 vDir;
  void main() {
    float h = vDir.y;
    vec3 top = vec3(0.008, 0.005, 0.02);
    vec3 horizon = vec3(0.02, 0.01, 0.028);
    vec3 c = mix(horizon, top, smoothstep(-0.05, 0.6, h));
    float m = max(dot(normalize(vDir), uMoonDir), 0.0);
    c += vec3(0.35, 0.42, 0.75) * (pow(m, 900.0) * 3.0 + pow(m, 40.0) * 0.08 + pow(m, 6.0) * 0.025);
    gl_FragColor = vec4(c * uLight, 1.0);
  }`

const emberVertex = /* glsl */ `
  attribute float aSeed;
  uniform float uTime;
  uniform float uSize;
  varying float vAlpha;
  void main() {
    float life = fract(uTime * (0.08 + aSeed * 0.07) + aSeed * 7.13);
    vec3 p = position;
    p.y += life * 2.6;
    p.x += sin(uTime * (0.6 + aSeed) + aSeed * 40.0) * 0.18 * life;
    p.z += cos(uTime * (0.5 + aSeed) + aSeed * 20.0) * 0.12 * life;
    vAlpha = smoothstep(0.0, 0.12, life) * (1.0 - smoothstep(0.55, 1.0, life));
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = uSize * (0.6 + aSeed) / -mv.z;
    gl_Position = projectionMatrix * mv;
  }`
const emberFragment = /* glsl */ `
  uniform float uAmount;
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.0, d) * vAlpha * uAmount;
    gl_FragColor = vec4(vec3(3.0, 1.3, 0.35) * a, a);
  }`

interface Member {
  model: PumpkinModel
  layout: CarveLayout
  glowTarget: { intensity: number; warmth: number }
  lastSignature: string
  /** carving delay (seconds) */
  offset: number
  slot: GroupSlot
}

type Framing =
  | { kind: 'sphere'; centerY: number; radius: number }
  | { kind: 'box'; center: THREE.Vector3; half: THREE.Vector3 }

export class CarveStage {
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 200)
  private fx: PostFx
  private textures: PumpkinTextures
  private members: Member[] = []
  private timeline: CarveTimeline
  private envTarget: THREE.WebGLRenderTarget | null = null
  private sky: THREE.Mesh
  private skyMaterial: THREE.ShaderMaterial
  private ground: THREE.Mesh
  private groundMaterial: THREE.MeshStandardMaterial
  private groundUniforms = {
    /** per pumpkin: x, z, glow (0 for pumpkins not standing on the ground), unused */
    uPools: { value: Array.from({ length: MAX_GROUP }, () => new THREE.Vector4()) },
    uPoolColor: { value: new THREE.Color(1, 0.45, 0.12) },
  }
  private moon: THREE.DirectionalLight
  private rim: THREE.DirectionalLight
  private hemi: THREE.HemisphereLight
  private embers: THREE.Points
  private emberMaterial: THREE.ShaderMaterial
  private shadowTex: THREE.CanvasTexture
  /** warm light from the candles above, faked on the hay bale (no light leaks through shells) */
  private hayUniforms = { uHayGlow: { value: 0 }, uHayHeight: { value: 1 } }
  private disposables: Array<{ dispose(): void }> = []

  private cssW = 1
  private cssH = 1
  private dpr = 1
  private startTime: number | null = null
  private clockOffset = 0
  private framing: Framing
  private orbit: OrbitOffset = { yaw: 0, pitch: 0 }
  private dragging = false
  private readyFired = false
  private lastT = 0

  constructor(
    private canvas: HTMLCanvasElement,
    faces: readonly CarveFaceInput[],
    private tier: QualityTier,
    private onReady: () => void,
  ) {
    const people = faces.slice(0, MAX_GROUP)
    if (people.length === 0) throw new Error('CarveStage needs at least one face')
    const n = people.length
    this.timeline = carveTimeline(n, GROUP_CARVE_STAGGER, MAX_GROUP)

    this.renderer = createRenderer(canvas, THREE.ACESFilmicToneMapping)
    this.renderer.toneMappingExposure = 0.95
    this.dpr = Math.min(window.devicePixelRatio || 1, tier.maxPixelRatio)

    // ----- pumpkins (one per person, in left-to-right order)
    this.textures = createPumpkinTextures(tier.textures)
    const segments: [number, number] =
      n === 1
        ? [Math.max(128, tier.shellSegments[0]), Math.max(96, tier.shellSegments[1])]
        : [Math.max(112, tier.shellSegments[0]), Math.max(80, tier.shellSegments[1])]
    const maskSize = n <= 2 ? Math.max(1024, tier.maskSize) : tier.maskSize
    const built = people.map((face) => {
      const shape = pumpkinShapeFromParams(face.params)
      const model = new PumpkinModel({
        shape,
        stem: stemFromParams(face.params),
        textures: this.textures,
        maskSize,
        segments,
        wallThickness: 0.1,
        halo: 0.1,
        spill: 0.45,
      })
      model.setGlow(0)
      model.setLidVisible(1)
      return { model, layout: buildCarveLayout(face.params, CARVE_STYLE, face.expression, shape), glow: expressionGlow(face.expression) }
    })
    const arrangement = arrangePumpkinGroup(
      built.map(({ model }) => {
        const b = model.bodyBox
        return {
          halfWidth: Math.max(-b.min.x, b.max.x),
          halfDepth: Math.max(-b.min.z, b.max.z),
          bodyHeight: b.max.y - b.min.y,
          totalHeight: model.topY - model.bottomY,
        }
      }),
    )

    // contact shadows (one per pumpkin and per riser)
    this.shadowTex = createRadialTexture('rgba(0,0,0,0.85)', 'rgba(0,0,0,0)')
    const shadowMat = new THREE.MeshBasicMaterial({ map: this.shadowTex, transparent: true, depthWrite: false })
    const shadowGeo = new THREE.PlaneGeometry(2.8, 2.4)
    this.disposables.push(shadowMat, shadowGeo)
    const addShadow = (x: number, y: number, z: number, sx: number, sz: number) => {
      const m = new THREE.Mesh(shadowGeo, shadowMat)
      m.rotation.x = -Math.PI / 2
      m.position.set(x, y + 0.003, z)
      m.scale.set(sx, sz, 1)
      this.scene.add(m)
    }

    built.forEach(({ model, layout, glow }, i) => {
      const slot = arrangement.slots[i]!
      model.group.position.set(slot.x, slot.y - model.bottomY, slot.z)
      this.scene.add(model.group)
      const b = model.bodyBox
      addShadow(slot.x, slot.y, slot.z, Math.max(-b.min.x, b.max.x), Math.max(-b.min.z, b.max.z) / 0.97)
      this.members.push({ model, layout, glowTarget: glow, lastSignature: '', offset: i * GROUP_CARVE_STAGGER, slot })
    })

    // hay bale(s) under the back row
    if (arrangement.risers.length > 0) {
      const hay = createHayTexture(tier.textures)
      const hayMat = new THREE.MeshStandardMaterial({ map: hay, bumpMap: hay, bumpScale: 2, roughness: 0.95, color: 0xfff1d6 })
      const hu = this.hayUniforms
      hu.uHayHeight.value = arrangement.risers[0]!.height
      excludeCandleLights(hayMat, (shader) => {
        Object.assign(shader.uniforms, hu)
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nuniform float uHayHeight;\nvarying float vHayT;\nvarying float vHayUp;')
          .replace('#include <begin_vertex>', '#include <begin_vertex>\nvHayT = clamp(position.y / uHayHeight + 0.5, 0.0, 1.0);\nvHayUp = normal.y;')
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\nuniform float uHayGlow;\nvarying float vHayT;\nvarying float vHayUp;')
          .replace(
            '#include <emissivemap_fragment>',
            `#include <emissivemap_fragment>
            totalEmissiveRadiance += vec3(1.0, 0.52, 0.18) * diffuseColor.rgb * uHayGlow *
              (0.05 + 0.3 * vHayT * vHayT + 0.35 * smoothstep(0.5, 0.95, vHayUp));`,
          )
      })
      this.disposables.push(hay, hayMat)
      for (const r of arrangement.risers) {
        const geo = new RoundedBoxGeometry(r.width, r.height, r.depth, 3, Math.min(0.08, r.height * 0.1))
        this.disposables.push(geo)
        const bale = new THREE.Mesh(geo, hayMat)
        bale.position.set(r.x, r.height / 2, r.z)
        this.scene.add(bale)
        hay.repeat.set(Math.max(1, r.width / 1.6), 1)
        addShadow(r.x, 0, r.z, (r.width / 2.8) * 1.25, (r.depth / 2.4) * 1.35)
      }
    }

    // ----- framing
    if (n === 1) {
      const model = this.members[0]!.model
      const top = model.topY - model.bottomY
      this.framing = { kind: 'sphere', centerY: top / 2, radius: Math.max(top / 2, 1.05) * 1.04 }
    } else {
      const { min, max } = arrangement
      this.framing = {
        kind: 'box',
        center: new THREE.Vector3((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2),
        half: new THREE.Vector3((max.x - min.x) / 2 + 0.05, (max.y - min.y) / 2 + 0.05, (max.z - min.z) / 2),
      }
    }

    // environment for subtle sheen on the rind
    try {
      const pmrem = new THREE.PMREMGenerator(this.renderer)
      this.envTarget = pmrem.fromScene(new RoomEnvironment(), 0.04)
      this.scene.environment = this.envTarget.texture
      this.scene.environmentIntensity = 0.12
      pmrem.dispose()
    } catch {
      this.envTarget = null
    }

    // sky dome + fog
    this.skyMaterial = new THREE.ShaderMaterial({
      uniforms: { uLight: { value: 0 }, uMoonDir: { value: new THREE.Vector3(-0.55, 0.42, -0.72).normalize() } },
      vertexShader: skyVertex,
      fragmentShader: skyFragment,
      side: THREE.BackSide,
      depthWrite: false,
    })
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(80, 32, 16), this.skyMaterial)
    this.scene.add(this.sky)
    // fog colour = sky horizon colour (linear) so the ground melts into the sky
    this.scene.fog = new THREE.FogExp2(new THREE.Color().setRGB(0.02, 0.01, 0.028, THREE.LinearSRGBColorSpace), FOG_DENSITY)

    // ground with a candle light pool in front of each pumpkin standing on it
    this.groundMaterial = new THREE.MeshStandardMaterial({ color: 0x1a1214, roughness: 0.92, metalness: 0 })
    const gu = this.groundUniforms
    this.groundMaterial.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, gu)
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vGround;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGround = (modelMatrix * vec4(position, 1.0)).xyz;')
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\nuniform vec4 uPools[${MAX_GROUP}];\nuniform vec3 uPoolColor;\nvarying vec3 vGround;`)
        .replace(
          '#include <emissivemap_fragment>',
          /* glsl */ `#include <emissivemap_fragment>
          for (int i = 0; i < ${MAX_GROUP}; i++) {
            vec4 P = uPools[i];
            vec2 q = vGround.xz - vec2(P.x, P.y + 0.85);
            float pool = exp(-dot(q * vec2(0.75, 1.0), q * vec2(0.75, 1.0)) * 1.3);
            vec2 b = vGround.xz - P.xy;
            float under = exp(-dot(b, b) * 2.5);
            totalEmissiveRadiance += uPoolColor * P.z * (pool * 0.28 + under * 0.08);
          }`,
        )
    }
    this.ground = new THREE.Mesh(new THREE.CircleGeometry(30, 64), this.groundMaterial)
    this.ground.rotation.x = -Math.PI / 2
    this.scene.add(this.ground)

    // lights
    this.hemi = new THREE.HemisphereLight(0x3a3060, 0x0a0606, 0)
    this.moon = new THREE.DirectionalLight(0xa9b8ff, 0)
    this.moon.position.set(-3.5, 4.5, 3)
    this.rim = new THREE.DirectionalLight(0xff9f6a, 0)
    this.rim.position.set(2.5, 2.8, -4)
    this.scene.add(this.hemi, this.moon, this.rim)

    // embers, spread over the width of the group
    const count = 70 + 25 * (n - 1)
    const minX = arrangement.min.x
    const spanX = arrangement.max.x - arrangement.min.x
    const pos = new Float32Array(count * 3)
    const seeds = new Float32Array(count)
    for (let i = 0; i < count; i++) {
      if (n === 1) {
        const a = Math.random() * Math.PI * 2
        const r = 0.4 + Math.random() * 1.2
        pos[i * 3] = Math.cos(a) * r
        pos[i * 3 + 2] = Math.sin(a) * r * 0.7 + 0.2
      } else {
        pos[i * 3] = minX - 0.3 + Math.random() * (spanX + 0.6)
        pos[i * 3 + 2] = arrangement.max.z - Math.random() * 1.4 + 0.3
      }
      pos[i * 3 + 1] = 0.1 + Math.random() * 0.6
      seeds[i] = Math.random()
    }
    const emberGeo = new THREE.BufferGeometry()
    emberGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    emberGeo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1))
    this.emberMaterial = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uSize: { value: 60 }, uAmount: { value: 0 } },
      vertexShader: emberVertex,
      fragmentShader: emberFragment,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    this.embers = new THREE.Points(emberGeo, this.emberMaterial)
    this.embers.frustumCulled = false
    this.scene.add(this.embers)

    this.fx = new PostFx(this.renderer, [{ scene: this.scene, camera: this.camera }], {
      bloom: tier.bloom,
      bloomStrength: 0.4,
      bloomRadius: 0.5,
      bloomThreshold: 0.9,
      samples: tier.msaaSamples,
      vignette: 0.55,
      grain: 0.03,
    })
  }

  get count(): number {
    return this.members.length
  }

  resize(cssWidth: number, cssHeight: number): void {
    this.cssW = Math.max(1, Math.round(cssWidth))
    this.cssH = Math.max(1, Math.round(cssHeight))
    this.applySize(this.cssW, this.cssH, this.dpr)
  }

  private applySize(w: number, h: number, pixelRatio: number) {
    this.renderer.setPixelRatio(pixelRatio)
    this.renderer.setSize(w, h, false)
    this.fx.setSize(w, h, pixelRatio)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.emberMaterial.uniforms.uSize!.value = 26 * pixelRatio * (h / 900)
  }

  /** Jump straight to the finished pumpkins. */
  skip(): void {
    if (this.startTime === null) return
    const elapsed = this.lastT - this.startTime + this.clockOffset
    if (elapsed < this.timeline.end) this.clockOffset += this.timeline.end - elapsed
  }

  get finished(): boolean {
    return this.readyFired
  }

  drag(dx: number, dy: number): void {
    this.dragging = true
    this.orbit = applyOrbitDrag(this.orbit, dx, dy)
  }

  endDrag(): void {
    this.dragging = false
  }

  /** Applies the timeline state for scene time `e` (seconds since start). */
  private applyTimeline(e: number, t: number, dt: number, idlePose: boolean): void {
    const T = this.timeline
    const reveal = smoothstep(T.revealStart, T.revealEnd, e)
    this.rim.intensity = 2.4 * reveal
    this.moon.intensity = 1.1 * smoothstep(T.revealStart + 0.3, T.revealEnd + 0.3, e)
    this.hemi.intensity = 0.5 * reveal
    this.skyMaterial.uniforms.uLight!.value = smoothstep(0, T.revealEnd, e)

    // ignition: embers glow while carving, then the candles flare and settle together
    const ignite = smoothstep(T.igniteStart, T.igniteStart + 0.35, e)
    const flare = Math.exp(-Math.pow((e - (T.igniteStart + 0.42)) / 0.18, 2)) * 0.55
    const settle = smoothstep(T.igniteStart + 0.3, T.igniteEnd, e)

    this.members.forEach((m, i) => {
      // carving: each feature grows from a sliver along its outline
      const local = e - m.offset
      const outlines = m.layout.features.map((f) => {
        const idx = Math.max(0, FEATURE_ORDER.indexOf(f.id))
        const p = carveProgress(local, idx, T.carveStart, T.carveStagger, T.carveDuration)
        if (p <= 0) return null
        return scaleOutline(f.outline, f.centroid, Math.max(0.02, easeOutBack(p)))
      })
      const sig = outlines.map((o) => (o ? o.length + ':' + o[0]!.x.toFixed(4) : '-')).join('|')
      if (sig !== m.lastSignature) {
        m.model.setCarving(outlines.filter((o): o is NonNullable<typeof o> => o !== null))
        m.lastSignature = sig
      }
      const carving = smoothstep(T.carveStart, T.carveStart + 0.4, local) * 0.16
      const glow = Math.max(carving, ignite * lerp(1.15, m.glowTarget.intensity * 0.95, settle) + flare)
      m.model.setGlow(glow, m.glowTarget.warmth)
      m.model.update(t)
      const pool = this.groundUniforms.uPools.value[i]!
      pool.set(m.slot.x, m.slot.z, m.slot.row === 'front' ? glow : 0, 0)
    })
    const backGlow = this.members.filter((m) => m.slot.row === 'back').map((m) => m.model.glow)
    this.hayUniforms.uHayGlow.value = backGlow.length ? backGlow.reduce((a, b) => a + b, 0) / backGlow.length : 0
    this.fx.setBloom(this.tier.bloom, 0.2 + 0.55 * ignite + flare * 0.6)
    this.emberMaterial.uniforms.uAmount!.value = smoothstep(T.igniteStart, T.igniteEnd + 0.4, e)
    this.emberMaterial.uniforms.uTime!.value = t

    // camera: slow dolly-in with a slight orbit; settles on a 3/4-ish front view
    const intro = easeOutCubic(e / T.end)
    const sway = idlePose ? 0 : Math.sin(t * 0.45) * 0.05 * smoothstep(T.end - 0.5, T.end + 1, e)
    if (!this.dragging && !idlePose) {
      const k = 1 - Math.exp(-dt / 0.35)
      this.orbit = { yaw: this.orbit.yaw * (1 - k), pitch: this.orbit.pitch * (1 - k) }
    }
    const yaw = idlePose ? 0.14 : lerp(0.55, 0.14, intro) + sway + this.orbit.yaw
    const pitch = idlePose ? 0.1 : 0.1 + this.orbit.pitch
    this.placeCamera(this.camera.aspect, idlePose ? 1 : lerp(1.32, 1, intro), yaw, pitch)
  }

  private placeCamera(aspect: number, distanceScale: number, yaw: number, pitch: number) {
    const f = this.framing
    if (f.kind === 'sphere') {
      const dist = fitDistanceForSphere(f.radius, FOV, aspect, 0.07) * distanceScale
      const p = orbitCameraPosition(yaw, pitch, dist, f.centerY)
      this.camera.position.set(p.x, p.y, p.z)
      this.camera.lookAt(0, f.centerY, 0)
      return
    }
    const dist = fitDistanceForBox(f.half.x, f.half.y, f.half.z, FOV, aspect, 0.07) * distanceScale
    // a group is framed from further away; thin the fog accordingly so the
    // pumpkins keep the same atmosphere as a single one instead of fading out
    if (this.scene.fog instanceof THREE.FogExp2) {
      const reference = fitDistanceForSphere(REFERENCE_RADIUS, FOV, aspect, 0.07) * distanceScale
      this.scene.fog.density = FOG_DENSITY * clamp(reference / dist, 0.25, 1)
    }
    const p = orbitCameraPosition(yaw, pitch, dist, f.center.y)
    this.camera.position.set(f.center.x + p.x, p.y, f.center.z + p.z)
    this.camera.lookAt(f.center)
  }

  private renderMasks(): void {
    for (const m of this.members) m.model.renderMask(this.renderer)
  }

  frame(nowMs: number): void {
    const t = nowMs / 1000
    const dt = clamp(t - this.lastT, 0, 0.1)
    this.lastT = t
    if (this.startTime === null) this.startTime = t
    const e = t - this.startTime + this.clockOffset
    this.applyTimeline(e, t, dt, false)
    this.renderMasks()
    this.fx.render(t)
    if (!this.readyFired && e >= this.timeline.end) {
      this.readyFired = true
      this.onReady()
    }
  }

  /** Renders the finished pumpkins (canonical pose) at 1080×1920 — whole group in frame. */
  async capture(): Promise<CaptureResult> {
    const gl = this.renderer.getContext()
    if (gl.isContextLost()) throw new Error('WebGL context lost')
    const maxRb = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number
    const maxVp = (gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array)[1] ?? maxRb
    let size = chooseExportSize(maxRb, maxVp, this.tier.name === 'low')
    const t = this.lastT
    const renderAt = (w: number, h: number) => {
      this.applySize(w, h, 1)
      this.applyTimeline(Math.max(this.timeline.end + 1, t - (this.startTime ?? 0) + this.clockOffset), t, 0, true)
      this.renderMasks()
      this.fx.render(t)
      return snapshotCanvas(this.canvas, w, h)
    }
    let out: HTMLCanvasElement
    try {
      try {
        out = renderAt(size.width, size.height)
      } catch {
        size = chooseExportSize(0)
        out = renderAt(size.width, size.height)
      }
    } finally {
      this.applySize(this.cssW, this.cssH, this.dpr)
      this.frame(t * 1000)
    }
    const blob = await canvasToPngBlob(out)
    return { blob, width: size.width, height: size.height, fallback: size.fallback }
  }

  dispose(): void {
    this.fx.dispose()
    for (const m of this.members) m.model.dispose()
    this.textures.dispose()
    this.envTarget?.dispose()
    this.skyMaterial.dispose()
    this.sky.geometry.dispose()
    this.groundMaterial.dispose()
    this.ground.geometry.dispose()
    this.shadowTex.dispose()
    this.emberMaterial.dispose()
    this.embers.geometry.dispose()
    for (const d of this.disposables) d.dispose()
    this.renderer.dispose()
    this.renderer.forceContextLoss()
  }
}
