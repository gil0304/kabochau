// LIVE compositor: draws the (mirrored) camera frame and one tracked 3D
// pumpkin per person into ONE WebGL canvas, so preview and export are
// pixel-consistent.
//
// Multi-person: each track (see utils/faceTracks.ts) owns its filters, pose,
// expression and PumpkinModel. All models are created up front and hidden
// when unused, so the light count (shader variant) never changes mid-session.
// Each pumpkin sits at a depth inversely proportional to its face size and is
// scaled by the same factor: nearer people occlude farther ones while the
// on-screen registration is unchanged.
//
// Registration chain (see README "Coordinate systems"):
//   landmarks (raw camera) -> display space (mirrored) -> face frame / pose
//   -> cover-crop (imageExport.coverCrop) -> viewport pixels -> world at depth D.
// The camera texture is cropped & mirrored in the background shader with the
// very same crop, so CSS object-fit / devicePixelRatio never enter the math.

import * as THREE from 'three'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { clamp, smoothstep } from '../utils/math'
import { SCAN_CONTOURS } from '../utils/landmarkIndices'
import {
  computeFaceParams,
  normalizeLandmarks,
  type LandmarkLike,
  type PumpkinFaceParams,
} from '../utils/faceMapping'
import {
  NEUTRAL_EXPRESSION,
  OneEuroVector,
  dampFactor,
  deriveExpression,
  expressionGlow,
  smoothExpression,
  type BlendshapeMap,
  type ExpressionState,
} from '../utils/expressionMapping'
import {
  DEFAULT_STEM,
  LIVE_HEAD_CENTER_Y,
  LIVE_HEAD_SCALE,
  LIVE_PUMPKIN_SHAPE,
  LIVE_STYLE,
  buildCarveLayout,
  frontSurfaceZ,
} from '../utils/pumpkinGeometry'
import {
  canvasToPngBlob,
  chooseExportSize,
  coverCrop,
  orientExportSize,
  liveExportCrop,
  liveFaceDepth,
  sourcePixelScale,
  sourceToViewport,
  videoUvTransform,
  type CropRect,
} from '../utils/imageExport'
import { boundsCenter, coverageFit, projectedEllipse, smoothCoverage } from '../utils/headCoverage'
import type { Vec2 } from '../utils/math'
import { PumpkinModel } from './pumpkinModel'
import { HalloweenBackdrop } from './halloweenBackdrop'
import { PostFx, createRenderer, snapshotCanvas } from './postfx'
import { createPumpkinTextures, type PumpkinTextures } from './textures'
import { FrameGovernor, type QualityTier } from './quality'

export type LiveMode = 'live' | 'carve'

export interface FaceObservation {
  landmarks: readonly LandmarkLike[]
  blendshapes: BlendshapeMap | null
  imageWidth: number
  imageHeight: number
  /** seconds */
  time: number
}

export interface CaptureResult {
  blob: Blob
  width: number
  height: number
  fallback: boolean
}

interface Pose {
  ax: number
  ay: number
  /** face width / source height */
  fw: number
  x: THREE.Vector3
  y: THREE.Vector3
}

const DEPTH = 10
// Narrow FOV (near-orthographic): the pumpkin centre sits ~1 face width behind
// the pinned eye point, and a wide FOV would shrink its silhouette by 15-20%,
// leaving the chin / hair uncovered. 16° keeps that under ~6%.
const FOV = 16
const BLOOM_STRENGTH = 0.6
/** silhouette safety margin (ribs / dimples make the real outline smaller than the ellipsoid) */
const COVER_MARGIN = 0.88
const COVER_MAX = 1.5
const MIRRORED = true

const bgVertex = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`
const bgFragment = /* glsl */ `
  uniform sampler2D uVideo;
  uniform vec4 uUv;
  uniform vec4 uCoverUv;
  uniform float uDim;
  uniform float uDesat;
  uniform vec3 uTint;
  uniform float uHasVideo;
  uniform float uNight;
  varying vec2 vUv;
  void main() {
    vec2 uv = vec2(vUv.x * uUv.x + uUv.z, vUv.y * uUv.y + uUv.w);
    vec3 c;
    vec2 outside = step(vec2(1.0), uv) + step(uv, vec2(0.0));
    if (outside.x + outside.y > 0.0) {
      // zoomed-out group export extends past the camera frame: fill the bars with
      // a blurred, darkened full-bleed version of the frame (story-style)
      vec2 cuv = vec2(vUv.x * uCoverUv.x + uCoverUv.z, vUv.y * uCoverUv.y + uCoverUv.w);
      vec3 acc = vec3(0.0);
      for (int i = 0; i < 24; i++) {
        float a = float(i) * 2.39996;
        float r = sqrt(float(i) + 0.5) / sqrt(24.0) * 0.07;
        acc += texture2D(uVideo, clamp(cuv + vec2(cos(a), sin(a)) * r, 0.0, 1.0)).rgb;
      }
      c = acc / 24.0 * uHasVideo;
      c = mix(c, vec3(dot(c, vec3(0.2126, 0.7152, 0.0722))), 0.45) * 0.3 * uTint;
    } else {
      c = texture2D(uVideo, uv).rgb * uHasVideo;
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      vec3 day = mix(c, vec3(l), uDesat) * uDim * uTint;
      // Halloween night: the room behind the people turns into a moonlit purple night
      vec3 night = mix(c, vec3(l), 0.5) * vec3(0.3, 0.25, 0.46) * mix(1.1, 0.72, vUv.y);
      c = mix(day, night, uNight);
    }
    gl_FragColor = vec4(c, 1.0);
  }`

// People (segmentation mask) drawn over the backdrop with the normal LIVE
// grade; at the far plane with depth test so pumpkin heads stay in front.
const personVertex = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.9999, 1.0); }`
const personFragment = /* glsl */ `
  uniform sampler2D uVideo;
  uniform sampler2D uMask;
  uniform vec4 uUv;
  uniform float uDim;
  uniform float uDesat;
  uniform vec3 uTint;
  uniform float uOpacity;
  varying vec2 vUv;
  void main() {
    vec2 uv = vec2(vUv.x * uUv.x + uUv.z, vUv.y * uUv.y + uUv.w);
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) discard;
    // mask rows run top -> bottom, the video texture is flipped (v = 1 at the top)
    float m = texture2D(uMask, vec2(uv.x, 1.0 - uv.y)).r;
    float a = smoothstep(0.3, 0.7, m) * uOpacity;
    if (a < 0.003) discard;
    vec3 c = texture2D(uVideo, uv).rgb;
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    gl_FragColor = vec4(mix(c, vec3(l), uDesat) * uDim * uTint, a);
  }`

const scanVertex = /* glsl */ `
  uniform float uSize;
  uniform float uScanY;
  varying float vBoost;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vBoost = 1.0 - smoothstep(0.0, 60.0, abs(position.y - uScanY));
    gl_PointSize = uSize * (1.0 + vBoost * 0.8);
    gl_Position = projectionMatrix * mv;
  }`
const scanFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uAlpha;
  varying float vBoost;
  void main() {
    vec2 d = gl_PointCoord - 0.5;
    float a = smoothstep(0.5, 0.15, length(d));
    gl_FragColor = vec4(uColor * (1.0 + vBoost * 1.5), a * uAlpha);
  }`

/** Per-person state: filters, pose, expression and the pumpkin it wears. */
class LiveTrack {
  id = 0
  readonly anchorFilter = new OneEuroVector(3, 1.0, 6.0, 1.0)
  readonly axisFilter = new OneEuroVector(6, 1.2, 1.5, 1.0)
  readonly pointFilter = new OneEuroVector(478 * 3, 2.0, 5.0, 1.0)
  target: Pose | null = null
  display: Pose | null = null
  params: PumpkinFaceParams | null = null
  targetExpression: ExpressionState = NEUTRAL_EXPRESSION
  expression: ExpressionState = NEUTRAL_EXPRESSION
  lastSeen = -Infinity
  visibility = 0
  lastLayout = -Infinity
  layoutDirty = false
  landmarks: readonly LandmarkLike[] | null = null
  /** slide toward the face + extra scale so the whole face stays covered (utils/headCoverage.ts) */
  coverShift = 0
  coverGrow = 1
  coverTime = -Infinity
  private tmpVec = new THREE.Vector3()

  constructor(readonly model: PumpkinModel) {}

  /** Re-assigns this slot to a (new) person. */
  claim(id: number): void {
    this.id = id
    this.lastSeen = -Infinity
    this.display = null
    this.target = null
    this.params = null
    this.visibility = 0
    this.expression = this.targetExpression = NEUTRAL_EXPRESSION
    this.landmarks = null
    this.lastLayout = -Infinity
    this.coverShift = 0
    this.coverGrow = 1
    this.coverTime = -Infinity
    this.anchorFilter.reset()
    this.axisFilter.reset()
    this.pointFilter.reset()
  }

  release(): void {
    this.id = 0
    this.display = null
    this.target = null
    this.visibility = 0
    this.landmarks = null
    this.model.setVisible(false)
  }

  get free(): boolean {
    return this.id === 0
  }

  observe(obs: FaceObservation): void {
    const face = normalizeLandmarks(obs.landmarks, obs.imageWidth, obs.imageHeight, MIRRORED)
    if (!face) return
    const t = obs.time
    if (t - this.lastSeen > 0.6) {
      // re-acquired after a loss: snap instead of sweeping from the old pose
      this.anchorFilter.reset()
      this.axisFilter.reset()
      this.pointFilter.reset()
      this.display = null
    }
    this.lastSeen = t
    const f = face.frame
    const a = this.anchorFilter.filter([f.originNorm.x, f.originNorm.y, f.faceWidthPx / obs.imageHeight], t)
    const ax = this.axisFilter.filter([f.xAxis.x, f.xAxis.y, f.xAxis.z, f.yAxis.x, f.yAxis.y, f.yAxis.z], t)
    const x = new THREE.Vector3(ax[0], ax[1], ax[2]).normalize()
    const y = new THREE.Vector3(ax[3], ax[4], ax[5])
    y.sub(x.clone().multiplyScalar(y.dot(x))).normalize()
    this.target = { ax: a[0]!, ay: a[1]!, fw: a[2]!, x, y }
    if (!this.display) this.display = { ax: a[0]!, ay: a[1]!, fw: a[2]!, x: x.clone(), y: y.clone() }

    const points = this.pointFilter.filter(face.points, t)
    this.params = computeFaceParams({ frame: f, points, count: face.count })
    this.targetExpression = deriveExpression(this.params, obs.blendshapes)
    this.layoutDirty = true
    this.landmarks = obs.landmarks
  }

  update(t: number, dt: number, mode: LiveMode): void {
    const seen = t - this.lastSeen < 0.35
    const targetVis = seen && this.display ? 1 : 0
    this.visibility += (targetVis - this.visibility) * dampFactor(dt, targetVis > this.visibility ? 0.07 : 0.05)
    if (this.visibility < 0.002 && !seen) this.visibility = 0

    if (this.display && this.target) {
      const k = dampFactor(dt, 0.03)
      const d = this.display
      const g = this.target
      d.ax += (g.ax - d.ax) * k
      d.ay += (g.ay - d.ay) * k
      d.fw += (g.fw - d.fw) * k
      d.x.lerp(g.x, k).normalize()
      d.y.lerp(g.y, k)
      d.y.sub(this.tmpVec.copy(d.x).multiplyScalar(d.y.dot(d.x))).normalize()
    }
    this.expression = smoothExpression(this.expression, this.targetExpression, dt)

    if (mode === 'live' && this.params && (this.layoutDirty || t - this.lastLayout > 0.05) && t - this.lastLayout > 0.028) {
      const layout = buildCarveLayout(this.params, LIVE_STYLE, this.expression, LIVE_PUMPKIN_SHAPE)
      this.model.setCarving(layout.features.map((f) => f.outline))
      this.layoutDirty = false
      this.lastLayout = t
    }
    const glow = expressionGlow(this.expression)
    // daylight camera backgrounds: keep the candle below white-out so the colour stays orange
    this.model.setGlow(glow.intensity * 0.55, glow.warmth)
    this.model.update(t)
  }

  /** Forgotten by the matcher and fully faded out: the slot can be reused. */
  expired(t: number): boolean {
    return !this.free && t - this.lastSeen > 1.0 && this.visibility === 0
  }
}

export class LiveCompositor {
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 100)
  private overlayScene = new THREE.Scene()
  private overlayCamera = new THREE.OrthographicCamera(0, 1, 1, 0, -10, 10)
  private fx: PostFx
  private videoTexture: THREE.VideoTexture
  private bgMaterial: THREE.ShaderMaterial
  private bgMesh: THREE.Mesh
  private textures: PumpkinTextures
  private tracks: LiveTrack[] = []
  private backdrop: HalloweenBackdrop
  private personMaterial: THREE.ShaderMaterial
  private personMesh: THREE.Mesh
  private maskTexture: THREE.DataTexture
  private maskData: Uint8Array
  /** time (s) of the last person mask; the occlusion fades out when masks stop */
  private maskTime = -Infinity
  private maskLevel = 0
  private envTarget: THREE.WebGLRenderTarget | null = null
  private scanPoints: THREE.Points
  private scanLines: THREE.LineSegments
  private scanMaterial: THREE.ShaderMaterial
  private scanLineMaterial: THREE.LineBasicMaterial
  private scanIndices: number[]
  private scanLineCount: number
  private governor: FrameGovernor
  private tier: QualityTier
  private mode: LiveMode = 'live'

  private cssW = 1
  private cssH = 1
  private dpr = 1
  private lastTime = 0
  private anchorOnPumpkin: THREE.Vector3
  private tmpMatrix = new THREE.Matrix4()
  private tmpQuat = new THREE.Quaternion()
  private tmpVec = new THREE.Vector3()

  constructor(
    private canvas: HTMLCanvasElement,
    private video: HTMLVideoElement,
    tier: QualityTier,
  ) {
    this.tier = tier
    this.renderer = createRenderer(canvas, THREE.NeutralToneMapping)
    this.dpr = Math.min(window.devicePixelRatio || 1, tier.maxPixelRatio)
    this.governor = new FrameGovernor(this.dpr, tier.bloom)

    // camera background
    this.videoTexture = new THREE.VideoTexture(video)
    this.videoTexture.colorSpace = THREE.SRGBColorSpace
    this.videoTexture.minFilter = THREE.LinearFilter
    this.videoTexture.magFilter = THREE.LinearFilter
    this.videoTexture.generateMipmaps = false
    this.bgMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uVideo: { value: this.videoTexture },
        uUv: { value: new THREE.Vector4(1, 1, 0, 0) },
        uCoverUv: { value: new THREE.Vector4(1, 1, 0, 0) },
        uDim: { value: 0.86 },
        uDesat: { value: 0.12 },
        uTint: { value: new THREE.Vector3(0.96, 0.97, 1.04) },
        uHasVideo: { value: 0 },
        uNight: { value: 0 },
      },
      vertexShader: bgVertex,
      fragmentShader: bgFragment,
      depthTest: false,
      depthWrite: false,
    })
    this.bgMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.bgMaterial)
    this.bgMesh.frustumCulled = false
    this.bgMesh.renderOrder = -1000
    this.scene.add(this.bgMesh)

    // Halloween backdrop (LIVE) + segmented people drawn over it
    this.backdrop = new HalloweenBackdrop()
    this.scene.add(this.backdrop.group)
    this.maskData = new Uint8Array(4)
    this.maskTexture = new THREE.DataTexture(this.maskData, 2, 2, THREE.RedFormat, THREE.UnsignedByteType)
    this.maskTexture.minFilter = this.maskTexture.magFilter = THREE.LinearFilter
    this.maskTexture.needsUpdate = true
    const bgU = this.bgMaterial.uniforms
    this.personMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uVideo: bgU.uVideo!,
        uUv: bgU.uUv!,
        uDim: bgU.uDim!,
        uDesat: bgU.uDesat!,
        uTint: bgU.uTint!,
        uMask: { value: this.maskTexture },
        uOpacity: { value: 0 },
      },
      vertexShader: personVertex,
      fragmentShader: personFragment,
      transparent: true,
      depthTest: true,
      depthWrite: false,
    })
    this.personMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.personMaterial)
    this.personMesh.frustumCulled = false
    this.personMesh.renderOrder = -800
    this.scene.add(this.personMesh)

    // lighting: warm key from above-front, cool rim, soft ambient + room env for sheen
    this.scene.add(new THREE.HemisphereLight(0xffe2c4, 0x1c120c, 0.45))
    const key = new THREE.DirectionalLight(0xfff0dd, 1.45)
    key.position.set(-2.5, 4, 6)
    this.scene.add(key)
    const rim = new THREE.DirectionalLight(0x9db4ff, 1.1)
    rim.position.set(4, 2, -3)
    this.scene.add(rim)
    try {
      const pmrem = new THREE.PMREMGenerator(this.renderer)
      this.envTarget = pmrem.fromScene(new RoomEnvironment(), 0.04)
      this.scene.environment = this.envTarget.texture
      this.scene.environmentIntensity = 0.45
      pmrem.dispose()
    } catch {
      this.envTarget = null
    }

    // one pumpkin per trackable person, created up front (see header)
    this.textures = createPumpkinTextures(tier.textures)
    for (let i = 0; i < Math.max(1, tier.maxFaces); i++) {
      const model = new PumpkinModel({
        shape: LIVE_PUMPKIN_SHAPE,
        stem: DEFAULT_STEM,
        textures: this.textures,
        maskSize: tier.maskSize,
        segments: tier.shellSegments,
        halo: 0.08,
        spill: 0.25,
      })
      model.setVisible(false)
      this.scene.add(model.group)
      this.tracks.push(new LiveTrack(model))
    }
    // The eye midpoint on the pumpkin's front surface is pinned to the tracked
    // eye midpoint, so the carved openings stay registered even though the
    // pumpkin itself is centred on (and covers) the whole head.
    const ay = LIVE_STYLE.anchorY * LIVE_PUMPKIN_SHAPE.radiusY
    this.anchorOnPumpkin = new THREE.Vector3(0, ay, frontSurfaceZ(LIVE_PUMPKIN_SHAPE, 0, ay) ?? 0.9)

    // MAKE scan overlay (feature contours as glowing points + lines), one block per person
    this.scanIndices = SCAN_CONTOURS.flat()
    const perFace = this.scanIndices.length
    const faces = this.tracks.length
    const scanGeo = new THREE.BufferGeometry()
    scanGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(perFace * faces * 3), 3))
    this.scanMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(1.6, 0.75, 0.25) },
        uSize: { value: 3 },
        uScanY: { value: 0 },
        uAlpha: { value: 1 },
      },
      vertexShader: scanVertex,
      fragmentShader: scanFragment,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    this.scanPoints = new THREE.Points(scanGeo, this.scanMaterial)
    this.scanPoints.frustumCulled = false
    const lineIdx: number[] = []
    for (let face = 0; face < faces; face++) {
      let offset = face * perFace
      for (const contour of SCAN_CONTOURS) {
        const closed = contour !== SCAN_CONTOURS[6] && contour !== SCAN_CONTOURS[7]
        for (let i = 0; i < contour.length - 1; i++) lineIdx.push(offset + i, offset + i + 1)
        if (closed) lineIdx.push(offset + contour.length - 1, offset)
        offset += contour.length
      }
    }
    this.scanLineCount = lineIdx.length / faces
    const lineGeo = new THREE.BufferGeometry()
    lineGeo.setAttribute('position', scanGeo.getAttribute('position'))
    lineGeo.setIndex(lineIdx)
    this.scanLineMaterial = new THREE.LineBasicMaterial({
      color: new THREE.Color(1.3, 0.55, 0.18),
      transparent: true,
      opacity: 0.55,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    })
    this.scanLines = new THREE.LineSegments(lineGeo, this.scanLineMaterial)
    this.scanLines.frustumCulled = false
    this.overlayScene.add(this.scanLines, this.scanPoints)
    this.scanLines.visible = this.scanPoints.visible = false

    this.fx = new PostFx(
      this.renderer,
      [
        { scene: this.scene, camera: this.camera },
        { scene: this.overlayScene, camera: this.overlayCamera },
      ],
      {
        bloom: tier.bloom,
        bloomStrength: BLOOM_STRENGTH,
        bloomRadius: 0.4,
        bloomThreshold: 0.95,
        samples: tier.msaaSamples,
        vignette: 0.32,
        grain: 0.018,
      },
    )
  }

  /** Max people this compositor can dress at once. */
  get capacity(): number {
    return this.tracks.length
  }

  get hasFace(): boolean {
    return this.tracks.some((tr) => !tr.free && tr.display !== null && tr.visibility > 0.5)
  }

  /** Number of people currently wearing a (visible) pumpkin. */
  get faceCount(): number {
    return this.tracks.filter((tr) => !tr.free && tr.display !== null && tr.visibility > 0.5).length
  }

  setMode(mode: LiveMode): void {
    this.mode = mode
    const u = this.bgMaterial.uniforms
    if (mode === 'carve') {
      u.uDim!.value = 0.62
      u.uDesat!.value = 0.55
      u.uTint!.value.set(0.82, 0.86, 1.12)
    } else {
      u.uDim!.value = 0.86
      u.uDesat!.value = 0.12
      u.uTint!.value.set(0.96, 0.97, 1.04)
    }
  }

  resize(cssWidth: number, cssHeight: number): void {
    this.cssW = Math.max(1, Math.round(cssWidth))
    this.cssH = Math.max(1, Math.round(cssHeight))
    this.applySize(this.cssW, this.cssH, this.dpr)
  }

  private applySize(w: number, h: number, pixelRatio: number): void {
    this.renderer.setPixelRatio(pixelRatio)
    this.renderer.setSize(w, h, false)
    this.fx.setSize(w, h, pixelRatio)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.overlayCamera.left = 0
    this.overlayCamera.right = w
    this.overlayCamera.top = h
    this.overlayCamera.bottom = 0
    this.overlayCamera.updateProjectionMatrix()
    this.scanMaterial.uniforms.uSize!.value = 3.2 * pixelRatio
  }

  /**
   * Feed one detection per tracked person (ids from FaceTrackMatcher). Unknown
   * ids claim a free pumpkin; when none is free the observation is ignored.
   */
  setFaces(faces: ReadonlyArray<{ id: number; observation: FaceObservation }>): void {
    for (const { id, observation } of faces) {
      let track = this.tracks.find((tr) => tr.id === id)
      if (!track) {
        track = this.tracks.find((tr) => tr.free)
        if (!track) continue
        track.claim(id)
      }
      track.observe(observation)
    }
  }

  /**
   * Person-probability mask from the selfie segmenter (source orientation,
   * values 0..1). Lightly smoothed over time to calm edge flicker.
   */
  setPersonMask(data: Float32Array, width: number, height: number, timeSec: number): void {
    const n = width * height
    if (n <= 0 || data.length < n) return
    const fresh = this.maskTexture.image.width !== width || this.maskTexture.image.height !== height || timeSec - this.maskTime > 0.5
    if (this.maskData.length !== n) this.maskData = new Uint8Array(n)
    const out = this.maskData
    for (let i = 0; i < n; i++) {
      const v = Math.max(0, Math.min(255, data[i]! * 255))
      out[i] = fresh ? v : out[i]! * 0.35 + v * 0.65
    }
    if (this.maskTexture.image.width !== width || this.maskTexture.image.height !== height || this.maskTexture.image.data !== out) {
      this.maskTexture.dispose()
      this.maskTexture = new THREE.DataTexture(out, width, height, THREE.RedFormat, THREE.UnsignedByteType)
      this.maskTexture.minFilter = this.maskTexture.magFilter = THREE.LinearFilter
      this.maskTexture.unpackAlignment = 1
      this.personMaterial.uniforms.uMask!.value = this.maskTexture
    }
    this.maskTexture.needsUpdate = true
    this.maskTime = timeSec
  }

  /** Clears tracking immediately (e.g. after returning from the result view). */
  resetTracking(): void {
    for (const tr of this.tracks) tr.release()
  }

  private videoSize(): { w: number; h: number } | null {
    const w = this.video.videoWidth
    const h = this.video.videoHeight
    return w > 0 && h > 0 ? { w, h } : null
  }

  private updateState(t: number): void {
    const dt = clamp(t - this.lastTime, 0, 0.1)
    this.lastTime = t
    // person occlusion fades in with masks and out when they stop arriving
    const masked = this.mode === 'live' && t - this.maskTime < 1
    this.maskLevel += ((masked ? 1 : 0) - this.maskLevel) * dampFactor(dt, 0.25)
    for (const tr of this.tracks) {
      if (tr.free) continue
      tr.update(t, dt, this.mode)
      if (tr.expired(t)) tr.release()
    }
  }

  /** Positions everything for a viewport of w×h pixels showing `crop` of the camera. */
  private layoutFrame(w: number, h: number, crop: CropRect): void {
    const vs = this.videoSize()
    const uv = videoUvTransform(crop, MIRRORED)
    this.bgMaterial.uniforms.uUv!.value.set(uv.sx, uv.sy, uv.ox, uv.oy)
    // Halloween backdrop in LIVE: with a person mask the room becomes night and
    // the people are redrawn over the objects; without one, only a light grade
    const halloween = this.mode === 'live' && !!vs
    this.backdrop.visible = halloween
    // objects low in the frame (castle, mist, embers) would sit on bodies without a mask
    if (halloween) this.backdrop.update(this.lastTime, this.camera, this.maskLevel)
    this.personMesh.visible = halloween && this.maskLevel > 0.01
    this.personMaterial.uniforms.uOpacity!.value = this.maskLevel
    this.bgMaterial.uniforms.uNight!.value = halloween ? 0.3 + 0.7 * this.maskLevel : 0
    if (vs) {
      const cover = videoUvTransform(coverCrop(vs.w, vs.h, w, h), MIRRORED)
      this.bgMaterial.uniforms.uCoverUv!.value.set(cover.sx, cover.sy, cover.ox, cover.oy)
    }
    this.bgMaterial.uniforms.uHasVideo!.value = vs ? 1 : 0

    for (const tr of this.tracks) {
      const pose = tr.display
      const show = this.mode === 'live' && !tr.free && !!pose && !!vs && tr.visibility > 0.001
      tr.model.setVisible(show)
      if (!show || !pose || !vs) continue
      const anchorPx = sourceToViewport({ x: pose.ax, y: pose.ay }, crop, w, h)
      const pxScale = sourcePixelScale(vs.w, crop, w)
      const faceWidthPx = pose.fw * vs.h * pxScale
      const depth = liveFaceDepth(pose.fw, DEPTH)
      const halfH = depth * Math.tan(THREE.MathUtils.degToRad(FOV / 2))
      const worldPerPx = (2 * halfH) / h
      const s = (faceWidthPx * worldPerPx) / LIVE_STYLE.faceScale
      const z = new THREE.Vector3().crossVectors(pose.x, pose.y)
      this.tmpMatrix.makeBasis(pose.x, pose.y, z)
      this.tmpQuat.setFromRotationMatrix(this.tmpMatrix)
      const anchorWorld = this.tmpVec.set((anchorPx.x - w / 2) * worldPerPx, (h / 2 - anchorPx.y) * worldPerPx, -depth)
      const cover = this.faceCoverage(tr, anchorWorld, s, crop, w, h, worldPerPx)
      const pop = smoothstep(0, 1, tr.visibility)
      const scale = s * cover.grow * (0.6 + 0.4 * pop) * (pop > 0 ? 1 : 0)
      // pumpkin centre pinned at the eyes (full-size offset), slid toward the face if needed
      const offset = this.anchorOnPumpkin.clone().multiplyScalar(s).applyQuaternion(this.tmpQuat)
      tr.model.group.position.copy(anchorWorld).sub(offset)
      tr.model.group.position.x += cover.dx
      tr.model.group.position.y += cover.dy
      tr.model.group.quaternion.copy(this.tmpQuat)
      tr.model.group.scale.setScalar(Math.max(1e-4, scale))
    }

    const scanned = this.mode === 'carve' ? this.tracks.filter((tr) => !tr.free && tr.landmarks && tr.visibility > 0.05) : []
    this.scanPoints.visible = this.scanLines.visible = scanned.length > 0
    if (scanned.length > 0) {
      const attr = this.scanPoints.geometry.getAttribute('position') as THREE.BufferAttribute
      const arr = attr.array as Float32Array
      const perFace = this.scanIndices.length
      scanned.forEach((tr, face) => {
        const lm = tr.landmarks!
        this.scanIndices.forEach((li, k) => {
          const l = lm[li]
          if (!l) return
          const p = sourceToViewport({ x: MIRRORED ? 1 - l.x : l.x, y: l.y }, crop, w, h)
          const o = (face * perFace + k) * 3
          arr[o] = p.x
          arr[o + 1] = h - p.y
          arr[o + 2] = 0
        })
      })
      attr.needsUpdate = true
      this.scanPoints.geometry.setDrawRange(0, perFace * scanned.length)
      this.scanLines.geometry.setDrawRange(0, this.scanLineCount * scanned.length)
      const vis = Math.max(...scanned.map((tr) => tr.visibility))
      this.scanMaterial.uniforms.uAlpha!.value = vis
      this.scanLineMaterial.opacity = 0.55 * vis
    }
  }

  /**
   * How far the pumpkin of `tr` must slide toward the face (and, if that is
   * not enough, grow) so that every face landmark stays inside its silhouette
   * — e.g. when looking down the pumpkin centre swings up and the chin would
   * otherwise peek out. Computed in the screen plane at the anchor depth
   * (near-orthographic camera). Returns the world-plane offset and growth.
   */
  private faceCoverage(
    tr: LiveTrack,
    anchorWorld: THREE.Vector3,
    scale: number,
    crop: CropRect,
    w: number,
    h: number,
    worldPerPx: number,
  ): { dx: number; dy: number; grow: number } {
    const offset = this.anchorOnPumpkin.clone().multiplyScalar(scale).applyQuaternion(this.tmpQuat)
    const center = { x: anchorWorld.x - offset.x, y: anchorWorld.y - offset.y }
    const lm = tr.landmarks
    const e = this.tmpMatrix.elements // rotation (basis) set just before; column-major
    const shape = LIVE_PUMPKIN_SHAPE
    const quad = lm?.length
      ? projectedEllipse([e[0]!, e[4]!, e[8]!, e[1]!, e[5]!, e[9]!, e[2]!, e[6]!, e[10]!], [shape.radiusX, shape.radiusY, shape.radiusZ], scale, COVER_MARGIN)
      : null
    let target = center
    if (lm && quad) {
      const points: Vec2[] = new Array(Math.min(lm.length, 468))
      for (let i = 0; i < points.length; i++) {
        const l = lm[i]!
        const p = sourceToViewport({ x: MIRRORED ? 1 - l.x : l.x, y: l.y }, crop, w, h)
        points[i] = { x: (p.x - w / 2) * worldPerPx, y: (h / 2 - p.y) * worldPerPx }
      }
      target = boundsCenter(points)
      const fit = coverageFit(points, center, target, quad, COVER_MAX)
      const dt = Math.max(0, this.lastTime - tr.coverTime)
      const step = Number.isFinite(dt) ? dt : 0
      tr.coverShift = smoothCoverage(tr.coverShift, fit.shift, step)
      tr.coverGrow = smoothCoverage(tr.coverGrow, fit.grow, step)
      tr.coverTime = this.lastTime
    }
    return { dx: (target.x - center.x) * tr.coverShift, dy: (target.y - center.y) * tr.coverShift, grow: tr.coverGrow }
  }

  /** Renders one frame to the canvas. */
  frame(nowMs: number): void {
    const t = nowMs / 1000
    const before = performance.now()
    this.updateState(t)
    const vs = this.videoSize()
    const crop = vs ? coverCrop(vs.w, vs.h, this.cssW, this.cssH) : { x: 0, y: 0, w: 1, h: 1 }
    this.scanMaterial.uniforms.uScanY!.value = ((Math.sin(t * 1.6) + 1) / 2) * this.cssH
    this.layoutFrame(this.cssW, this.cssH, crop)
    for (const tr of this.tracks) tr.model.renderMask(this.renderer)
    this.fx.render(t)
    if (this.governor.push(performance.now() - before + 8, nowMs)) {
      this.dpr = this.governor.pixelRatio
      this.fx.setBloom(this.governor.bloom)
      this.applySize(this.cssW, this.cssH, this.dpr)
    }
  }

  /**
   * Renders the current state at 1080×1920 (or the explicit fallback) into a
   * PNG. Uses the same layout functions as the preview; no DOM/UI is included.
   */
  async capture(): Promise<CaptureResult> {
    const vs = this.videoSize()
    if (!vs) throw new Error('camera not ready')
    const gl = this.renderer.getContext()
    if (gl.isContextLost()) throw new Error('WebGL context lost')
    const maxRb = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number
    const vp = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array
    const maxVp = Math.min(vp[0] ?? maxRb, vp[1] ?? maxRb)
    let size = orientExportSize(chooseExportSize(maxRb, maxVp, this.tier.name === 'low'), this.cssW, this.cssH)
    const previewCrop = coverCrop(vs.w, vs.h, this.cssW, this.cssH)
    // every pumpkin head the user could see in the preview (people outside the
    // on-screen crop must not drag the saved framing toward them): centred on
    // the head, radius incl. stem margin
    const inPreview = (x: number, y: number) =>
      x >= previewCrop.x && x <= previewCrop.x + previewCrop.w && y >= previewCrop.y && y <= previewCrop.y + previewCrop.h
    const faces =
      this.mode === 'live'
        ? this.tracks
            .filter((tr) => !tr.free && tr.display && tr.visibility > 0.5 && inPreview(tr.display.ax, tr.display.ay))
            .map((tr) => {
              const pose = tr.display!
              return {
                anchor: { x: pose.ax, y: pose.ay - LIVE_HEAD_CENTER_Y * pose.fw },
                radius: ((pose.fw * vs.h * LIVE_HEAD_SCALE) / vs.w) * 1.15,
              }
            })
        : []
    const t = this.lastTime
    const renderAt = (w: number, h: number) => {
      const crop = liveExportCrop(vs.w, vs.h, previewCrop, faces, w, h)
      // zoomed out for a wide group: pumpkins are smaller, so soften the bloom to match the preview look
      const zoom = crop.w / coverCrop(vs.w, vs.h, w, h).w
      this.fx.setBloom(this.governor.bloom, BLOOM_STRENGTH / Math.max(1, zoom))
      this.applySize(w, h, 1)
      this.scanMaterial.uniforms.uSize!.value = 3.2 * (h / this.cssH)
      this.layoutFrame(w, h, crop)
      for (const tr of this.tracks) tr.model.renderMask(this.renderer)
      this.fx.render(t)
      return snapshotCanvas(this.canvas, w, h)
    }
    let out: HTMLCanvasElement
    try {
      try {
        out = renderAt(size.width, size.height)
      } catch {
        size = orientExportSize(chooseExportSize(0), this.cssW, this.cssH)
        out = renderAt(size.width, size.height)
      }
    } finally {
      this.fx.setBloom(this.governor.bloom, BLOOM_STRENGTH)
      this.applySize(this.cssW, this.cssH, this.dpr)
      this.frame(t * 1000)
    }
    const blob = await canvasToPngBlob(out)
    return { blob, width: size.width, height: size.height, fallback: size.fallback }
  }

  /** Called when the camera stream (re)starts so the texture picks up new dimensions. */
  refreshVideo(): void {
    this.videoTexture.needsUpdate = true
  }

  dispose(): void {
    this.fx.dispose()
    for (const tr of this.tracks) tr.model.dispose()
    this.textures.dispose()
    this.videoTexture.dispose()
    this.backdrop.dispose()
    this.personMaterial.dispose()
    this.personMesh.geometry.dispose()
    this.maskTexture.dispose()
    this.bgMaterial.dispose()
    this.bgMesh.geometry.dispose()
    this.scanPoints.geometry.dispose()
    this.scanLines.geometry.dispose()
    this.scanMaterial.dispose()
    this.scanLineMaterial.dispose()
    this.envTarget?.dispose()
    this.renderer.dispose()
    this.renderer.forceContextLoss()
  }
}
