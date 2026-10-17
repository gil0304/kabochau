<script setup lang="ts">
// Inline-SVG rendering of a stamp definition. Must stay in step with
// paintSticker() in render/stickerCanvas.ts (same layers, order and text
// stretching) so the editor preview matches the saved PNG.
import { computed } from 'vue'
import { STICKER_FONT_FAMILY, STICKER_FONT_WEIGHT, type StickerDef, type StickerTextLayer } from '~/utils/stickerCatalog'
import { textRunScale } from '~/render/stickerCanvas'

const props = defineProps<{ def: StickerDef }>()

const outlineLayers = computed(() => (props.def.outline ? props.def.layers.filter((l) => l.outline) : []))
const runTransform = (l: StickerTextLayer) => `translate(${l.x} ${l.y}) scale(${textRunScale(l).toFixed(5)} 1)`
const innerStroke = (l: { stroke?: string; strokeWidth?: number }) => (l.stroke ? (l.strokeWidth ?? 1) : 0)
</script>

<template>
  <svg
    class="sticker-art"
    :viewBox="`0 0 ${def.width} ${def.height}`"
    overflow="visible"
    aria-hidden="true"
    focusable="false"
    stroke-linejoin="round"
    stroke-linecap="round"
  >
    <g v-if="def.outline" :stroke="def.outline.color" fill="none">
      <template v-for="(l, i) in outlineLayers" :key="`o${i}`">
        <path v-if="l.kind === 'path'" :d="l.d" :stroke-width="def.outline.width * 2 + innerStroke(l)" />
        <text
          v-else
          :transform="runTransform(l)"
          text-anchor="middle"
          :font-size="l.size"
          :font-weight="STICKER_FONT_WEIGHT"
          :font-family="STICKER_FONT_FAMILY"
          :stroke-width="def.outline.width * 2 + innerStroke(l)"
        >{{ l.text }}</text>
      </template>
    </g>
    <template v-for="(l, i) in def.layers" :key="`l${i}`">
      <path
        v-if="l.kind === 'path'"
        :d="l.d"
        :fill="l.fill ?? 'none'"
        :fill-rule="l.fillRule ?? 'nonzero'"
        :stroke="l.stroke ?? 'none'"
        :stroke-width="l.strokeWidth ?? 1"
        :opacity="l.opacity ?? 1"
      />
      <g v-else :transform="runTransform(l)" text-anchor="middle" :font-size="l.size" :font-weight="STICKER_FONT_WEIGHT" :font-family="STICKER_FONT_FAMILY">
        <text v-if="l.stroke" fill="none" :stroke="l.stroke" :stroke-width="l.strokeWidth ?? 1">{{ l.text }}</text>
        <text :fill="l.fill" stroke="none">{{ l.text }}</text>
      </g>
    </template>
  </svg>
</template>
