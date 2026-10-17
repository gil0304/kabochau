---
name: implement-pumpkin
description: Implement PUMPKIN ME end-to-end in a new or existing Nuxt project, including LIVE/CARVE, capture, tests, and production build.
---

# Implement PUMPKIN ME

Read root `CLAUDE.md` and all `.claude/rules/*.md` first. Then execute, not merely plan:

1. Inspect files, Node/npm versions and project configuration. If empty, scaffold Nuxt + TypeScript in the CURRENT directory. Avoid nested redundant project folders. Use npm.
2. Set up styles and mobile-first single-screen UI, camera state, recovery, results.
3. Implement MediaPipe face detection, normalized landmark and blendshape extraction, lifecycle and permission handling. Validate matching mirroring/cropping and coordinate transforms.
4. Implement shared `PumpkinFaceParams` mapping used by both modes. Different sample faces must yield measurably different carved eye/mouth/brow geometry.
5. Implement LIVE tracked pumpkin mask, face tracking, light, mouth and eye changes. Validate visual registration.
6. Implement CARVE personalized pumpkin as scene independent of photo. Make convincing indent/cut edges, internal glow and full-framed export. Add short transformation animation.
7. Integrate capture/save/share (PNG, mobile), result/retake. Export UI-free composition.
8. Add unit tests of deterministic mapping and export-related math. Run build/typecheck/tests, fix failures. Optionally run browser tests if environment supports them; do not claim physical camera tests unless performed.
9. Add README with setup, architecture, camera permissions, privacy, known trade-offs, manual mobile tests, and Deploy Now directions.
10. Report outcome with what is working, verification logs, and blockers. Do not deploy without explicit request.

Choose sensible defaults instead of pausing for design questions. Never create empty stubs as substitutes for a required feature.
