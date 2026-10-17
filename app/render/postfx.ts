// Post-processing chain: scene passes -> bloom (HDR threshold) -> vignette /
// grain -> output (tone mapping + sRGB). Shared by LIVE and CARVE so the
// on-screen look and the exported PNG are produced by the same pipeline.
import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'

const GradeShader = {
  name: 'PumpkinGrade',
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uVignette: { value: 0.35 },
    uGrain: { value: 0.025 },
    uTime: { value: 0 },
    uResolution: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uVignette;
    uniform float uGrain;
    uniform float uTime;
    uniform vec2 uResolution;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      vec2 d = vUv - 0.5;
      d.x *= uResolution.x / uResolution.y;
      float vig = smoothstep(1.0, 0.2, length(d) * 1.15);
      c.rgb *= mix(1.0, vig, uVignette);
      float n = hash(floor(vUv * uResolution) + fract(uTime) * 61.0) - 0.5;
      c.rgb += n * uGrain * (0.25 + c.rgb);
      gl_FragColor = c;
    }`,
}

export interface ScenePass {
  scene: THREE.Scene
  camera: THREE.Camera
}

export interface PostFxOptions {
  bloom: boolean
  bloomStrength: number
  bloomRadius: number
  bloomThreshold: number
  samples: number
  vignette: number
  grain: number
}

export class PostFx {
  readonly composer: EffectComposer
  readonly bloom: UnrealBloomPass
  private grade: ShaderPass
  private renderPasses: RenderPass[] = []
  private target: THREE.WebGLRenderTarget

  constructor(
    private renderer: THREE.WebGLRenderer,
    passes: ScenePass[],
    opts: PostFxOptions,
  ) {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2())
    this.target = new THREE.WebGLRenderTarget(Math.max(1, size.x), Math.max(1, size.y), {
      type: THREE.HalfFloatType,
      samples: opts.samples,
    })
    this.composer = new EffectComposer(renderer, this.target)
    passes.forEach((p, i) => {
      const rp = new RenderPass(p.scene, p.camera)
      if (i > 0) {
        rp.clear = false
        rp.clearDepth = true
      }
      this.renderPasses.push(rp)
      this.composer.addPass(rp)
    })
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), opts.bloomStrength, opts.bloomRadius, opts.bloomThreshold)
    this.bloom.enabled = opts.bloom
    this.composer.addPass(this.bloom)
    this.grade = new ShaderPass(GradeShader)
    this.grade.uniforms.uVignette!.value = opts.vignette
    this.grade.uniforms.uGrain!.value = opts.grain
    this.composer.addPass(this.grade)
    this.composer.addPass(new OutputPass())
  }

  setSize(width: number, height: number, pixelRatio: number): void {
    this.composer.setPixelRatio(pixelRatio)
    this.composer.setSize(width, height)
    this.grade.uniforms.uResolution!.value.set(width * pixelRatio, height * pixelRatio)
  }

  setBloom(enabled: boolean, strength?: number): void {
    this.bloom.enabled = enabled
    if (strength !== undefined) this.bloom.strength = strength
  }

  render(timeSec: number): void {
    this.grade.uniforms.uTime!.value = timeSec
    this.composer.render()
  }

  dispose(): void {
    this.bloom.dispose()
    this.grade.dispose()
    for (const p of this.renderPasses) p.dispose()
    this.composer.dispose()
    this.target.dispose()
  }
}

/** Creates a WebGL renderer or throws a typed error the UI can show. */
export function createRenderer(canvas: HTMLCanvasElement, toneMapping: THREE.ToneMapping): THREE.WebGLRenderer {
  let renderer: THREE.WebGLRenderer
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
      stencil: false,
    })
  } catch (e) {
    throw new WebGLUnavailableError(e instanceof Error ? e.message : String(e))
  }
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = toneMapping
  renderer.toneMappingExposure = 1
  return renderer
}

export class WebGLUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WebGLUnavailableError'
  }
}

/** Synchronously copies the current WebGL drawing buffer into a 2D canvas (must run in the same task as the render). */
export function snapshotCanvas(source: HTMLCanvasElement, width: number, height: number): HTMLCanvasElement {
  const out = document.createElement('canvas')
  out.width = width
  out.height = height
  const ctx = out.getContext('2d')
  if (!ctx) throw new Error('2D canvas unavailable')
  ctx.drawImage(source, 0, 0, width, height)
  return out
}
