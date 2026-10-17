<script setup lang="ts">
import { STICKERS, type StickerId } from '~/utils/stickerCatalog'

defineProps<{ disabled?: boolean }>()
const emit = defineEmits<{ add: [StickerId] }>()
</script>

<template>
  <div class="sticker-tray" role="toolbar" aria-label="スタンプ">
    <button
      v-for="def in STICKERS"
      :key="def.id"
      type="button"
      class="sticker-tray__item"
      :class="{ 'is-wide': def.width / def.height > 1.6 }"
      :aria-label="`${def.label}のスタンプを追加`"
      :disabled="disabled"
      @click="emit('add', def.id)"
    >
      <StickerArt :def="def" />
    </button>
  </div>
</template>
