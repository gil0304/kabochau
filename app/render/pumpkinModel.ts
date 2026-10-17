// three.js realisation of the pumpkin data model (utils/pumpkinGeometry.ts).
//
// Carving technique (no CSG):
//   1. Feature outlines are rasterised on the GPU into a mask render target
//      (orthographic front projection of object x/y).
//   2. The outer rind and the inner flesh are the same closed shell mesh;
//      both discard fragments on the front hemisphere where the mask is set,
//      producing real see-through openings.
//   3. Cut walls are extruded from the skin inwards along the same outlines,
//      giving the openings physical thickness with an emissive gradient
//      (bright where the candle light hits the cut flesh).
//   4. Through the openings you see the back-facing interior, lit by an
//      emissive falloff around the candle plus a point light and a flame sprite.
//   5. A blurred (mip) sample of the mask adds light spill on the rind around
//      the cuts; bloom (post-processing) adds the halo.

import * as THREE from 'three'
import type { Vec2 } from '../utils/math'
import {
  buildCutWalls,
  buildShellMesh,
  buildStemMesh,
  shellPoint,
  type PumpkinShape,
  type StemParams,
  type WallMeshData,
} from '../utils/pumpkinGeometry'
import { createFlameTexture, createRadialTexture, type PumpkinTextures } from './textures'

const MASK_HALF = 1.3

export interface PumpkinModelOptions {
  shape: PumpkinShape
  stem: StemParams
  textures: PumpkinTextures
  maskSize: number
  segments: [number, number]
  wallThickness?: number
  halo?: number
  /** Strength of the light spill on the rind around the openings. */
  spill?: number
}

type Uniforms = {
  uMask: { value: THREE.Texture }
  uMaskRect: { value: THREE.Vector4 }
  uGlow: { value: number }
  uGlowColor: { value: THREE.Color }
  uCandleY: { value: number }
  uLidRadius: { value: number }
  uLid: { value: number }
  uSpill: { value: number }
  /** this pumpkin's candle in view space (xyz) + match tolerance (w) */
  uCandleView: { value: THREE.Vector4 }
}

const COMMON_FRAG_DECL = /* glsl */ `
uniform sampler2D uMask;
uniform vec4 uMaskRect;
uniform float uGlow;
uniform vec3 uGlowColor;
uniform float uCandleY;
uniform float uLidRadius;
uniform float uLid;
uniform float uSpill;
uniform vec4 uCandleView;
varying vec3 vObj;
vec2 pmMaskUv() { return (vObj.xy - uMaskRect.xy) / uMaskRect.zw; }
`

// Candles are the only point lights and each sits INSIDE an opaque shell.
// Point lights cast no shadows here, so without help they would light the
// outer rind (bump-tilted normals showed bright specks / streaks in grooves)
// and, with several pumpkins, shine through one pumpkin onto its neighbours.
//  - outer rind: no point light reaches it directly (glow comes from the
//    emissive spill around the openings instead)
//  - flesh + cut walls: only this pumpkin's own candle (matched by position)
const POINT_LIGHT_CALL = 'getPointLightInfo( pointLight, geometryPosition, directLight );'
if (!THREE.ShaderChunk.lights_fragment_begin.includes(POINT_LIGHT_CALL)) {
  console.warn('[pumpkin-me] three.js light chunk changed; candle isolation is inactive')
}
const RIND_LIGHTS = THREE.ShaderChunk.lights_fragment_begin.replace(
  POINT_LIGHT_CALL,
  `${POINT_LIGHT_CALL}
		directLight.color = vec3( 0.0 );`,
)
const INNER_LIGHTS = THREE.ShaderChunk.lights_fragment_begin.replace(
  POINT_LIGHT_CALL,
  `${POINT_LIGHT_CALL}
		directLight.color *= step( distance( pointLight.position, uCandleView.xyz ), uCandleView.w );`,
)

/**
 * For props next to the pumpkins (e.g. hay bales): candles sit inside opaque
 * shells and must not light them. `extra` can patch the shader further.
 */
export function excludeCandleLights(material: THREE.Material, extra?: (shader: THREE.WebGLProgramParametersWithUniforms) => void): void {
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <lights_fragment_begin>', RIND_LIGHTS)
    extra?.(shader)
  }
}

const DISCARD = /* glsl */ `
#include <clipping_planes_fragment>
if (vObj.z > 0.0 && textureLod(uMask, pmMaskUv(), 0.0).r > 0.5) discard;
`

function patchVertex(shader: THREE.WebGLProgramParametersWithUniforms, extraDecl = '', extraBody = '') {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\nvarying vec3 vObj;\n${extraDecl}`)
    .replace('#include <begin_vertex>', `#include <begin_vertex>\nvObj = position;\n${extraBody}`)
}

export class PumpkinModel {
  readonly group = new THREE.Group()
  readonly uniforms: Uniforms
  readonly shape: PumpkinShape
  /** Lowest y of the shell (for placing the pumpkin on the ground). */
  readonly bottomY: number
  /** Top of the stem (for framing). */
  readonly topY: number
  /** Bounding box of the shell body (object space, without stem). */
  readonly bodyBox: THREE.Box3

  private shellGeometry: THREE.BufferGeometry
  private stemGeometry: THREE.BufferGeometry
  private wallGeometry: THREE.BufferGeometry
  private maskGeometry: THREE.BufferGeometry
  private materials: THREE.Material[] = []
  private ownedTextures: THREE.Texture[] = []
  private maskTarget: THREE.WebGLRenderTarget
  private maskScene = new THREE.Scene()
  private maskCamera = new THREE.OrthographicCamera(-MASK_HALF, MASK_HALF, MASK_HALF, -MASK_HALF, 0.1, 10)
  private maskDirty = true
  private wallData: WallMeshData | undefined
  private wallThickness: number
  private candle: THREE.PointLight
  private flame: THREE.Sprite
  private halo: THREE.Sprite | null = null
  private haloStrength: number
  private glowLevel = 1
  private shown = true
  private tmpVec = new THREE.Vector3()
  private tmpScale = new THREE.Vector3()

  /** Keeps uCandleView (view-space candle position) current for the camera being rendered. */
  private updateCandleView = (_r: THREE.WebGLRenderer, _s: THREE.Scene, camera: THREE.Camera): void => {
    const m = this.candle.matrixWorld
    this.tmpVec.setFromMatrixPosition(m).applyMatrix4(camera.matrixWorldInverse)
    const tolerance = 0.1 * Math.max(1e-6, this.tmpScale.setFromMatrixScale(m).x)
    this.uniforms.uCandleView.value.set(this.tmpVec.x, this.tmpVec.y, this.tmpVec.z, tolerance)
  }
  private warmth = 0.5

  constructor(opts: PumpkinModelOptions) {
    this.shape = opts.shape
    this.wallThickness = opts.wallThickness ?? 0.085
    this.haloStrength = opts.halo ?? 0

    this.maskTarget = new THREE.WebGLRenderTarget(opts.maskSize, opts.maskSize, {
      depthBuffer: false,
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
    })
    this.uniforms = {
      uMask: { value: this.maskTarget.texture },
      uMaskRect: { value: new THREE.Vector4(-MASK_HALF, -MASK_HALF, MASK_HALF * 2, MASK_HALF * 2) },
      uGlow: { value: 1 },
      uGlowColor: { value: new THREE.Color(1.0, 0.45, 0.1) },
      uCandleY: { value: -0.38 * opts.shape.radiusY },
      uLidRadius: { value: 0.36 },
      uLid: { value: 1 },
      uSpill: { value: opts.spill ?? 0.5 },
      uCandleView: { value: new THREE.Vector4(0, 0, 0, -1) },
    }
    const u = this.uniforms

    // ----- shell (outer rind + inner flesh share the geometry)
    const shell = buildShellMesh(opts.shape, opts.segments[0], opts.segments[1])
    this.shellGeometry = new THREE.BufferGeometry()
    this.shellGeometry.setAttribute('position', new THREE.BufferAttribute(shell.positions, 3))
    this.shellGeometry.setAttribute('normal', new THREE.BufferAttribute(shell.normals, 3))
    this.shellGeometry.setAttribute('uv', new THREE.BufferAttribute(shell.uvs, 2))
    this.shellGeometry.setAttribute('aGroove', new THREE.BufferAttribute(shell.grooves, 1))
    this.shellGeometry.setIndex(new THREE.BufferAttribute(shell.indices, 1))
    this.shellGeometry.computeBoundingSphere()
    let minY = Infinity
    for (let i = 1; i < shell.positions.length; i += 3) minY = Math.min(minY, shell.positions[i]!)
    this.bottomY = minY
    this.shellGeometry.computeBoundingBox()
    this.bodyBox = this.shellGeometry.boundingBox?.clone() ?? new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1))

    const rind = new THREE.MeshStandardMaterial({
      map: opts.textures.skin,
      bumpMap: opts.textures.bump,
      bumpScale: 1.4,
      roughness: 0.52,
      metalness: 0,
      envMapIntensity: 0.6,
    })
    rind.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, u)
      patchVertex(shader, 'attribute float aGroove;\nvarying float vGroove;', 'vGroove = aGroove;')
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${COMMON_FRAG_DECL}\nvarying float vGroove;`)
        .replace('#include <clipping_planes_fragment>', DISCARD)
        .replace('#include <lights_fragment_begin>', RIND_LIGHTS)
        .replace(
          '#include <color_fragment>',
          /* glsl */ `#include <color_fragment>
          float pmG = smoothstep(0.12, 0.95, vGroove);
          diffuseColor.rgb *= mix(1.0, 0.6, pmG);
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.02, 0.78, 0.55), pmG * 0.6);`,
        )
        .replace(
          '#include <emissivemap_fragment>',
          /* glsl */ `#include <emissivemap_fragment>
          {
            vec2 muv = pmMaskUv();
            float spill = vObj.z > 0.0 ? (textureLod(uMask, muv, 2.0).r * 0.6 + textureLod(uMask, muv, 3.5).r * 0.4) : 0.0;
            totalEmissiveRadiance += uGlowColor * uGlow * spill * uSpill;
            // zig-zag lid cut around the stem, glowing faintly
            float r = length(vObj.xz);
            float ang = atan(vObj.x, vObj.z);
            float zig = abs(fract(ang * 9.0 / 6.2831853) * 2.0 - 1.0) - 0.5;
            float lidR = uLidRadius + 0.03 * zig;
            float w = fwidth(r) * 1.5 + 0.004;
            // branch-free on purpose: with a ternary the compiler may sink fwidth()
            // into non-uniform control flow, which produced a dashed bright ring
            // along y = 0.25 on the sides of the pumpkin
            float lid = (1.0 - smoothstep(w * 0.5, w, abs(r - lidR))) * step(0.25, vObj.y);
            lid *= uLid;
            diffuseColor.rgb *= 1.0 - lid * 0.7;
            totalEmissiveRadiance += uGlowColor * uGlow * lid * 1.8;
          }`,
        )
    }

    const flesh = new THREE.MeshStandardMaterial({
      color: new THREE.Color('#c9772e'),
      bumpMap: opts.textures.bump,
      bumpScale: 3,
      roughness: 0.95,
      side: THREE.BackSide,
    })
    flesh.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, u)
      patchVertex(shader)
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${COMMON_FRAG_DECL}`)
        .replace('#include <clipping_planes_fragment>', DISCARD)
        .replace('#include <lights_fragment_begin>', INNER_LIGHTS)
        .replace(
          '#include <emissivemap_fragment>',
          /* glsl */ `#include <emissivemap_fragment>
          {
            // hot, yellow-white near the candle, deep orange towards the top
            float d = length(vObj - vec3(0.0, uCandleY, 0.0));
            float fall = 1.0 / (0.3 + d * d * 1.4);
            vec3 deep = uGlowColor * vec3(1.0, 0.85, 0.6);
            vec3 hot = mix(deep, vec3(1.0, 0.62, 0.2), clamp(fall * 0.5, 0.0, 0.85));
            totalEmissiveRadiance += hot * uGlow * (0.8 + 2.6 * fall);
          }`,
        )
    }

    const outer = new THREE.Mesh(this.shellGeometry, rind)
    const inner = new THREE.Mesh(this.shellGeometry, flesh)
    outer.renderOrder = 1
    inner.renderOrder = 0
    inner.onBeforeRender = this.updateCandleView
    this.group.add(inner, outer)

    // ----- cut walls (dynamic)
    this.wallGeometry = new THREE.BufferGeometry()
    this.allocWalls(4096, 12288)
    const wallMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color('#f9cf7d'),
      roughness: 0.9,
      side: THREE.DoubleSide,
    })
    wallMat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, u)
      patchVertex(shader, 'attribute float aDepth;\nvarying float vDepth;', 'vDepth = aDepth;')
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${COMMON_FRAG_DECL}\nvarying float vDepth;`)
        .replace('#include <lights_fragment_begin>', INNER_LIGHTS)
        .replace(
          '#include <color_fragment>',
          /* glsl */ `#include <color_fragment>
          diffuseColor.rgb = mix(vec3(0.62, 0.24, 0.04), diffuseColor.rgb, smoothstep(0.0, 0.14, clamp(vDepth, 0.0, 1.0)));`,
        )
        .replace(
          '#include <emissivemap_fragment>',
          /* glsl */ `#include <emissivemap_fragment>
          {
            // clamp: with MSAA, varyings can be extrapolated slightly outside the
            // triangle; pow() of a negative base is NaN and bloom would spread it
            // over the whole frame.
            float dpt = clamp(vDepth, 0.0, 1.0);
            totalEmissiveRadiance += mix(uGlowColor, vec3(1.0, 0.66, 0.24), dpt * 0.7) * uGlow * (0.2 + 2.6 * pow(dpt, 1.4));
          }`,
        )
    }
    const walls = new THREE.Mesh(this.wallGeometry, wallMat)
    walls.frustumCulled = false
    walls.renderOrder = 2
    walls.onBeforeRender = this.updateCandleView
    this.group.add(walls)

    // ----- stem
    const stem = buildStemMesh(opts.stem, opts.shape)
    this.stemGeometry = new THREE.BufferGeometry()
    this.stemGeometry.setAttribute('position', new THREE.BufferAttribute(stem.positions, 3))
    this.stemGeometry.setAttribute('uv', new THREE.BufferAttribute(stem.uvs, 2))
    this.stemGeometry.setIndex(new THREE.BufferAttribute(stem.indices, 1))
    this.stemGeometry.computeVertexNormals()
    this.stemGeometry.computeBoundingBox()
    this.topY = this.stemGeometry.boundingBox?.max.y ?? shellPoint(opts.shape, 0, 0)[1] + opts.stem.height
    const stemMat = new THREE.MeshStandardMaterial({ map: opts.textures.stem, roughness: 0.85, bumpMap: opts.textures.bump, bumpScale: 0.8 })
    this.group.add(new THREE.Mesh(this.stemGeometry, stemMat))

    // ----- candle
    this.candle = new THREE.PointLight(0xffa64d, 3, 0, 2)
    this.candle.position.set(0, u.uCandleY.value, 0)
    this.group.add(this.candle)
    const flameTex = createFlameTexture()
    this.ownedTextures.push(flameTex)
    const flameMat = new THREE.SpriteMaterial({
      map: flameTex,
      color: new THREE.Color(2.4, 1.6, 0.8),
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    })
    this.flame = new THREE.Sprite(flameMat)
    this.flame.position.set(0, u.uCandleY.value + 0.06, 0.05)
    this.flame.scale.set(0.14, 0.26, 1)
    this.group.add(this.flame)

    if (this.haloStrength > 0) {
      const haloTex = createRadialTexture('rgba(255,150,60,1)', 'rgba(255,90,10,0)')
      this.ownedTextures.push(haloTex)
      const haloMat = new THREE.SpriteMaterial({
        map: haloTex,
        color: new THREE.Color(1, 0.55, 0.2).multiplyScalar(this.haloStrength),
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        transparent: true,
      })
      this.halo = new THREE.Sprite(haloMat)
      this.halo.scale.set(3.4, 3.2, 1)
      this.halo.position.set(0, -0.05, -0.35)
      this.halo.renderOrder = -1
      this.group.add(this.halo)
      this.materials.push(haloMat)
    }

    // ----- mask scene
    this.maskGeometry = new THREE.BufferGeometry()
    this.allocMask(4096, 12288)
    const maskMat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide })
    const maskMesh = new THREE.Mesh(this.maskGeometry, maskMat)
    maskMesh.frustumCulled = false
    this.maskScene.add(maskMesh)
    this.maskScene.background = new THREE.Color(0x000000)
    this.maskCamera.position.set(0, 0, 5)
    this.maskCamera.lookAt(0, 0, 0)

    this.materials.push(rind, flesh, wallMat, stemMat, flameMat, maskMat)
  }

  private allocWalls(vertices: number, indices: number) {
    const g = this.wallGeometry
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vertices * 3), 3).setUsage(THREE.DynamicDrawUsage))
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(vertices * 3), 3).setUsage(THREE.DynamicDrawUsage))
    g.setAttribute('aDepth', new THREE.BufferAttribute(new Float32Array(vertices), 1).setUsage(THREE.DynamicDrawUsage))
    g.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1).setUsage(THREE.DynamicDrawUsage))
    g.setDrawRange(0, 0)
    this.wallData = undefined
  }

  private allocMask(vertices: number, indices: number) {
    const g = this.maskGeometry
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vertices * 3), 3).setUsage(THREE.DynamicDrawUsage))
    g.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1).setUsage(THREE.DynamicDrawUsage))
    g.setDrawRange(0, 0)
  }

  /** Replaces the carved openings. Cheap enough to call per detection in LIVE. */
  setCarving(outlines: ReadonlyArray<readonly Vec2[]>): void {
    // --- mask triangles
    let vTotal = 0
    for (const o of outlines) vTotal += o.length
    const posAttr = this.maskGeometry.getAttribute('position') as THREE.BufferAttribute
    if (vTotal > posAttr.count) this.allocMask(vTotal * 2, vTotal * 6)
    const mPos = this.maskGeometry.getAttribute('position') as THREE.BufferAttribute
    const mIdx = this.maskGeometry.getIndex()!
    const mp = mPos.array as Float32Array
    const mi = mIdx.array as Uint32Array
    let v = 0
    let i = 0
    for (const o of outlines) {
      if (o.length < 3) continue
      const contour = o.map((p) => new THREE.Vector2(p.x, p.y))
      const faces = THREE.ShapeUtils.triangulateShape(contour, [])
      const base = v
      for (const p of o) {
        mp[v * 3] = p.x
        mp[v * 3 + 1] = p.y
        mp[v * 3 + 2] = 0
        v++
      }
      if (i + faces.length * 3 > mi.length) break
      for (const f of faces) {
        mi[i++] = base + f[0]!
        mi[i++] = base + f[1]!
        mi[i++] = base + f[2]!
      }
    }
    mPos.needsUpdate = true
    mIdx.needsUpdate = true
    this.maskGeometry.setDrawRange(0, i)
    this.maskDirty = true

    // --- cut walls
    const capV = (this.wallGeometry.getAttribute('position') as THREE.BufferAttribute).count
    if (vTotal * 2 > capV) this.allocWalls(vTotal * 4, vTotal * 12)
    const wPos = this.wallGeometry.getAttribute('position') as THREE.BufferAttribute
    const wNor = this.wallGeometry.getAttribute('normal') as THREE.BufferAttribute
    const wDep = this.wallGeometry.getAttribute('aDepth') as THREE.BufferAttribute
    const wIdx = this.wallGeometry.getIndex()!
    const target: WallMeshData = this.wallData ?? {
      positions: wPos.array as Float32Array,
      depth: wDep.array as Float32Array,
      indices: wIdx.array as Uint32Array,
      vertexCount: 0,
      indexCount: 0,
    }
    this.wallData = buildCutWalls(this.shape, outlines, this.wallThickness, target)
    if (this.wallData.positions !== wPos.array) {
      // buffers were too small: fall back to fresh attributes
      this.wallGeometry.setAttribute('position', new THREE.BufferAttribute(this.wallData.positions, 3))
      this.wallGeometry.setAttribute('aDepth', new THREE.BufferAttribute(this.wallData.depth, 1))
      this.wallGeometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this.wallData.positions.length), 3))
      this.wallGeometry.setIndex(new THREE.BufferAttribute(this.wallData.indices, 1))
    }
    this.computeWallNormals()
    ;(this.wallGeometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true
    ;(this.wallGeometry.getAttribute('aDepth') as THREE.BufferAttribute).needsUpdate = true
    ;(this.wallGeometry.getAttribute('normal') as THREE.BufferAttribute).needsUpdate = true
    this.wallGeometry.getIndex()!.needsUpdate = true
    this.wallGeometry.setDrawRange(0, this.wallData.indexCount)
  }

  private computeWallNormals() {
    const data = this.wallData
    if (!data) return
    const nAttr = this.wallGeometry.getAttribute('normal') as THREE.BufferAttribute
    const n = nAttr.array as Float32Array
    const p = data.positions
    n.fill(0, 0, data.vertexCount * 3)
    for (let k = 0; k < data.indexCount; k += 3) {
      const a = data.indices[k]! * 3
      const b = data.indices[k + 1]! * 3
      const c = data.indices[k + 2]! * 3
      const e1x = p[b]! - p[a]!
      const e1y = p[b + 1]! - p[a + 1]!
      const e1z = p[b + 2]! - p[a + 2]!
      const e2x = p[c]! - p[a]!
      const e2y = p[c + 1]! - p[a + 1]!
      const e2z = p[c + 2]! - p[a + 2]!
      const nx = e1y * e2z - e1z * e2y
      const ny = e1z * e2x - e1x * e2z
      const nz = e1x * e2y - e1y * e2x
      for (const o of [a, b, c]) {
        n[o] = n[o]! + nx
        n[o + 1] = n[o + 1]! + ny
        n[o + 2] = n[o + 2]! + nz
      }
    }
    for (let k = 0; k < data.vertexCount; k++) {
      const x = n[k * 3]!
      const y = n[k * 3 + 1]!
      const z = n[k * 3 + 2]!
      const l = Math.hypot(x, y, z) || 1
      n[k * 3] = x / l
      n[k * 3 + 1] = y / l
      n[k * 3 + 2] = z / l
    }
  }

  /** Renders the carving mask if it changed. Call before rendering the main scene. */
  renderMask(renderer: THREE.WebGLRenderer): void {
    if (!this.maskDirty) return
    const prevTarget = renderer.getRenderTarget()
    const prevAutoClear = renderer.autoClear
    renderer.autoClear = true
    renderer.setRenderTarget(this.maskTarget)
    renderer.render(this.maskScene, this.maskCamera)
    renderer.setRenderTarget(prevTarget)
    renderer.autoClear = prevAutoClear
    this.maskDirty = false
  }

  /**
   * Shows / hides the pumpkin while keeping its candle in the scene (at zero
   * intensity), so the number of point lights — and therefore the compiled
   * shader variants — stays constant when people enter or leave the frame.
   */
  setVisible(visible: boolean): void {
    if (visible === this.shown) return
    this.shown = visible
    for (const child of this.group.children) if (child !== this.candle) child.visible = visible
    if (!visible) this.candle.intensity = 0
  }

  get visible(): boolean {
    return this.shown
  }

  /** Current glow level set by setGlow (before flicker). */
  get glow(): number {
    return this.glowLevel
  }

  /** glow: 0 = unlit, 1 = full candle; warmth 0..1 shifts orange -> golden. */
  setGlow(level: number, warmth = this.warmth): void {
    this.glowLevel = Math.max(0, level)
    this.warmth = warmth
  }

  setLidVisible(visible: number): void {
    this.uniforms.uLid.value = visible
  }

  /** Per-frame candle flicker. */
  update(timeSec: number): void {
    const t = timeSec
    const flicker =
      0.9 + 0.05 * Math.sin(t * 11.3) + 0.035 * Math.sin(t * 17.9 + 1.3) + 0.03 * Math.sin(t * 5.1 + 0.4) + 0.02 * Math.sin(t * 29.7)
    const g = this.shown ? this.glowLevel * flicker : 0
    this.uniforms.uGlow.value = g
    const w = this.warmth
    this.uniforms.uGlowColor.value.setRGB(1.0, 0.36 + 0.24 * w, 0.06 + 0.12 * w)
    this.candle.intensity = 2.6 * g
    this.candle.color.setRGB(1, 0.55 + 0.2 * w, 0.25)
    const flameVisible = Math.min(1, this.glowLevel)
    this.flame.visible = flameVisible > 0.02
    this.flame.scale.set(0.14 * (0.9 + 0.1 * flicker), 0.26 * (0.85 + 0.2 * flicker) * flameVisible, 1)
    ;(this.flame.material as THREE.SpriteMaterial).opacity = flameVisible
    if (this.halo) {
      ;(this.halo.material as THREE.SpriteMaterial).opacity = Math.min(1, this.glowLevel) * (0.85 + 0.15 * flicker)
    }
  }

  dispose(): void {
    this.shellGeometry.dispose()
    this.stemGeometry.dispose()
    this.wallGeometry.dispose()
    this.maskGeometry.dispose()
    for (const m of this.materials) m.dispose()
    for (const t of this.ownedTextures) t.dispose()
    this.maskTarget.dispose()
    this.group.clear()
  }
}
