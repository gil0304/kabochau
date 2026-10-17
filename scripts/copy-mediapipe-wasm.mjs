// Copies the MediaPipe Tasks Vision WASM runtime from node_modules into
// public/mediapipe/wasm so it is served from our own origin (no CDN needed).
// Runs on postinstall / predev and as the first step of `npm run build`
// (LOLIPOP! Deploy Now installs with --ignore-scripts, so build must do it). Only the files FilesetResolver
// loads are copied (SIMD + non-SIMD fallback); the ES-module variant is unused.
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm')
const dest = join(root, 'public', 'mediapipe', 'wasm')
const files = [
  'vision_wasm_internal.js',
  'vision_wasm_internal.wasm',
  'vision_wasm_nosimd_internal.js',
  'vision_wasm_nosimd_internal.wasm',
]

if (!existsSync(src)) {
  console.error(`[copy-mediapipe-wasm] ${src} not found — run npm install first.`)
  process.exit(1)
}
mkdirSync(dest, { recursive: true })
let copied = 0
for (const f of files) {
  const from = join(src, f)
  const to = join(dest, f)
  if (existsSync(to) && statSync(to).size === statSync(from).size && statSync(to).mtimeMs >= statSync(from).mtimeMs) continue
  copyFileSync(from, to)
  copied++
}
console.log(`[copy-mediapipe-wasm] ${copied} file(s) copied, ${files.length - copied} up to date -> public/mediapipe/wasm`)
