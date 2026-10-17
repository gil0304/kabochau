# Architecture and implementation constraints

## Stack
Nuxt latest compatible stable + TypeScript, npm, Three.js, @mediapipe/tasks-vision. No backend/data store required. Nuxt client-only components or guarded imports for media and WebGL. Deploy Now compatible Nuxt setup; do not change Nitro preset arbitrarily.

## Modules
- Camera lifecycle: start/stop, permission state, constraints, visibility, cleanup.
- Face tracker: load MediaPipe once, init safely, infer landmarks/blendshapes/transformation matrix, target one face; normalize coordinates and mirror mapping.
- Mapping: stable normalized feature data used by BOTH LIVE and CARVE. Document sign conventions, aspect ratio, axes, eye mapping and smoothing.
- Pumpkin geometry/materials: textured shell, stem, grooves, facial opening/inset shapes and glow; separate data model from renderer.
- LIVE compositor: render synchronized video and GPU scene to a common canvas. Avoid misalignment caused by CSS object-fit, mirroring, devicePixelRatio, or resizing.
- CARVE renderer: convert snapshot landmarks to personalized immutable parameters, render pumpkin, animate reveal, support photo fallback.
- Export: isolated offscreen/renderer-based capture at target aspect; preserve visible composition; no DOM screenshots containing UI.

## Preferred structure
`pages/index.vue`, `components/CameraView.vue`, `components/ModeSwitch.vue`, `components/CaptureButton.vue`, `components/ResultPreview.vue`, `components/PumpkinLive.client.vue`, `components/PumpkinCarve.client.vue`, `composables/useCamera.ts`, `composables/useFaceTracking.ts`, `composables/useCapture.ts`, `utils/faceMapping.ts`, `utils/expressionMapping.ts`, `utils/pumpkinGeometry.ts`, `utils/imageExport.ts`, `assets/css/main.css`, `tests/`.
Adapt when simpler, but keep detection, geometry, rendering, and export responsibilities isolated.

## Performance
- Render loop via requestAnimationFrame; avoid duplicate inference per frame; throttle adaptive inference and/or resolution; interpolate between detections.
- Dispose GPU objects, video tracks, animation frames and event listeners on unmount. Pause when hidden.
- Limit overly expensive real-time CSG/boolean updates: create base meshes once, update morphable shapes/materials.
- Handle WebGL failures and low-end devices gracefully. Optimize for usable mobile experience, not arbitrary desktop-only FPS claims.

## Privacy/security
- Face pixels/landmarks stay on device. Loading publicly hosted JS/model assets is allowed but not image uploads. Prefer local asset packaging when practical.
- No analytics, trackers, telemetry, hidden network image calls or credentials in code.
- Camera requires HTTPS (localhost permitted for development) and user permission.
