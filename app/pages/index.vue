<script setup lang="ts">
// Single-screen state machine:
//   idle -> starting (permission + model) -> tracking -> (LIVE) result
//                                                    -> (MAKE) carving -> result
//   Up to tier.maxFaces people at once: one pumpkin per person in both modes.
//   photo upload -> processing -> carving -> result
//   errors: camera denied / unavailable / busy / insecure, model load,
//           WebGL unavailable / lost, export failed, no face in photo.
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import CameraView from '~/components/CameraView.vue'
import type { AppMode } from '~/components/ModeSwitch.vue'
import { useCamera } from '~/composables/useCamera'
import { useFaceTracking } from '~/composables/useFaceTracking'
import { useCapture } from '~/composables/useCapture'
import { useStickers } from '~/composables/useStickers'
import { detectQualityTier, type QualityTier } from '~/render/quality'
import type { CaptureResult } from '~/render/liveCompositor'
import { landmarksToParams } from '~/utils/faceMapping'
import { blendshapesToMap, deriveExpression } from '~/utils/expressionMapping'
import { detectionFromLandmarks, type CarveFaceInput, type FaceDetection } from '~/utils/faceTracks'
import { exportFileName } from '~/utils/imageExport'
import { PhotoLoadError, loadPhoto } from '~/utils/photo'
import { composeStickers } from '~/render/stickerCanvas'

type TrackingStatus = 'searching' | 'ok' | 'none'
type Phase = 'idle' | 'starting' | 'tracking' | 'processing' | 'carving' | 'result' | 'error'
type ErrorKind =
  | 'camera-denied'
  | 'camera-unavailable'
  | 'camera-busy'
  | 'insecure'
  | 'model-load-failed'
  | 'webgl-unavailable'
  | 'webgl-lost'

interface LiveHandle {
  hasFace(): boolean
  capture(): Promise<CaptureResult>
  snapshot(): CarveFaceInput[]
}
interface CarveHandle {
  skip(): void
  capture(): Promise<CaptureResult>
}
interface ResultState extends CaptureResult {
  url: string
  mode: AppMode
  name: string
}

const mode = ref<AppMode>('live')
const phase = ref<Phase>('idle')
const errorKind = ref<ErrorKind | null>(null)
const trackingStatus = ref<TrackingStatus>('searching')
const toast = ref<string | null>(null)
const busy = ref(false)
const flash = ref(false)
const tier = shallowRef<QualityTier | null>(null)
const cameraView = ref<InstanceType<typeof CameraView> | null>(null)
const live = ref<LiveHandle | null>(null)
const carve = ref<CarveHandle | null>(null)
const photoInput = ref<HTMLInputElement | null>(null)
const carveInput = shallowRef<{ faces: CarveFaceInput[]; source: 'camera' | 'photo' } | null>(null)
/** people wearing a pumpkin / faces seen by the detector (LIVE + MAKE preview) */
const faceCount = ref({ tracked: 0, detected: 0 })
const showMultiHint = ref(false)
const result = shallowRef<ResultState | null>(null)
const canShareResult = ref(false)
const showLiveHint = ref(true)
const decorating = ref(false)

const camera = useCamera()
const tracker = useFaceTracking()
const capture = useCapture()
const stickers = useStickers()

const cameraActive = computed(() => camera.state.value === 'active' || camera.state.value === 'ended')
const videoEl = computed(() => cameraView.value?.video ?? null)
const liveActive = computed(() => phase.value === 'tracking')
const showStage = computed(() => cameraActive.value && !!tier.value)
const maxFaces = computed(() => tier.value?.maxFaces ?? 1)
const showIntro = computed(() => phase.value === 'idle' || (phase.value === 'starting' && !cameraActive.value))
// LIVE always previews the exported PNG; MAKE switches from the 3D stage to
// the PNG once stamps come into play, so what is decorated is what is saved.
const resultImageUrl = computed(() => {
  const r = result.value
  if (!r) return null
  return r.mode === 'live' || decorating.value || stickers.items.value.length > 0 ? r.url : null
})

let toastTimer: ReturnType<typeof setTimeout> | undefined
function showToast(text: string, ms = 3200) {
  toast.value = text
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (toast.value = null), ms)
}

const hint = computed<{ text: string | null; tone: 'info' | 'warn' }>(() => {
  if (toast.value) return { text: toast.value, tone: 'warn' }
  switch (phase.value) {
    case 'starting':
      return {
        text: camera.state.value === 'requesting' ? 'カメラの使用を許可してください' : '顔認識を準備しています…',
        tone: 'info',
      }
    case 'processing':
      return { text: '写真を解析しています…', tone: 'info' }
    case 'tracking':
      if (trackingStatus.value === 'none' || trackingStatus.value === 'searching')
        return { text: '顔を画面の中央に入れて、少し近づいてください', tone: 'warn' }
      if (faceCount.value.detected > maxFaces.value)
        return { text: `一度に${maxFaces.value}人まで（大きく映っている人を優先）`, tone: 'warn' }
      if (mode.value === 'carve')
        return {
          text:
            faceCount.value.tracked > 1
              ? `ボタンで${faceCount.value.tracked}人それぞれのカボチャをつくります`
              : '正面を向いてボタンをタップ',
          tone: 'info',
        }
      if (showMultiHint.value && faceCount.value.tracked > 1)
        return { text: `${faceCount.value.tracked}人をカボチャに変身中`, tone: 'info' }
      return { text: showLiveHint.value ? '笑う・まばたき・口を開けるとカボチャも動きます' : null, tone: 'info' }
    case 'carving': {
      const n = carveInput.value?.faces.length ?? 1
      return { text: n > 1 ? `${n}人の顔を彫っています…（タップでスキップ）` : 'あなたの顔を彫っています…（タップでスキップ）', tone: 'info' }
    }
    case 'result':
      if (decorating.value)
        return {
          text: stickers.items.value.length ? 'ドラッグで移動・2本指や角のつまみで拡大/回転' : '下のスタンプをタップして追加',
          tone: 'info',
        }
      return {
        text: result.value?.mode === 'carve' && !resultImageUrl.value ? 'ドラッグで回転できます' : null,
        tone: 'info',
      }
    default:
      return { text: null, tone: 'info' }
  }
})

const errorCopy = computed(() => {
  switch (errorKind.value) {
    case 'camera-denied':
      return {
        title: 'カメラが許可されていません',
        body: 'ブラウザのサイト設定でカメラを許可して再試行するか、写真から作成できます。',
        retry: true,
        photo: true,
      }
    case 'camera-unavailable':
      return { title: 'カメラが見つかりません', body: 'カメラを接続して再試行するか、写真から作成できます。', retry: true, photo: true }
    case 'camera-busy':
      return { title: 'カメラを使用できません', body: '他のアプリやタブがカメラを使用中の可能性があります。閉じてから再試行してください。', retry: true, photo: true }
    case 'insecure':
      return { title: 'HTTPS接続が必要です', body: 'カメラはHTTPS（またはlocalhost）でのみ利用できます。写真からは作成できます。', retry: false, photo: true }
    case 'model-load-failed':
      return { title: '顔認識を読み込めませんでした', body: '通信環境を確認して再試行してください。', retry: true, photo: false }
    case 'webgl-unavailable':
      return { title: '3D表示を利用できません', body: 'このブラウザ / 端末ではWebGLが無効です。別のブラウザでお試しください。', retry: false, reload: true, photo: false }
    case 'webgl-lost':
      return { title: '3D表示がリセットされました', body: '端末のメモリ不足などでグラフィックスが停止しました。再読み込みしてください。', retry: false, reload: true, photo: false }
    default:
      return null
  }
})

function fail(kind: ErrorKind) {
  errorKind.value = kind
  phase.value = 'error'
}

async function startCamera() {
  const video = videoEl.value
  if (!video) return
  errorKind.value = null
  phase.value = 'starting'
  const model = tracker.load().then(
    () => true,
    () => false,
  )
  const ok = await camera.start(video)
  if (!ok) {
    const map: Record<string, ErrorKind> = {
      denied: 'camera-denied',
      busy: 'camera-busy',
      insecure: 'insecure',
    }
    fail(map[camera.state.value] ?? 'camera-unavailable')
    return
  }
  if (!(await model)) {
    fail('model-load-failed')
    return
  }
  trackingStatus.value = 'searching'
  phase.value = 'tracking'
  showLiveHint.value = true
  setTimeout(() => (showLiveHint.value = false), 6000)
}

// Stamped PNG cache. Composited shortly after each edit so that "share" can
// call navigator.share() while the tap's user activation is still valid.
let composed: { key: string; blob: Blob } | null = null
let composing: { key: string; promise: Promise<Blob> } | null = null

function revokeResult() {
  if (result.value) URL.revokeObjectURL(result.value.url)
  result.value = null
  stickers.clear()
  decorating.value = false
  composed = null
}

async function outputBlob(r: ResultState): Promise<Blob> {
  const list = stickers.items.value
  if (list.length === 0) return r.blob
  const key = `${r.url}|${stickers.signature.value}`
  if (composed?.key === key) return composed.blob
  if (composing?.key === key) return composing.promise
  const promise = composeStickers(r.blob, r.width, r.height, list)
  composing = { key, promise }
  try {
    const blob = await promise
    composed = { key, blob }
    return blob
  } finally {
    if (composing?.key === key) composing = null
  }
}

let composeTimer: ReturnType<typeof setTimeout> | undefined
watch(
  () => stickers.signature.value,
  () => {
    clearTimeout(composeTimer)
    const r = result.value
    if (!r || stickers.items.value.length === 0) return
    composeTimer = setTimeout(() => {
      if (result.value === r) outputBlob(r).catch((e) => console.error('[pumpkin-me] stamp compositing failed', e))
    }, 400)
  },
)

function setResult(r: CaptureResult, m: AppMode) {
  revokeResult()
  const name = exportFileName(m)
  result.value = { ...r, url: URL.createObjectURL(r.blob), mode: m, name }
  canShareResult.value = capture.canShare(r.blob, name)
}

function triggerFlash() {
  flash.value = false
  requestAnimationFrame(() => (flash.value = true))
  setTimeout(() => (flash.value = false), 450)
}

async function onCapture() {
  if (busy.value || phase.value !== 'tracking' || !live.value) return
  if (!live.value.hasFace()) {
    showToast('顔が見つかりません。カメラに顔を向けてください')
    return
  }
  if (mode.value === 'live') {
    busy.value = true
    triggerFlash()
    try {
      const r = await live.value.capture()
      setResult(r, 'live')
      phase.value = 'result'
    } catch (e) {
      console.error('[pumpkin-me] LIVE export failed', e)
      showToast('画像の書き出しに失敗しました。もう一度お試しください')
    } finally {
      busy.value = false
    }
    return
  }
  const faces = live.value.snapshot()
  if (faces.length === 0) {
    showToast('顔が安定して検出できません。正面を向いてもう一度')
    return
  }
  triggerFlash()
  carveInput.value = { faces, source: 'camera' }
  phase.value = 'carving'
}

async function onCarveReady() {
  if (!carve.value) return
  busy.value = true
  try {
    const r = await carve.value.capture()
    setResult(r, 'carve')
  } catch (e) {
    console.error('[pumpkin-me] CARVE export failed', e)
    showToast('画像の書き出しに失敗しました。保存をもう一度押してください')
  } finally {
    busy.value = false
    phase.value = 'result'
  }
}

async function ensureResultBlob(): Promise<ResultState | null> {
  if (result.value) return result.value
  if (carve.value && carveInput.value) {
    try {
      setResult(await carve.value.capture(), 'carve')
    } catch (e) {
      console.error('[pumpkin-me] export failed', e)
      showToast('画像の書き出しに失敗しました')
      return null
    }
  }
  return result.value
}

async function onSave() {
  const r = await ensureResultBlob()
  if (!r) return
  let blob: Blob
  busy.value = true
  try {
    blob = await outputBlob(r)
  } catch (e) {
    console.error('[pumpkin-me] stamp compositing failed', e)
    showToast('スタンプの合成に失敗しました。もう一度お試しください')
    return
  } finally {
    busy.value = false
  }
  try {
    capture.download(blob, r.name)
    showToast(r.fallback ? `保存しました（端末性能のため ${r.width}×${r.height}）` : '保存しました', 2400)
  } catch {
    showToast('保存に失敗しました。画像を長押しして保存してください')
  }
}

async function onShare() {
  const r = result.value
  if (!r) return
  let blob: Blob
  try {
    blob = await outputBlob(r)
  } catch (e) {
    console.error('[pumpkin-me] stamp compositing failed', e)
    showToast('スタンプの合成に失敗しました。もう一度お試しください')
    return
  }
  const outcome = await capture.share(blob, r.name)
  if (outcome === 'failed' || outcome === 'unsupported') showToast('共有できませんでした。保存をお使いください')
}

async function startDecorating() {
  const r = await ensureResultBlob()
  if (!r) return
  decorating.value = true
}

function finishDecorating() {
  decorating.value = false
  stickers.selectedId.value = null
}

function onRetake() {
  revokeResult()
  carveInput.value = null
  if (cameraActive.value) {
    if (camera.state.value === 'ended') void startCamera()
    else phase.value = 'tracking'
  } else {
    phase.value = 'idle'
  }
}

function pickPhoto() {
  photoInput.value?.click()
}

async function onPhotoSelected(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  const previous = phase.value
  phase.value = 'processing'
  busy.value = true
  try {
    await tracker.load()
    const image = await loadPhoto(file)
    const faces = await tracker.detectPhotoFaces(image, maxFaces.value)
    if (faces.length === 0) {
      image.width = image.height = 0
      phase.value = previous === 'error' ? 'error' : cameraActive.value ? 'tracking' : 'idle'
      showToast('写真から顔が見つかりませんでした。正面を向いた明るい写真を選んでください', 4500)
      return
    }
    // everyone in the photo (largest faces first if over the limit), then left to right;
    // photos are shown un-mirrored, so params use the photo's own left/right
    const people = faces
      .map((f, i) => detectionFromLandmarks(f.landmarks, i, image.width, image.height, false))
      .filter((d): d is FaceDetection => d !== null)
      .sort((a, b) => b.size - a.size)
      .slice(0, maxFaces.value)
      .sort((a, b) => a.x - b.x)
    const carveFaces: CarveFaceInput[] = []
    for (const d of people) {
      const face = faces[d.index]!
      const params = landmarksToParams(face.landmarks, image.width, image.height, false)
      if (!params) continue
      const blend = blendshapesToMap(face.blendshapes)
      carveFaces.push({ params, expression: deriveExpression(params, blend) })
    }
    // release the photo pixels right away — only parameters are kept
    image.width = image.height = 0
    if (carveFaces.length === 0) throw new Error('unusable landmarks')
    if (faces.length > carveFaces.length)
      showToast(`写真の${faces.length}人のうち、大きく写っている${carveFaces.length}人でつくります`, 4000)
    errorKind.value = null
    mode.value = 'carve'
    carveInput.value = { faces: carveFaces, source: 'photo' }
    phase.value = 'carving'
  } catch (err) {
    console.error('[pumpkin-me] photo processing failed', err)
    if (tracker.status.value === 'error') fail('model-load-failed')
    else {
      phase.value = previous === 'processing' ? 'idle' : previous
      showToast(err instanceof PhotoLoadError ? 'この画像は読み込めませんでした（JPEG / PNG をお試しください）' : '写真の解析に失敗しました')
    }
  } finally {
    busy.value = false
  }
}

function onStageError(kind: 'webgl-unavailable' | 'webgl-lost') {
  fail(kind)
}

function onVisibility() {
  if (document.visibilityState === 'visible' && camera.state.value === 'ended' && phase.value === 'tracking') {
    void startCamera()
  }
}

function retry() {
  if (errorKind.value === 'model-load-failed' && cameraActive.value) {
    errorKind.value = null
    phase.value = 'starting'
    tracker.load().then(
      () => (phase.value = 'tracking'),
      () => fail('model-load-failed'),
    )
    return
  }
  void startCamera()
}

function reload() {
  window.location.reload()
}

// briefly announce when a second (third, …) person joins
let multiHintTimer: ReturnType<typeof setTimeout> | undefined
watch(
  () => faceCount.value.tracked,
  (n, prev) => {
    if (n > 1 && n > (prev ?? 0)) {
      showMultiHint.value = true
      clearTimeout(multiHintTimer)
      multiHintTimer = setTimeout(() => (showMultiHint.value = false), 3500)
    }
  },
)

watch(
  () => camera.state.value,
  (s) => {
    if (s === 'ended' && phase.value === 'tracking') showToast('カメラが停止しました。画面に戻ると再開します')
  },
)

onMounted(() => {
  tier.value = detectQualityTier()
  document.addEventListener('visibilitychange', onVisibility)
  // warm up the (locally hosted) model while the user reads the start screen
  const idle = (cb: () => void) =>
    'requestIdleCallback' in window ? window.requestIdleCallback(cb, { timeout: 1500 }) : setTimeout(cb, 600)
  idle(() => void tracker.load().catch(() => undefined))
})

onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', onVisibility)
  clearTimeout(toastTimer)
  clearTimeout(composeTimer)
  clearTimeout(multiHintTimer)
  revokeResult()
  camera.stop()
})
</script>

<template>
  <main class="app" :class="[`phase-${phase}`, `mode-${mode}`]">
    <CameraView ref="cameraView" />

    <div class="stage" aria-live="off">
      <PumpkinLive
        v-if="showStage && tier"
        ref="live"
        :video="videoEl"
        :mode="mode"
        :active="liveActive"
        :tier="tier"
        @status="trackingStatus = $event"
        @faces="faceCount = $event"
        @error="onStageError"
      />
      <Transition name="fade">
        <div v-if="carveInput && tier && (phase === 'carving' || phase === 'result')" class="stage-layer">
          <PumpkinCarve
            ref="carve"
            :faces="carveInput.faces"
            :tier="tier"
            :paused="!!resultImageUrl"
            @ready="onCarveReady"
            @error="onStageError"
          />
        </div>
      </Transition>
      <div v-if="flash" class="flash" aria-hidden="true" />
    </div>

    <header class="topbar">
      <h1 v-if="!showIntro" class="brand">カボチャウ</h1>
      <StatusHint :text="hint.text" :tone="hint.tone" />
    </header>

    <!-- start screen: logo + the two ways in, nothing else -->
    <section v-if="showIntro" class="intro">
      <IntroScene />
      <h1 class="intro__logo">
        <img src="/logo.webp" alt="カボチャウ" width="720" height="720" decoding="async" />
      </h1>
      <button type="button" class="btn btn--primary btn--large" :disabled="phase === 'starting'" @click="startCamera">
        {{ phase === 'starting' ? '起動中…' : 'カメラではじめる' }}
      </button>
      <button type="button" class="btn btn--text" :disabled="busy" @click="pickPhoto">写真からつくる</button>
      <p class="intro__privacy">顔データは端末の外に送信しません</p>
    </section>

    <!-- errors -->
    <section v-if="phase === 'error' && errorCopy" class="panel" role="alertdialog" aria-labelledby="err-title" aria-describedby="err-body">
      <h2 id="err-title" class="panel__title">{{ errorCopy.title }}</h2>
      <p id="err-body" class="panel__body">{{ errorCopy.body }}</p>
      <div class="panel__actions">
        <button v-if="errorCopy.retry" type="button" class="btn btn--primary" @click="retry">再試行</button>
        <button v-if="'reload' in errorCopy && errorCopy.reload" type="button" class="btn btn--primary" @click="reload">再読み込み</button>
        <button v-if="errorCopy.photo" type="button" class="btn btn--ghost" :disabled="busy" @click="pickPhoto">写真からつくる</button>
      </div>
    </section>

    <!-- capture controls -->
    <footer v-if="phase === 'tracking' || phase === 'starting' || phase === 'processing'" class="controls">
      <button type="button" class="icon-button controls__photo" aria-label="写真からカボチャをつくる（MAKE）" :disabled="busy" @click="pickPhoto">
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
          <rect x="3" y="5" width="18" height="14" rx="3" fill="none" stroke="currentColor" stroke-width="1.8" />
          <circle cx="9" cy="10" r="1.8" fill="currentColor" />
          <path d="M4 17l5-5 4 4 3-3 4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" />
        </svg>
      </button>
      <ModeSwitch v-model="mode" :disabled="busy || phase !== 'tracking'" />
      <CaptureButton
        :variant="mode"
        :label="mode === 'live' ? '撮影する' : 'カボチャをつくる'"
        :busy="busy"
        :disabled="phase !== 'tracking'"
        @press="onCapture"
      />
    </footer>

    <!-- result -->
    <ResultPreview
      v-if="phase === 'result'"
      :image-url="resultImageUrl"
      :image-width="result?.width"
      :image-height="result?.height"
      :board="stickers"
      :decorating="decorating"
      :can-share="canShareResult"
      :busy="busy"
      :note="result?.fallback ? `端末性能のため ${result.width}×${result.height} で保存します` : null"
      @save="onSave"
      @share="onShare"
      @retake="onRetake"
      @decorate="startDecorating"
      @done="finishDecorating"
    />
    <div v-if="phase === 'carving'" class="controls controls--carving">
      <button type="button" class="btn btn--ghost" @click="carve?.skip()">スキップ</button>
    </div>

    <input ref="photoInput" class="visually-hidden" type="file" accept="image/*" tabindex="-1" aria-hidden="true" @change="onPhotoSelected" />
  </main>
</template>
