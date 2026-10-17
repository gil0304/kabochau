<script setup lang="ts">
// Hosts the camera <video>. It is never shown directly: frames are drawn
// (cropped + mirrored) into the WebGL canvas so preview and export match.
// It stays in the DOM (not display:none) because iOS Safari stops decoding
// frames for detached / hidden video elements.
import { ref } from 'vue'

const video = ref<HTMLVideoElement | null>(null)
defineExpose({ video })
</script>

<template>
  <video ref="video" class="camera-video" playsinline muted autoplay disablepictureinpicture aria-hidden="true" tabindex="-1" />
</template>
