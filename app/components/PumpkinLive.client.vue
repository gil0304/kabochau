<script setup lang="ts">
// Camera + tracking loop. One requestAnimationFrame loop: at most one
// inference per new video frame (adaptively throttled by measured inference
// cost), rendering every frame with interpolation between detections.
// Several people are tracked at once (FaceTrackMatcher keeps identities); each
// gets their own pumpkin in LIVE and their own carving input for MAKE.
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { LiveCompositor, type CaptureResult, type LiveMode } from '~/render/liveCompositor'
import type { QualityTier } from '~/render/quality'
import { WebGLUnavailableError } from '~/render/postfx'
import { useFaceTracking } from '~/composables/useFaceTracking'
import { useSegmentation } from '~/composables/useSegmentation'
import { averageParams, landmarksToParams, type PumpkinFaceParams } from '~/utils/faceMapping'
import { blendshapesToMap, deriveExpression, type ExpressionState } from '~/utils/expressionMapping'
import { FaceTrackMatcher, detectionFromLandmarks, type CarveFaceInput, type FaceDetection } from '~/utils/faceTracks'

export type TrackingStatus = 'searching' | 'ok' | 'none'
export interface FaceCount {
  /** people wearing a pumpkin */
  tracked: number
  /** faces the detector saw (may exceed the tier limit) */
  detected: number
}

const props = defineProps<{
  video: HTMLVideoElement | null
  mode: LiveMode
  /** false pauses inference + rendering (e.g. while a result is shown) */
  active: boolean
  tier: QualityTier
}>()
const emit = defineEmits<{
  status: [TrackingStatus]
  faces: [FaceCount]
  error: ['webgl-unavailable' | 'webgl-lost']
}>()

const MIRRORED = true
const canvas = ref<HTMLCanvasElement | null>(null)
const tracking = useFaceTracking()
const segmentation = useSegmentation()
// person segmentation for the Halloween backdrop (skipped on low-end devices)
const SEGMENT_INTERVAL_MS = 100
let segmentReady = false
let lastSegment = 0
let compositor: LiveCompositor | null = null
// the tier is fixed for the lifetime of this component (and of the compositor's pumpkin pool)
const matcher = new FaceTrackMatcher({ maxTracks: props.tier.maxFaces })
let raf = 0
let resizeObserver: ResizeObserver | null = null
let lastVideoTime = -1
let lastInfer = 0
let inferInterval = 0
let failures = 0
let noFaceSince: number | null = null
let status: TrackingStatus = 'searching'
let count: FaceCount = { tracked: 0, detected: 0 }
interface Sample {
  params: PumpkinFaceParams
  expression: ExpressionState
  /** display-space x (mirrored), for left-to-right ordering in MAKE */
  x: number
  t: number
}
const histories = new Map<number, Sample[]>()

function setStatus(s: TrackingStatus) {
  if (s !== status) {
    status = s
    emit('status', s)
  }
}

function setCount(tracked: number, detected: number) {
  if (tracked !== count.tracked || detected !== count.detected) {
    count = { tracked, detected }
    emit('faces', count)
  }
}

function infer(now: number) {
  const v = props.video
  if (!v || !compositor || v.readyState < 2 || v.videoWidth === 0) return
  if (v.currentTime === lastVideoTime || now - lastInfer < inferInterval) return
  lastVideoTime = v.currentTime
  lastInfer = now
  const t0 = performance.now()
  let res
  try {
    res = tracking.detectVideo(v, now)
  } catch {
    if (++failures === 3) void tracking.fallbackToCpu()
    return
  }
  if (!res) return
  failures = 0
  inferInterval = Math.min(90, (performance.now() - t0) * 1.25)
  const vw = v.videoWidth
  const vh = v.videoHeight
  const faces = res.faceLandmarks ?? []
  const detections = faces
    .map((f, i) => detectionFromLandmarks(f, i, vw, vh, MIRRORED))
    .filter((d): d is FaceDetection => d !== null)
  const time = now / 1000
  const assignments = matcher.update(detections, time)
  if (assignments.length === 0) {
    noFaceSince ??= now
    if (now - noFaceSince > 350) {
      setStatus('none')
      setCount(0, 0)
    }
    return
  }
  noFaceSince = null
  compositor.setFaces(
    assignments.map(({ id, index }) => ({
      id,
      observation: {
        landmarks: faces[index]!,
        blendshapes: blendshapesToMap(res.faceBlendshapes?.[index]?.categories),
        imageWidth: vw,
        imageHeight: vh,
        time,
      },
    })),
  )
  for (const { id, index } of assignments) {
    const params = landmarksToParams(faces[index]!, vw, vh, MIRRORED)
    if (!params) continue
    const det = detections.find((d) => d.index === index)
    const list = histories.get(id) ?? []
    list.push({
      params,
      expression: deriveExpression(params, blendshapesToMap(res.faceBlendshapes?.[index]?.categories)),
      x: det?.x ?? 0,
      t: now,
    })
    while (list.length > 8 || (list.length > 0 && now - list[0]!.t > 700)) list.shift()
    histories.set(id, list)
  }
  const active = new Set(matcher.activeIds)
  for (const id of histories.keys()) if (!active.has(id)) histories.delete(id)
  setStatus('ok')
  setCount(Math.min(assignments.length, compositor.capacity), detections.length)
}

function segment(now: number) {
  const v = props.video
  if (!segmentReady || !compositor || props.mode !== 'live' || !v || v.readyState < 2) return
  if (now - lastSegment < SEGMENT_INTERVAL_MS) return
  lastSegment = now
  try {
    const mask = segmentation.segment(v, now)
    if (mask) compositor.setPersonMask(mask.data, mask.width, mask.height, now / 1000)
  } catch (e) {
    console.warn('[kabochau] segmentation failed; continuing without occlusion', e)
    segmentReady = false
  }
}

function loop(now: number) {
  raf = requestAnimationFrame(loop)
  if (!props.active || document.hidden || !compositor) return
  infer(now)
  segment(now)
  compositor.frame(now)
}

function onContextLost(e: Event) {
  e.preventDefault()
  emit('error', 'webgl-lost')
}

onMounted(() => {
  const el = canvas.value
  if (!el || !props.video) return
  try {
    compositor = new LiveCompositor(el, props.video, props.tier)
  } catch (e) {
    if (!(e instanceof WebGLUnavailableError)) console.error('[pumpkin-me] LIVE renderer init failed', e)
    emit('error', 'webgl-unavailable')
    return
  }
  compositor.setMode(props.mode)
  el.addEventListener('webglcontextlost', onContextLost)
  const parent = el.parentElement ?? el
  const applySize = () => {
    const r = parent.getBoundingClientRect()
    compositor?.resize(r.width, r.height)
  }
  applySize()
  resizeObserver = new ResizeObserver(applySize)
  resizeObserver.observe(parent)
  emit('status', status)
  raf = requestAnimationFrame(loop)
  if (props.tier.name !== 'low') {
    // after the face model, so it never delays the first pumpkin
    void tracking
      .load()
      .catch(() => undefined)
      .then(() => segmentation.load())
      .then((seg) => (segmentReady = !!seg && !!compositor))
  }
})

watch(
  () => props.mode,
  (m) => compositor?.setMode(m),
)

watch(
  () => props.active,
  (a) => {
    if (a) {
      histories.clear()
      matcher.reset()
      compositor?.resetTracking()
      setStatus('searching')
      setCount(0, 0)
    }
  },
)

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  resizeObserver?.disconnect()
  canvas.value?.removeEventListener('webglcontextlost', onContextLost)
  compositor?.dispose()
  compositor = null
})

defineExpose({
  hasFace: () => !!compositor?.hasFace && status !== 'none',
  async capture(): Promise<CaptureResult> {
    if (!compositor) throw new Error('compositor unavailable')
    return compositor.capture()
  },
  /**
   * Averaged recent measurements of every tracked person for MAKE, ordered
   * left to right as seen in the (mirrored) preview. Empty when nobody is tracked.
   */
  snapshot(): CarveFaceInput[] {
    if (!compositor?.hasFace) return []
    const now = performance.now()
    const people: Array<CarveFaceInput & { x: number }> = []
    for (const list of histories.values()) {
      const recent = list.filter((h) => now - h.t < 600)
      const params = averageParams(recent.map((h) => h.params))
      if (!params || recent.length === 0) continue
      const x = recent.reduce((sum, h) => sum + h.x, 0) / recent.length
      people.push({ params, expression: recent[recent.length - 1]!.expression, x })
    }
    return people
      .sort((a, b) => a.x - b.x)
      .slice(0, props.tier.maxFaces)
      .map(({ params, expression }) => ({ params, expression }))
  },
})
</script>

<template>
  <canvas ref="canvas" class="stage-canvas" role="img" aria-label="カメラ映像とカボチャのプレビュー" />
</template>
