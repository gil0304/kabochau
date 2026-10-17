// https://nuxt.com/docs/api/configuration/nuxt-config
//
// Notes
// - Default Nitro preset (node-server) is kept on purpose for LOLIPOP! Deploy Now.
// - `imports.scan: false`: modules in app/utils and app/composables are imported
//   explicitly so the pure modules stay unit-testable outside Nuxt.
// - Production CSP restricts network access (connect-src) to our own origin
//   plus the official MediaPipe asset CDNs used only as a fallback for loading
//   the model / WASM. Face images and landmarks are never sent anywhere.
const ASSET_CDNS = 'https://cdn.jsdelivr.net https://storage.googleapis.com'

export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: false },
  imports: { scan: false },
  css: ['~/assets/css/main.css'],

  app: {
    head: {
      htmlAttrs: { lang: 'ja' },
      title: 'PUMPKIN ME',
      meta: [
        { charset: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover' },
        { name: 'description', content: 'あなたの顔が光るジャック・オー・ランタンに。LIVEで変身、CARVEで顔の特徴からカボチャを彫刻。顔の解析は端末内で完結します。' },
        { name: 'theme-color', content: '#07050a' },
        { name: 'color-scheme', content: 'dark' },
        { name: 'mobile-web-app-capable', content: 'yes' },
        { name: 'apple-mobile-web-app-status-bar-style', content: 'black-translucent' },
        { name: 'referrer', content: 'no-referrer' },
      ],
      link: [{ rel: 'icon', type: 'image/x-icon', href: '/favicon.ico' }],
    },
  },

  nitro: {
    routeRules: {
      '/mediapipe/**': { headers: { 'cache-control': 'public, max-age=604800' } },
      '/models/**': { headers: { 'cache-control': 'public, max-age=604800' } },
    },
  },

  $production: {
    routeRules: {
      '/**': {
        headers: {
          'content-security-policy': `connect-src 'self' blob: data: ${ASSET_CDNS}; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'`,
          'permissions-policy': 'camera=(self), microphone=(), geolocation=()',
          'referrer-policy': 'no-referrer',
          'x-content-type-options': 'nosniff',
        },
      },
    },
  },

  vite: {
    optimizeDeps: {
      include: ['three', '@mediapipe/tasks-vision'],
    },
  },

  typescript: {
    strict: true,
    // unit tests + vitest config are type-checked in the node context
    nodeTsConfig: {
      include: ['../tests/**/*.ts', '../vitest.config.ts'],
    },
  },
})
