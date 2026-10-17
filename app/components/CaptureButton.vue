<script setup lang="ts">
defineProps<{ label: string; disabled?: boolean; busy?: boolean; variant?: 'live' | 'carve' }>()
const emit = defineEmits<{ press: [] }>()
</script>

<template>
  <button
    type="button"
    class="capture-button"
    :class="[`is-${variant ?? 'live'}`, { 'is-busy': busy }]"
    :aria-label="label"
    :aria-busy="busy || undefined"
    :disabled="disabled || busy"
    @click="emit('press')"
  >
    <span class="capture-button__ring" aria-hidden="true" />
    <span class="capture-button__core" aria-hidden="true">
      <svg v-if="variant === 'carve'" viewBox="0 0 24 24" width="26" height="26">
        <path
          d="M4 20 L14.5 9.5 M13 4.5 l6.5 6.5 -3 3 -6.5 -6.5z"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </span>
  </button>
</template>
