<script setup lang="ts">
// Decorative first-view scene in the world of the logo: moonlit night sky,
// twinkling stars, bats crossing, a haunted castle with lit windows on the
// horizon, low mist and rising embers. Pure inline SVG + CSS (no downloads),
// purely decorative (aria-hidden), motion disabled for prefers-reduced-motion.

// deterministic "random" layout so SSR and client render the same markup
const rand = (i: number, salt: number) => {
  const x = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453
  return x - Math.floor(x)
}
const stars = Array.from({ length: 34 }, (_, i) => ({
  left: `${(rand(i, 1) * 100).toFixed(2)}%`,
  top: `${(rand(i, 2) * 58).toFixed(2)}%`,
  size: `${(1 + rand(i, 3) * 2.2).toFixed(2)}px`,
  delay: `${(-rand(i, 4) * 4).toFixed(2)}s`,
  duration: `${(2.4 + rand(i, 5) * 3).toFixed(2)}s`,
}))
const embers = Array.from({ length: 14 }, (_, i) => ({
  left: `${(4 + rand(i, 6) * 92).toFixed(2)}%`,
  size: `${(2 + rand(i, 7) * 3).toFixed(2)}px`,
  delay: `${(-rand(i, 8) * 9).toFixed(2)}s`,
  duration: `${(7 + rand(i, 9) * 6).toFixed(2)}s`,
  drift: `${((rand(i, 10) - 0.5) * 60).toFixed(1)}px`,
}))
const bats = [
  { top: '14%', size: 46, duration: 17, delay: -3, flap: 0.22, rise: -6 },
  { top: '24%', size: 30, duration: 23, delay: -12, flap: 0.18, rise: 5 },
  { top: '9%', size: 24, duration: 28, delay: -20, flap: 0.16, rise: 3 },
  { top: '33%', size: 36, duration: 20, delay: -8, flap: 0.2, rise: -4 },
]
const BAT_PATH =
  'M60 17 L54 8 L52 20 C47 22 45 26 44 30 C38 22 26 15 6 18 C14 23 18 30 16 38 C22 34 28 36 31 42 C35 38 41 40 43 46 C47 43 52 46 54 51 L60 60 L66 51 C68 46 73 43 77 46 C79 40 85 38 89 42 C92 36 98 34 104 38 C102 30 106 23 114 18 C94 15 82 22 76 30 C75 26 73 22 68 20 L66 8 Z'
</script>

<template>
  <div class="scene" aria-hidden="true">
    <div class="scene__sky" />
    <div class="scene__moonglow" />
    <span
      v-for="(s, i) in stars"
      :key="`s${i}`"
      class="scene__star"
      :style="{ left: s.left, top: s.top, width: s.size, height: s.size, animationDelay: s.delay, animationDuration: s.duration }"
    />
    <div
      v-for="(b, i) in bats"
      :key="`b${i}`"
      class="scene__bat"
      :style="{ top: b.top, width: `${b.size}px`, animationDuration: `${b.duration}s`, animationDelay: `${b.delay}s`, '--rise': `${b.rise}vh` }"
    >
      <svg viewBox="0 0 120 70" :style="{ animationDuration: `${b.flap}s` }">
        <path :d="BAT_PATH" />
      </svg>
    </div>

    <!-- horizon: stretchable hills + fixed-proportion castle (left) and dead trees (right) -->
    <svg class="scene__hills scene__hills--far" viewBox="0 0 400 60" preserveAspectRatio="none">
      <path d="M0 26 Q50 6 104 18 T214 12 T318 6 T400 14 V60 H0 Z" fill="#26102f" />
    </svg>
    <svg class="scene__castle" viewBox="30 4 120 120">
      <defs>
        <filter id="scene-window-glow" x="-200%" y="-200%" width="500%" height="500%">
          <feGaussianBlur stdDeviation="1.6" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <g fill="#120618">
        <rect x="44" y="72" width="16" height="52" />
        <path d="M41 72 L52 42 L63 72 Z" />
        <rect x="58" y="86" width="56" height="38" />
        <path d="M58 86 h6 v-5 h6 v5 h6 v-5 h6 v5 h6 v-5 h6 v5 h6 v-5 h6 v5 Z" />
        <rect x="96" y="54" width="22" height="70" />
        <path d="M93 54 L107 14 L121 54 Z" />
        <rect x="118" y="80" width="14" height="44" />
        <path d="M115 80 L125 58 L135 80 Z" />
        <path d="M107 14 v-8 l8 3.5 l-8 3.5" />
      </g>
      <g fill="#ffb347" filter="url(#scene-window-glow)" class="scene__windows">
        <rect x="49" y="84" width="5" height="8" rx="2.5" />
        <rect x="103" y="66" width="6" height="10" rx="3" />
        <rect x="103" y="88" width="6" height="9" rx="3" />
        <rect x="74" y="98" width="5" height="8" rx="2.5" />
        <rect x="122" y="92" width="5" height="7" rx="2.5" />
      </g>
    </svg>
    <svg class="scene__trees" viewBox="0 0 80 70">
      <path
        d="M30 70 l2 -34 l-9 -11 l10 7 l1 -15 l4 15 l9 -10 l-8 15 l2 33 Z M60 70 l1 -22 l-6 -7 l7 5 l1 -10 l3 10 l6 -6 l-6 10 l1 20 Z"
        fill="#0b040e"
      />
    </svg>
    <svg class="scene__hills scene__hills--near" viewBox="0 0 400 40" preserveAspectRatio="none">
      <path d="M0 18 Q70 4 150 14 T300 8 T400 12 V40 H0 Z" fill="#0b040e" />
    </svg>
    <div class="scene__mist" />
    <span
      v-for="(e, i) in embers"
      :key="`e${i}`"
      class="scene__ember"
      :style="{ left: e.left, width: e.size, height: e.size, animationDelay: e.delay, animationDuration: e.duration, '--drift': e.drift }"
    />
  </div>
</template>
