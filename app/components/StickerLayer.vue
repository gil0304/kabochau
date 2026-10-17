<script setup lang="ts">
// Stamps over the result image. While `editing`:
//   drag a stamp            → move
//   two fingers             → pinch to scale + rotate the selected stamp
//   corner handle (mouse)   → scale + rotate around the centre
//   wheel / trackpad pinch  → scale (Shift / Alt + wheel rotates)
//   keyboard (focused stamp): arrows move, + / - scale, [ / ] rotate, Delete removes
// Positions are normalised to the image, so they survive layout changes and
// map 1:1 onto the exported PNG.
import { computed, ref, watch } from 'vue'
import type { StickerBoard } from '~/composables/useStickers'
import { STICKER_BY_ID } from '~/utils/stickerCatalog'
import {
  STICKER_SHADOW_BLUR,
  clampSticker,
  moveSticker,
  rotateSticker,
  scaleSticker,
  stickerCssPlacement,
  transformSticker,
  type PlacedSticker,
} from '~/utils/stickers'
import type { Vec2 } from '~/utils/math'

const props = defineProps<{ board: StickerBoard; width: number; height: number; editing: boolean }>()

type Gesture =
  | { kind: 'move'; uid: string; id: number; start: Vec2; base: PlacedSticker }
  | { kind: 'pinch'; uid: string; ids: [number, number]; a: Vec2; b: Vec2; base: PlacedSticker }
  | { kind: 'handle'; uid: string; id: number; center: Vec2; start: Vec2; base: PlacedSticker }
  | { kind: 'tap'; id: number; start: Vec2; moved: number }

const root = ref<HTMLElement | null>(null)
const pointers = new Map<number, Vec2>()
let gesture: Gesture | null = null

const items = computed(() => props.board.items.value)
const selected = computed(() => (props.editing ? props.board.selected.value : null))
const shadow = computed(() => `drop-shadow(0 0 ${(STICKER_SHADOW_BLUR * props.width).toFixed(2)}px rgba(0, 0, 0, 0.5))`)
const frame = () => ({ w: props.width, h: props.height })
const find = (uid: string) => props.board.items.value.find((s) => s.uid === uid) ?? null
const defOf = (s: PlacedSticker) => STICKER_BY_ID[s.type]

function local(e: PointerEvent): Vec2 {
  const r = root.value?.getBoundingClientRect()
  return r ? { x: e.clientX - r.left, y: e.clientY - r.top } : { x: e.clientX, y: e.clientY }
}

function startPinch(uid: string): void {
  const base = find(uid)
  const ids = [...pointers.keys()]
  const a = pointers.get(ids[0]!)
  const b = pointers.get(ids[1]!)
  if (!base || !a || !b) return
  gesture = { kind: 'pinch', uid, ids: [ids[0]!, ids[1]!], a: { ...a }, b: { ...b }, base }
}

function onPointerDown(e: PointerEvent) {
  if (!props.editing || !root.value) return
  const target = e.target as Element
  // the delete button handles its own click; capturing would retarget it
  if (target.closest('[data-delete]')) return
  if (e.pointerType === 'mouse' && e.button !== 0) return
  const p = local(e)
  pointers.set(e.pointerId, p)
  try {
    root.value.setPointerCapture(e.pointerId)
  } catch {
    // synthetic / already-released pointers
  }
  e.preventDefault()
  const sel = props.board.selectedId.value
  if (pointers.size >= 2) {
    if (sel) startPinch(sel)
    return
  }
  const sticker = find(sel ?? '')
  if (sticker && target.closest('[data-handle]')) {
    const center = { x: sticker.x * props.width, y: sticker.y * props.height }
    gesture = { kind: 'handle', uid: sticker.uid, id: e.pointerId, center, start: p, base: sticker }
    return
  }
  const uid = target.closest<HTMLElement>('[data-uid]')?.dataset.uid
  const hit = uid ? find(uid) : null
  if (hit) {
    props.board.pick(hit.uid)
    gesture = { kind: 'move', uid: hit.uid, id: e.pointerId, start: p, base: hit }
  } else {
    gesture = { kind: 'tap', id: e.pointerId, start: p, moved: 0 }
  }
}

function onPointerMove(e: PointerEvent) {
  if (!pointers.has(e.pointerId)) return
  const p = local(e)
  pointers.set(e.pointerId, p)
  const g = gesture
  if (!g) return
  let next: PlacedSticker | null = null
  if (g.kind === 'move' && g.id === e.pointerId) {
    next = moveSticker(g.base, p.x - g.start.x, p.y - g.start.y, frame())
  } else if (g.kind === 'pinch') {
    const a = pointers.get(g.ids[0])
    const b = pointers.get(g.ids[1])
    if (a && b) next = transformSticker(g.base, g.a, g.b, a, b, frame())
  } else if (g.kind === 'handle' && g.id === e.pointerId) {
    next = transformSticker(g.base, g.center, g.start, g.center, p, frame())
  } else if (g.kind === 'tap' && g.id === e.pointerId) {
    g.moved = Math.max(g.moved, Math.hypot(p.x - g.start.x, p.y - g.start.y))
  }
  if (next) props.board.update(next)
}

function onPointerUp(e: PointerEvent) {
  if (!pointers.has(e.pointerId)) return
  pointers.delete(e.pointerId)
  try {
    root.value?.releasePointerCapture(e.pointerId)
  } catch {
    // already released
  }
  const g = gesture
  if (!g) return
  if (g.kind === 'pinch') {
    // one finger lifted: continue as a drag with the remaining finger
    const rest = [...pointers.entries()][0]
    const s = find(g.uid)
    gesture = rest && s ? { kind: 'move', uid: s.uid, id: rest[0], start: { ...rest[1] }, base: s } : null
    return
  }
  if (g.id !== e.pointerId) return
  // a tap on empty space deselects (a drag there does nothing)
  if (g.kind === 'tap' && e.type === 'pointerup' && g.moved < 8) props.board.selectedId.value = null
  gesture = null
}

function onWheel(e: WheelEvent) {
  const s = selected.value
  if (!props.editing || !s) return
  e.preventDefault()
  const d = Math.max(-120, Math.min(120, e.deltaY))
  props.board.update(e.shiftKey || e.altKey ? rotateSticker(s, d * 0.004) : scaleSticker(s, Math.exp(-d * 0.0025)))
}

function onKey(e: KeyboardEvent, uid: string) {
  const s = find(uid)
  if (!props.editing || !s) return
  const step = e.shiftKey ? 0.05 : 0.01
  const turn = (Math.PI / 180) * (e.shiftKey ? 45 : 15)
  let next: PlacedSticker | null = null
  switch (e.key) {
    case 'ArrowLeft':
      next = clampSticker({ ...s, x: s.x - step })
      break
    case 'ArrowRight':
      next = clampSticker({ ...s, x: s.x + step })
      break
    case 'ArrowUp':
      next = clampSticker({ ...s, y: s.y - step * (props.width / Math.max(1, props.height)) })
      break
    case 'ArrowDown':
      next = clampSticker({ ...s, y: s.y + step * (props.width / Math.max(1, props.height)) })
      break
    case '+':
    case '=':
      next = scaleSticker(s, 1.1)
      break
    case '-':
    case '_':
      next = scaleSticker(s, 1 / 1.1)
      break
    case '[':
      next = rotateSticker(s, -turn)
      break
    case ']':
      next = rotateSticker(s, turn)
      break
    case 'Delete':
    case 'Backspace':
      e.preventDefault()
      props.board.remove(uid)
      root.value?.focus()
      return
    case 'Escape':
      props.board.selectedId.value = null
      return
    default:
      return
  }
  e.preventDefault()
  props.board.update(next)
}

function onFocus(uid: string) {
  if (props.editing) props.board.selectedId.value = uid
}

watch(
  () => props.editing,
  (on) => {
    if (!on) {
      pointers.clear()
      gesture = null
    }
  },
)
</script>

<template>
  <div
    ref="root"
    class="sticker-layer"
    :class="{ 'is-editing': editing }"
    tabindex="-1"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
    @wheel="onWheel"
  >
    <div class="sticker-layer__art">
      <div
        v-for="s in items"
        :key="s.uid"
        class="sticker"
        :data-uid="s.uid"
        :style="stickerCssPlacement(s, defOf(s))"
        :role="editing ? 'button' : 'img'"
        :tabindex="editing ? 0 : undefined"
        :aria-label="`${defOf(s).label}のスタンプ`"
        :aria-pressed="editing ? s.uid === selected?.uid : undefined"
        :aria-describedby="editing ? 'sticker-keys' : undefined"
        @focus="onFocus(s.uid)"
        @keydown="onKey($event, s.uid)"
      >
        <StickerArt :def="defOf(s)" :style="{ filter: shadow }" />
      </div>
    </div>
    <div v-if="selected" class="sticker-selection" :style="stickerCssPlacement(selected, defOf(selected))">
      <button type="button" class="sticker-selection__delete" data-delete aria-label="このスタンプを削除" @click="board.remove(selected.uid)">
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
          <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="3" stroke-linecap="round" />
        </svg>
      </button>
      <span class="sticker-selection__handle" data-handle aria-hidden="true">
        <svg viewBox="0 0 24 24" width="14" height="14">
          <path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v4h-4" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </span>
    </div>
    <p v-if="editing" id="sticker-keys" class="visually-hidden">矢印キーで移動、プラスとマイナスで拡大縮小、角かっこで回転、Deleteで削除</p>
  </div>
</template>
