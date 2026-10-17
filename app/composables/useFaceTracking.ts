// MediaPipe Face Landmarker: loaded once per page, GPU delegate with CPU
// fallback, locally packaged WASM + model with the official CDN as a
// fallback for asset loading only. All inference runs in the browser; no
// image or landmark data ever leaves the device.
import type { Category, FaceLandmarker, FaceLandmarkerResult } from '@mediapipe/tasks-vision'
import { ref } from 'vue'
import { useRuntimeConfig } from '#imports'
import { MAX_FACES } from '~/utils/faceTracks'
import { mapTileLandmarks, mergeFaceCandidates, photoTiles, type FaceCandidate } from '~/utils/photoTiles'

export type PhotoFace = FaceCandidate<Category[] | undefined>

const MEDIAPIPE_VERSION = '1.1.1'
const CDN_WASM = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`
const CDN_MODEL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'

type RunningMode = 'VIDEO' | 'IMAGE'

interface TrackerState {
  promise: Promise<FaceLandmarker> | null
  instance: FaceLandmarker | null
  mode: RunningMode
  lastTimestamp: number
  delegate: 'GPU' | 'CPU'
  busy: boolean
}

const tracker: TrackerState = { promise: null, instance: null, mode: 'VIDEO', lastTimestamp: 0, delegate: 'GPU', busy: false }

async function createLandmarker(baseURL: string, preferCpu: boolean): Promise<FaceLandmarker> {
  const { FaceLandmarker, FilesetResolver } = await import('@mediapipe/tasks-vision')
  const base = baseURL.endsWith('/') ? baseURL : `${baseURL}/`
  const sources = [
    { wasm: `${base}mediapipe/wasm`, model: `${base}models/face_landmarker.task` },
    { wasm: CDN_WASM, model: CDN_MODEL },
  ]
  const delegates: Array<'GPU' | 'CPU'> = preferCpu ? ['CPU'] : ['GPU', 'CPU']
  let lastError: unknown = null
  for (const src of sources) {
    let fileset
    try {
      fileset = await FilesetResolver.forVisionTasks(src.wasm)
    } catch (e) {
      lastError = e
      continue
    }
    for (const delegate of delegates) {
      try {
        const lm = await FaceLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: src.model, delegate },
          runningMode: 'VIDEO',
          numFaces: MAX_FACES,
          minFaceDetectionConfidence: 0.5,
          minFacePresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
          outputFaceBlendshapes: true,
          outputFacialTransformationMatrixes: false,
        })
        tracker.delegate = delegate
        tracker.mode = 'VIDEO'
        return lm
      } catch (e) {
        lastError = e
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Face Landmarker failed to load')
}

export function useFaceTracking() {
  const config = useRuntimeConfig()
  const status = ref<'idle' | 'loading' | 'ready' | 'error'>(tracker.instance ? 'ready' : 'idle')

  async function load(preferCpu = false): Promise<FaceLandmarker> {
    if (tracker.instance) {
      status.value = 'ready'
      return tracker.instance
    }
    status.value = 'loading'
    if (!tracker.promise) {
      tracker.promise = createLandmarker(config.app.baseURL, preferCpu).then(
        (lm) => {
          tracker.instance = lm
          return lm
        },
        (e) => {
          tracker.promise = null
          throw e
        },
      )
    }
    try {
      const lm = await tracker.promise
      status.value = 'ready'
      return lm
    } catch (e) {
      status.value = 'error'
      throw e
    }
  }

  async function ensureMode(mode: RunningMode): Promise<FaceLandmarker | null> {
    const lm = tracker.instance
    if (!lm) return null
    if (tracker.mode !== mode) {
      await lm.setOptions({ runningMode: mode })
      tracker.mode = mode
    }
    return lm
  }

  /** Synchronous per-frame detection (VIDEO mode). Returns null while busy / switching modes. */
  function detectVideo(video: HTMLVideoElement, nowMs: number): FaceLandmarkerResult | null {
    const lm = tracker.instance
    if (!lm || tracker.busy || tracker.mode !== 'VIDEO') return null
    const ts = Math.max(nowMs, tracker.lastTimestamp + 1)
    tracker.lastTimestamp = ts
    return lm.detectForVideo(video, ts)
  }

  /**
   * Still-image detection for photos (pauses video inference while running).
   * When the whole image yields fewer than `maxFaces` faces, overlapping tiles
   * are searched too (small faces in group photos) and merged back.
   */
  async function detectPhotoFaces(image: HTMLCanvasElement, maxFaces: number): Promise<PhotoFace[]> {
    const lm = await load()
    tracker.busy = true
    try {
      await ensureMode('IMAGE')
      const W = image.width
      const H = image.height
      const whole = { x: 0, y: 0, w: 1, h: 1 }
      const full = lm.detect(image)
      const candidates: PhotoFace[] = (full.faceLandmarks ?? []).map((landmarks, i) => ({
        landmarks,
        blendshapes: full.faceBlendshapes?.[i]?.categories,
        full: true,
        tile: whole,
      }))
      if (candidates.length < maxFaces) {
        const tileCanvas = document.createElement('canvas')
        const ctx = tileCanvas.getContext('2d')
        if (ctx) {
          for (const t of photoTiles(W, H)) {
            const sx = Math.round(t.x * W)
            const sy = Math.round(t.y * H)
            const sw = Math.max(1, Math.round(t.w * W))
            const sh = Math.max(1, Math.round(t.h * H))
            tileCanvas.width = sw
            tileCanvas.height = sh
            ctx.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh)
            const r = lm.detect(tileCanvas)
            const tile = { x: sx / W, y: sy / H, w: sw / W, h: sh / H }
            r.faceLandmarks?.forEach((landmarks, i) =>
              candidates.push({ landmarks: mapTileLandmarks(landmarks, tile), blendshapes: r.faceBlendshapes?.[i]?.categories, full: false, tile }),
            )
          }
        }
        // release the tile pixels right away
        tileCanvas.width = tileCanvas.height = 0
      }
      return mergeFaceCandidates(candidates, W, H)
    } finally {
      try {
        await ensureMode('VIDEO')
      } finally {
        tracker.busy = false
      }
    }
  }

  /** Recreates the landmarker on the CPU delegate (used if the GPU path throws at runtime). */
  async function fallbackToCpu(): Promise<FaceLandmarker | null> {
    if (tracker.delegate === 'CPU') return tracker.instance
    try {
      tracker.instance?.close()
    } catch {
      /* already closed */
    }
    tracker.instance = null
    tracker.promise = null
    return load(true)
  }

  return { status, load, detectVideo, detectPhotoFaces, fallbackToCpu }
}
