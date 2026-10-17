<script setup lang="ts">
// One persistent element (no keyed <Transition>): during start-up the text can
// change several times within a second, which made keyed transitions drop the
// final message. Opacity fades are done in CSS instead.
import { ref, watch } from 'vue'

const props = defineProps<{ text: string | null; tone?: 'info' | 'warn' }>()
const shown = ref(props.text ?? '')
watch(
  () => props.text,
  (t) => {
    if (t) shown.value = t
  },
)
</script>

<template>
  <div class="status-hint-slot" aria-live="polite" role="status">
    <!-- prettier-ignore -->
    <p class="status-hint" :class="[`is-${tone ?? 'info'}`, { 'is-hidden': !text }]" :aria-hidden="!text || undefined">{{ text ?? shown }}</p>
  </div>
</template>
