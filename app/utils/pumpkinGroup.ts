// Arrangement of several personalised pumpkins in the MAKE scene.
//
// The export is a 9:16 portrait, so a long row would make every pumpkin tiny.
// Instead at most two pumpkins stand in the front row on the ground; with 3–4
// people the others sit behind them on a raised hay bale, high enough that
// their carved faces clear the front row. People keep their left-to-right
// order (as seen in the mirrored preview / the photo):
//   1: [0]          2: [0 1]          3: [0 (1) 2]        4: [0 (1)(2) 3]
// where (n) is on the back row. Units are pumpkin object units; y = 0 is the
// ground, z grows toward the camera.

import type { Vec3 } from './math'

export const MAX_GROUP = 4

export interface GroupMember {
  /** half extents of the pumpkin body */
  halfWidth: number
  halfDepth: number
  /** body height (without stem) and total height (with stem) */
  bodyHeight: number
  totalHeight: number
}

export interface GroupSlot {
  /** position of the pumpkin's base centre */
  x: number
  y: number
  z: number
  row: 'front' | 'back'
}

export interface GroupRiser {
  x: number
  z: number
  width: number
  depth: number
  height: number
}

export interface GroupArrangement {
  slots: GroupSlot[]
  risers: GroupRiser[]
  min: Vec3
  max: Vec3
}

const FRONT_INDICES: Record<number, number[]> = { 1: [0], 2: [0, 1], 3: [0, 2], 4: [0, 3] }
const BACK_INDICES: Record<number, number[]> = { 1: [], 2: [], 3: [1], 4: [1, 2] }

/**
 * Riser height: at least RISER_RATIO of the tallest front body and
 * RISER_TOTAL_RATIO of the tallest front pumpkin incl. stem, so the back
 * row's carved mouths clear the front row's bodies and stems. (Portrait
 * framing is width-limited, so the extra height costs no on-screen size.)
 */
export const RISER_RATIO = 0.72
export const RISER_TOTAL_RATIO = 0.8

export function arrangePumpkinGroup(members: readonly GroupMember[], gap = 0.16): GroupArrangement {
  const n = Math.max(0, Math.min(MAX_GROUP, members.length))
  const slots: GroupSlot[] = new Array(n)
  const risers: GroupRiser[] = []
  if (n === 0) return { slots: [], risers, min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } }

  const front = FRONT_INDICES[n]!
  const back = BACK_INDICES[n]!
  const pairX = (left: GroupMember, right: GroupMember) => [-(left.halfWidth + gap / 2), right.halfWidth + gap / 2] as const

  if (front.length === 1) {
    slots[front[0]!] = { x: 0, y: 0, z: 0, row: 'front' }
  } else {
    const [l, r] = front as [number, number]
    const [xl, xr] = pairX(members[l]!, members[r]!)
    slots[l] = { x: xl, y: 0, z: 0, row: 'front' }
    slots[r] = { x: xr, y: 0, z: 0, row: 'front' }
  }

  if (back.length > 0) {
    const frontBody = Math.max(...front.map((i) => members[i]!.bodyHeight))
    const frontTotal = Math.max(...front.map((i) => members[i]!.totalHeight))
    const frontDepth = Math.max(...front.map((i) => members[i]!.halfDepth))
    const backDepth = Math.max(...back.map((i) => members[i]!.halfDepth))
    const height = Math.max(frontBody * RISER_RATIO, frontTotal * RISER_TOTAL_RATIO)
    const z = -(frontDepth + backDepth + gap)
    if (back.length === 1) {
      slots[back[0]!] = { x: 0, y: height, z, row: 'back' }
    } else {
      const [l, r] = back as [number, number]
      const [xl, xr] = pairX(members[l]!, members[r]!)
      slots[l] = { x: xl, y: height, z, row: 'back' }
      slots[r] = { x: xr, y: height, z, row: 'back' }
    }
    const minX = Math.min(...back.map((i) => slots[i]!.x - members[i]!.halfWidth)) - 0.14
    const maxX = Math.max(...back.map((i) => slots[i]!.x + members[i]!.halfWidth)) + 0.14
    risers.push({ x: (minX + maxX) / 2, z, width: maxX - minX, depth: backDepth * 2 + 0.24, height })
  }

  const min = { x: Infinity, y: 0, z: Infinity }
  const max = { x: -Infinity, y: -Infinity, z: -Infinity }
  slots.forEach((s, i) => {
    const m = members[i]!
    min.x = Math.min(min.x, s.x - m.halfWidth)
    max.x = Math.max(max.x, s.x + m.halfWidth)
    min.z = Math.min(min.z, s.z - m.halfDepth)
    max.z = Math.max(max.z, s.z + m.halfDepth)
    max.y = Math.max(max.y, s.y + m.totalHeight)
  })
  for (const r of risers) {
    min.x = Math.min(min.x, r.x - r.width / 2)
    max.x = Math.max(max.x, r.x + r.width / 2)
    min.z = Math.min(min.z, r.z - r.depth / 2)
    max.z = Math.max(max.z, r.z + r.depth / 2)
  }
  return { slots, risers, min, max }
}

/** Per-person delay of the carving animation so pumpkins are carved one after another. */
export const GROUP_CARVE_STAGGER = 0.14
