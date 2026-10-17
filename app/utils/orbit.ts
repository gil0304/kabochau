// Drag-to-rotate for the MAKE (internally "carve") result view.
//
// The pumpkin stays still and the camera orbits around it on a sphere:
//   position = target + dist * (sin(yaw)·cos(pitch), sin(pitch), cos(yaw)·cos(pitch))
// so +yaw moves the camera toward +X (screen right) and +pitch raises it.
//
// The drag should feel like grabbing the pumpkin: the surface under the
// finger moves with the finger. Moving the camera right makes the object's
// front surface slide LEFT on screen, so horizontal drag maps to NEGATIVE
// yaw. Raising the camera makes the front surface slide DOWN, so a downward
// drag (dy > 0 in screen pixels) maps to POSITIVE pitch.

import { clamp, v3, type Vec3 } from './math'

export interface OrbitOffset {
  yaw: number
  pitch: number
}

export const ORBIT_YAW_PER_PX = 0.008
export const ORBIT_PITCH_PER_PX = 0.004
export const ORBIT_YAW_LIMIT = 1.1
export const ORBIT_PITCH_MIN = -0.25
export const ORBIT_PITCH_MAX = 0.35

/** Accumulates a pointer delta (CSS px, screen axes: +x right, +y down). */
export function applyOrbitDrag(o: OrbitOffset, dx: number, dy: number): OrbitOffset {
  return {
    yaw: clamp(o.yaw - dx * ORBIT_YAW_PER_PX, -ORBIT_YAW_LIMIT, ORBIT_YAW_LIMIT),
    pitch: clamp(o.pitch + dy * ORBIT_PITCH_PER_PX, ORBIT_PITCH_MIN, ORBIT_PITCH_MAX),
  }
}

export function orbitCameraPosition(yaw: number, pitch: number, dist: number, centerY: number): Vec3 {
  return v3(Math.sin(yaw) * Math.cos(pitch) * dist, centerY + Math.sin(pitch) * dist, Math.cos(yaw) * Math.cos(pitch) * dist)
}
