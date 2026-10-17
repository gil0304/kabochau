<script setup lang="ts">
export type AppMode = 'live' | 'carve'

const props = defineProps<{ modelValue: AppMode; disabled?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [AppMode] }>()

// Internal value stays 'carve'; the visible name is MAKE (CARVE was hard to
// read for Japanese users). Each option carries a short Japanese caption.
const options: { value: AppMode; label: string; caption: string; description: string }[] = [
  { value: 'live', label: 'LIVE', caption: '顔にかぶる', description: 'カメラの顔にカボチャをかぶせる' },
  { value: 'carve', label: 'MAKE', caption: '顔からつくる', description: '顔の特徴からあなただけのカボチャをつくる' },
]

function select(value: AppMode) {
  if (!props.disabled && value !== props.modelValue) emit('update:modelValue', value)
}

function onKey(e: KeyboardEvent) {
  if (props.disabled) return
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
    e.preventDefault()
    const next = props.modelValue === 'live' ? 'carve' : 'live'
    emit('update:modelValue', next)
    const el = (e.currentTarget as HTMLElement).querySelector<HTMLButtonElement>(`[data-value="${next}"]`)
    el?.focus()
  }
}
</script>

<template>
  <div class="mode-switch" role="radiogroup" aria-label="モード" :aria-disabled="disabled || undefined" @keydown="onKey">
    <button
      v-for="o in options"
      :key="o.value"
      type="button"
      role="radio"
      class="mode-switch__option"
      :class="{ 'is-active': modelValue === o.value }"
      :data-value="o.value"
      :aria-checked="modelValue === o.value"
      :aria-label="`${o.label}：${o.description}`"
      :tabindex="modelValue === o.value ? 0 : -1"
      :disabled="disabled"
      @click="select(o.value)"
    >
      <span class="mode-switch__label">{{ o.label }}</span>
      <span class="mode-switch__caption">{{ o.caption }}</span>
    </button>
    <span class="mode-switch__thumb" :class="`is-${modelValue}`" aria-hidden="true" />
  </div>
</template>
