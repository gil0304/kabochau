import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { ORBIT_PITCH_MAX, ORBIT_YAW_LIMIT, applyOrbitDrag, orbitCameraPosition, type OrbitOffset } from '../app/utils/orbit'

// Projects a point on the pumpkin's front surface the same way CarveStage
// places its camera, and returns its screen position in NDC (+x right, +y up).
function projectFrontPoint(o: OrbitOffset): THREE.Vector3 {
  const centerY = 0.1
  const camera = new THREE.PerspectiveCamera(30, 9 / 16, 0.1, 50)
  const p = orbitCameraPosition(0.14 + o.yaw, 0.1 + o.pitch, 6, centerY)
  camera.position.set(p.x, p.y, p.z)
  camera.lookAt(0, centerY, 0)
  camera.updateMatrixWorld()
  return new THREE.Vector3(0, centerY, 1).project(camera)
}

describe('orbit drag', () => {
  const rest: OrbitOffset = { yaw: 0, pitch: 0 }

  it('moves the pumpkin surface in the same horizontal direction as the drag', () => {
    const before = projectFrontPoint(rest)
    const right = projectFrontPoint(applyOrbitDrag(rest, 60, 0))
    const left = projectFrontPoint(applyOrbitDrag(rest, -60, 0))
    expect(right.x).toBeGreaterThan(before.x + 0.05)
    expect(left.x).toBeLessThan(before.x - 0.05)
  })

  it('moves the pumpkin surface in the same vertical direction as the drag', () => {
    const before = projectFrontPoint(rest)
    // screen dy > 0 is a downward drag; NDC y decreases downward
    const down = projectFrontPoint(applyOrbitDrag(rest, 0, 40))
    const up = projectFrontPoint(applyOrbitDrag(rest, 0, -40))
    expect(down.y).toBeLessThan(before.y)
    expect(up.y).toBeGreaterThan(before.y)
  })

  it('clamps the orbit so the carved face never turns fully away', () => {
    const far = applyOrbitDrag(applyOrbitDrag(rest, -5000, 5000), -5000, 5000)
    expect(far.yaw).toBe(ORBIT_YAW_LIMIT)
    expect(far.pitch).toBe(ORBIT_PITCH_MAX)
  })

  it('keeps the camera at the requested distance from the target', () => {
    const p = orbitCameraPosition(0.7, 0.2, 5, 0.3)
    expect(Math.hypot(p.x, p.y - 0.3, p.z)).toBeCloseTo(5, 9)
  })
})
