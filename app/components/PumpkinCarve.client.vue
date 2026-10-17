<script setup lang="ts">
// MAKE result stage (one pumpkin per person). Receives only measured parameters — never pixels.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { CarveStage } from '~/render/carveStage'
import type { CaptureResult } from '~/render/liveCompositor'
import type { QualityTier } from '~/render/quality'
import type { CarveFaceInput } from '~/utils/faceTracks'

// `paused`: the stage is fully covered (e.g. stamp editing over the PNG) — skip rendering.
const props = defineProps<{ faces: readonly CarveFaceInput[]; tier: QualityTier; paused?: boolean }>()
const emit = defineEmits<{ ready: []; error: ['webgl-unavailable' | 'webgl-lost'] }>()

const canvas = ref<HTMLCanvasElement | null>(null)
let stage: CarveStage | null = null
let raf = 0
let resizeObserver: ResizeObserver | null = null
let pointer: { id: number; x: number; y: number; moved: number } | null = null

function loop(now: number) {
  raf = requestAnimationFrame(loop)
  if (document.hidden || props.paused || !stage) return
  stage.frame(now)
}

function onPointerDown(e: PointerEvent) {
  pointer = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: 0 }
  ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
}
function onPointerMove(e: PointerEvent) {
  if (!pointer || pointer.id !== e.pointerId || !stage) return
  const dx = e.clientX - pointer.x
  const dy = e.clientY - pointer.y
  pointer.moved += Math.abs(dx) + Math.abs(dy)
  pointer.x = e.clientX
  pointer.y = e.clientY
  if (stage.finished) stage.drag(dx, dy)
}
function onPointerUp(e: PointerEvent) {
  if (!pointer || pointer.id !== e.pointerId) return
  if (pointer.moved < 8 && stage && !stage.finished) stage.skip()
  stage?.endDrag()
  pointer = null
}
function onKey(e: KeyboardEvent) {
  if (!stage) return
  if (e.key === 'Enter' || e.key === ' ') {
    if (!stage.finished) {
      e.preventDefault()
      stage.skip()
    }
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault()
    stage.drag(e.key === 'ArrowLeft' ? -30 : 30, 0)
    setTimeout(() => stage?.endDrag(), 200)
  }
}
function onContextLost(e: Event) {
  e.preventDefault()
  emit('error', 'webgl-lost')
}

onMounted(() => {
  const el = canvas.value
  if (!el) return
  try {
    stage = new CarveStage(el, props.faces, props.tier, () => emit('ready'))
  } catch {
    emit('error', 'webgl-unavailable')
    return
  }
  el.addEventListener('webglcontextlost', onContextLost)
  const parent = el.parentElement ?? el
  const applySize = () => {
    const r = parent.getBoundingClientRect()
    stage?.resize(r.width, r.height)
  }
  applySize()
  resizeObserver = new ResizeObserver(applySize)
  resizeObserver.observe(parent)
  raf = requestAnimationFrame(loop)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  resizeObserver?.disconnect()
  canvas.value?.removeEventListener('webglcontextlost', onContextLost)
  stage?.dispose()
  stage = null
})

const label = computed(() => {
  const who = props.faces.length > 1 ? `${props.faces.length}人それぞれの顔から彫られたジャック・オー・ランタン` : 'あなたの顔から彫られたジャック・オー・ランタン'
  return `${who}。左右の矢印キーまたはドラッグで回転、Enterで演出をスキップ。`
})

defineExpose({
  skip: () => stage?.skip(),
  async capture(): Promise<CaptureResult> {
    if (!stage) throw new Error('stage unavailable')
    return stage.capture()
  },
})
</script>

<template>
  <canvas
    ref="canvas"
    class="stage-canvas stage-canvas--carve"
    role="img"
    tabindex="0"
    :aria-label="label"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
    @keydown="onKey"
  />
</template>
