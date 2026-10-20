// MediaPipe selfie segmentation (person vs background) for the LIVE Halloween
// backdrop: objects are drawn between the real background and the people.
// Runs entirely in the browser; only the model file (~250 KB) is fetched from
// Google's official MediaPipe model storage — already allowed by the
// production CSP; frames never leave the device. Optional: if it cannot load, LIVE still works and the
// backdrop is drawn without person occlusion.
import type { ImageSegmenter } from '@mediapipe/tasks-vision'
import { useRuntimeConfig } from '#imports'

const MEDIAPIPE_VERSION = '1.1.1'
const CDN_WASM = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`
const CDN_MODEL = 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite'

export interface PersonMask {
  data: Float32Array
  width: number
  height: number
}

interface State {
  promise: Promise<ImageSegmenter> | null
  instance: ImageSegmenter | null
  failed: boolean
  lastTimestamp: number
}

const state: State = { promise: null, instance: null, failed: false, lastTimestamp: 0 }

async function create(baseURL: string): Promise<ImageSegmenter> {
  const { FilesetResolver, ImageSegmenter } = await import('@mediapipe/tasks-vision')
  const base = baseURL.endsWith('/') ? baseURL : `${baseURL}/`
  const sources = [
    { wasm: `${base}mediapipe/wasm`, model: CDN_MODEL },
    { wasm: CDN_WASM, model: CDN_MODEL },
  ]
  let lastError: unknown = null
  for (const src of sources) {
    let fileset
    try {
      fileset = await FilesetResolver.forVisionTasks(src.wasm)
    } catch (e) {
      lastError = e
      continue
    }
    for (const delegate of ['GPU', 'CPU'] as const) {
      try {
        return await ImageSegmenter.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: src.model, delegate },
          runningMode: 'VIDEO',
          outputConfidenceMasks: true,
          outputCategoryMask: false,
        })
      } catch (e) {
        lastError = e
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Image segmenter failed to load')
}

export function useSegmentation() {
  const config = useRuntimeConfig()

  /** Starts loading once; resolves to null when segmentation is unavailable. */
  async function load(): Promise<ImageSegmenter | null> {
    if (state.instance) return state.instance
    if (state.failed) return null
    state.promise ??= create(config.app.baseURL)
    try {
      state.instance = await state.promise
      return state.instance
    } catch (e) {
      console.warn('[kabochau] person segmentation unavailable; backdrop drawn without occlusion', e)
      state.failed = true
      state.promise = null
      return null
    }
  }

  /** Person-probability mask of the current frame (unmirrored source orientation), or null. */
  function segment(video: HTMLVideoElement, nowMs: number): PersonMask | null {
    const seg = state.instance
    if (!seg) return null
    const ts = Math.max(nowMs, state.lastTimestamp + 1)
    state.lastTimestamp = ts
    let out: PersonMask | null = null
    seg.segmentForVideo(video, ts, (result) => {
      const mask = result.confidenceMasks?.[0]
      if (mask) out = { data: mask.getAsFloat32Array().slice(), width: mask.width, height: mask.height }
    })
    return out
  }

  return { load, segment }
}
