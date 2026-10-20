<script setup lang="ts">
// Result controls. The exported PNG is shown whenever it is what gets saved:
// always for LIVE, and for MAKE once stamps are being added (before that the
// rotatable 3D stage stays visible underneath and only the controls are
// overlaid). Stamps are drawn over the PNG at normalised positions and
// composited into the saved file on save/share.
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { StickerBoard } from '~/composables/useStickers'
import type { StickerId } from '~/utils/stickerCatalog'
import { containSize } from '~/utils/imageExport'

const props = defineProps<{
  imageUrl?: string | null
  imageAlt?: string
  imageWidth?: number
  imageHeight?: number
  board: StickerBoard
  decorating: boolean
  canShare: boolean
  busy?: boolean
  note?: string | null
}>()
const emit = defineEmits<{ save: []; share: []; retake: []; decorate: []; done: [] }>()

const figure = ref<HTMLElement | null>(null)
const box = ref({ w: 0, h: 0 })
let observer: ResizeObserver | null = null

const fit = computed(() => containSize(box.value.w, box.value.h, (props.imageWidth ?? 9) / (props.imageHeight ?? 16)))
const hasStickers = computed(() => props.board.items.value.length > 0)

function measure(el: HTMLElement) {
  const cs = getComputedStyle(el)
  box.value = {
    w: el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
    h: el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom),
  }
}

watch(
  figure,
  (el) => {
    observer?.disconnect()
    observer = null
    if (!el) return
    measure(el)
    observer = new ResizeObserver(() => measure(el))
    observer.observe(el)
  },
  { flush: 'post' },
)

onBeforeUnmount(() => observer?.disconnect())

function add(id: StickerId) {
  props.board.add(id, (props.imageWidth ?? 9) / (props.imageHeight ?? 16))
}
</script>

<template>
  <div class="result" :class="{ 'has-image': !!imageUrl, 'is-decorating': decorating }">
    <figure v-if="imageUrl" ref="figure" class="result__figure">
      <div class="result__frame" :class="{ 'has-stickers': hasStickers }" :style="{ width: `${fit.w}px`, height: `${fit.h}px` }">
        <img :src="imageUrl" :alt="imageAlt ?? 'カボチャウで撮影した画像'" class="result__image" draggable="false" />
        <StickerLayer :board="board" :width="fit.w" :height="fit.h" :editing="decorating" />
      </div>
    </figure>
    <div class="result__actions">
      <template v-if="decorating">
        <StickerTray :disabled="busy || board.full.value" @add="add" />
        <div class="result__buttons">
          <button
            type="button"
            class="btn btn--ghost"
            :disabled="busy || !board.selected.value"
            aria-label="選択中のスタンプを削除"
            @click="board.selected.value && board.remove(board.selected.value.uid)"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            削除
          </button>
          <button type="button" class="btn btn--ghost" :disabled="busy || !hasStickers" @click="board.clear()">すべて消す</button>
          <button type="button" class="btn btn--primary" :disabled="busy" @click="emit('done')">完了</button>
        </div>
      </template>
      <template v-else>
        <p v-if="note" class="result__note">{{ note }}</p>
        <button type="button" class="btn btn--chip" :disabled="busy" @click="emit('decorate')">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path
              d="M12 2.5l2.4 5.6 6.1.5-4.6 4 1.4 5.9L12 15.4l-5.3 3.1 1.4-5.9-4.6-4 6.1-.5z"
              fill="currentColor"
              stroke="currentColor"
              stroke-width="1"
              stroke-linejoin="round"
            />
          </svg>
          {{ hasStickers ? 'スタンプを編集' : 'スタンプでデコる' }}
        </button>
        <div class="result__buttons">
          <button type="button" class="btn btn--ghost" :disabled="busy" @click="emit('retake')">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v4h4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            撮り直す
          </button>
          <button v-if="canShare" type="button" class="btn btn--ghost" :disabled="busy" @click="emit('share')">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path d="M12 15V3m0 0L7.5 7.5M12 3l4.5 4.5M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            共有
          </button>
          <button type="button" class="btn btn--primary" :disabled="busy" @click="emit('save')">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path d="M12 3v12m0 0l-4.5-4.5M12 15l4.5-4.5M5 21h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            保存
          </button>
        </div>
      </template>
    </div>
  </div>
</template>
