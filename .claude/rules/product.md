# Product specification

## Concept
PUMPKIN ME: Your face becomes a glowing jack-o'-lantern. Single-screen mobile-first Halloween experience, minimal dark UI and camera as hero. Two modes selected with LIVE / CARVE. Capture and preview without page navigation. Save/retake. No login.

## UX states
idle -> requesting-permission -> tracking -> captured/preview -> retake; errors: camera-denied, camera-unavailable, no-face, multi-face, asset/model-load-failed, WebGL-unavailable, export-failed. Provide useful retry paths, not silent failures.

## LIVE
- Selfie camera mirrored in preview; detect one face with MediaPipe Face Landmarker and relevant face blendshapes/transforms.
- Pumpkin mask follows position, scale, head yaw/pitch/roll and moves smoothly; reflects eyes, brows, nose, mouth and changing facial expression including blinking, smile and mouth open.
- 3D pumpkin orange ribbing, stem, carved-looking openings, warm inner glow. The mask should cover the face rather than being a tiny sticker.
- Lost tracking -> hide mask and show guidance; recovered tracking -> resume.
- Capture must match the composite of the camera and effects (including consistent mirrored orientation), with no UI overlay.

## CARVE
- Source: detected face snapshot OR user-selected still image. Extract normalized eye spacing/shape, brow angles, nose ratios, mouth width/curve/opening, asymmetries.
- Construct one personalized pumpkin without the human photo in the final image. The final pumpkin must visually differ for different faces; avoid merely swapping among a handful of canned assets.
- Carved eye/nose/mouth geometry has convincing inset depth/edge shadow and inner illumination. True 3D holes preferred when stable; layered geometry/depth illusion allowed if robust and convincing.
- Pumpkin anatomy: orange textured shell, vertical grooves, stem, natural dimensionality. Dark cinematic backdrop; entire pumpkin in final frame.
- Short sequence: darkness -> reveal silhouette -> carve features -> ignite glow -> final.

## Controls
- Upper small title PUMPKIN ME.
- Mode switch LIVE / CARVE above prominent bottom capture button.
- Result view save and retake; optional share when supported.
- Camera/photo-upload entry unobtrusive. All controls respect safe area and are touch-friendly.
- Show one-line guidance for no face / permission / photo upload.

## Export
- PNG target 1080x1920 portrait (or explicit safe fallback on low-end devices), without buttons or guides.
- LIVE: camera frame + pumpkin composited as visibly previewed. CARVE: whole pumpkin + visual backdrop.
- Use blob/download reliably; mobile share when supported and user-initiated. Never auto-upload.

## Accessible/mobile
- iPhone Safari and Android Chrome priorities. Responsive desktop support. Controls have accessible names, high contrast, keyboard usability where appropriate.
