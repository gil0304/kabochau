// Halloween stamps for decorating a result before it is saved.
//
// Every stamp is plain vector data (SVG path strings + text runs) so that the
// SAME definition is drawn twice: as inline <svg> in the editor and with
// Canvas 2D (Path2D / fillText) into the exported PNG. No image files are
// loaded, so nothing can taint the export canvas and nothing hits the network.
//
// Draw order per stamp: (1) every layer flagged `outline` is stroked with the
// stamp's outline colour (a die-cut sticker edge), (2) all layers are painted
// in order. Text layers paint their own `stroke` first, then the fill.

export type StickerId =
  | 'happy-halloween'
  | 'trick-or-treat'
  | 'boo'
  | 'jack'
  | 'ghost'
  | 'bat'
  | 'cat'
  | 'witch-hat'
  | 'moon'
  | 'candy'
  | 'candy-corn'
  | 'skull'
  | 'spider'
  | 'web'
  | 'sparkles'

export interface StickerPathLayer {
  kind: 'path'
  d: string
  fill?: string
  stroke?: string
  strokeWidth?: number
  fillRule?: 'nonzero' | 'evenodd'
  opacity?: number
  outline?: boolean
}

export interface StickerTextLayer {
  kind: 'text'
  text: string
  /** centre x and alphabetic baseline y, in viewBox units */
  x: number
  y: number
  size: number
  /** the run is stretched / condensed to exactly this width (font metrics differ per OS) */
  width: number
  fill: string
  stroke?: string
  strokeWidth?: number
  outline?: boolean
}

export type StickerLayer = StickerPathLayer | StickerTextLayer

export interface StickerDef {
  id: StickerId
  /** Japanese name used for accessible labels */
  label: string
  /** viewBox size */
  width: number
  height: number
  /** initial width as a fraction of the image width */
  defaultWidth: number
  outline: { color: string; width: number } | null
  layers: readonly StickerLayer[]
}

export const STICKER_FONT_FAMILY = '"Arial Black", "Avenir Next", "Helvetica Neue", "Hiragino Sans", system-ui, sans-serif'
export const STICKER_FONT_WEIGHT = 900

const CUT = '#fff6ea'
const INK = '#1d1027'
const PUMPKIN = '#ff8a1f'
const GOLD = '#ffd27a'
const PLUM = '#2a1736'

const r2 = (n: number) => Math.round(n * 100) / 100

function ellipse(cx: number, cy: number, rx: number, ry: number): string {
  return `M${r2(cx - rx)} ${r2(cy)} A${rx} ${ry} 0 1 0 ${r2(cx + rx)} ${r2(cy)} A${rx} ${ry} 0 1 0 ${r2(cx - rx)} ${r2(cy)} Z`
}

const circle = (cx: number, cy: number, r: number) => ellipse(cx, cy, r, r)

/** Four-point sparkle with concave sides. */
function sparkle(cx: number, cy: number, r: number): string {
  const k = r * 0.18
  const p = (x: number, y: number) => `${r2(x)} ${r2(y)}`
  return (
    `M${p(cx, cy - r)} Q${p(cx + k, cy - k)} ${p(cx + r, cy)} Q${p(cx + k, cy + k)} ${p(cx, cy + r)} ` +
    `Q${p(cx - k, cy + k)} ${p(cx - r, cy)} Q${p(cx - k, cy - k)} ${p(cx, cy - r)} Z`
  )
}

/** Corner cobweb: spokes from the top-left corner and sagging rings. */
function cobweb(): string {
  const o = { x: 3, y: 3 }
  const ends = [
    { x: 97, y: 10 },
    { x: 93, y: 45 },
    { x: 71, y: 71 },
    { x: 45, y: 93 },
    { x: 10, y: 97 },
  ]
  const at = (e: { x: number; y: number }, t: number) => ({ x: o.x + (e.x - o.x) * t, y: o.y + (e.y - o.y) * t })
  let d = ends.map((e) => `M${o.x} ${o.y} L${e.x} ${e.y}`).join(' ')
  for (const t of [0.3, 0.55, 0.8, 0.98]) {
    const pts = ends.map((e) => at(e, t))
    d += ` M${r2(pts[0]!.x)} ${r2(pts[0]!.y)}`
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]!
      const b = pts[i]!
      // pull the midpoint toward the corner so each strand sags
      const c = { x: o.x + ((a.x + b.x) / 2 - o.x) * 0.84, y: o.y + ((a.y + b.y) / 2 - o.y) * 0.84 }
      d += ` Q${r2(c.x)} ${r2(c.y)} ${r2(b.x)} ${r2(b.y)}`
    }
  }
  return d
}

const text = (t: Omit<StickerTextLayer, 'kind'>): StickerTextLayer => ({ kind: 'text', ...t })
const path = (p: Omit<StickerPathLayer, 'kind'>): StickerPathLayer => ({ kind: 'path', ...p })

export const STICKERS: readonly StickerDef[] = [
  {
    id: 'happy-halloween',
    label: 'HAPPY HALLOWEEN の文字',
    width: 300,
    height: 112,
    defaultWidth: 0.72,
    outline: { color: CUT, width: 4 },
    layers: [
      text({ text: 'HAPPY', x: 150, y: 46, size: 40, width: 150, fill: GOLD, stroke: PLUM, strokeWidth: 9, outline: true }),
      text({ text: 'HALLOWEEN', x: 150, y: 98, size: 52, width: 278, fill: PUMPKIN, stroke: PLUM, strokeWidth: 10, outline: true }),
    ],
  },
  {
    id: 'trick-or-treat',
    label: 'TRICK OR TREAT の文字',
    width: 300,
    height: 112,
    defaultWidth: 0.62,
    outline: { color: CUT, width: 4 },
    layers: [
      text({ text: 'TRICK OR', x: 150, y: 48, size: 44, width: 236, fill: PUMPKIN, stroke: PLUM, strokeWidth: 9, outline: true }),
      text({ text: 'TREAT!', x: 150, y: 99, size: 50, width: 196, fill: GOLD, stroke: PLUM, strokeWidth: 10, outline: true }),
    ],
  },
  {
    id: 'boo',
    label: 'BOO! の文字',
    width: 160,
    height: 92,
    defaultWidth: 0.4,
    outline: { color: PUMPKIN, width: 4 },
    layers: [text({ text: 'BOO!', x: 80, y: 74, size: 70, width: 138, fill: CUT, stroke: PLUM, strokeWidth: 10, outline: true })],
  },
  {
    id: 'jack',
    label: 'ジャック・オー・ランタン',
    width: 100,
    height: 100,
    defaultWidth: 0.26,
    outline: { color: CUT, width: 4.5 },
    layers: [
      path({ d: 'M45 26 C45 17 48 10 55 6 L60 11 C55 14 53 19 54 26 Z', fill: '#5d7a2c', outline: true }),
      path({ d: 'M50 24 C34 16 8 26 8 56 C8 82 28 94 50 90 C72 94 92 82 92 56 C92 26 66 16 50 24 Z', fill: PUMPKIN, outline: true }),
      path({ d: 'M50 26 C41 42 41 76 50 89 M34 21 C22 36 21 74 33 90 M66 21 C78 36 79 74 67 90', stroke: '#c4520b', strokeWidth: 2.5, opacity: 0.75 }),
      path({ d: 'M24 50 L40 40 L42 55 Z M76 50 L60 40 L58 55 Z M50 55 L45 64 L55 64 Z', fill: '#ffe08a' }),
      path({ d: 'M24 66 C32 82 68 82 76 66 L67 70 L62 66 L56 72 L50 67 L44 72 L38 66 L33 70 Z', fill: '#ffe08a' }),
    ],
  },
  {
    id: 'ghost',
    label: 'おばけ',
    width: 100,
    height: 100,
    defaultWidth: 0.26,
    outline: { color: PLUM, width: 3.5 },
    layers: [
      path({ d: 'M17 50 C9 47 4 53 6 58 C10 56 14 58 17 61 Z M83 50 C91 47 96 53 94 58 C90 56 86 58 83 61 Z', fill: '#f6f1ff', outline: true }),
      path({
        d: 'M50 8 C27 8 16 26 16 48 L16 84 C16 90 20 92 24 88 L30 82 L37 90 C40 93 43 93 46 90 L50 85 L54 90 C57 93 60 93 63 90 L70 82 L76 88 C80 92 84 90 84 84 L84 48 C84 26 73 8 50 8 Z',
        fill: '#f6f1ff',
        outline: true,
      }),
      path({ d: `${ellipse(36, 42, 5, 7)} ${ellipse(64, 42, 5, 7)} ${ellipse(50, 60, 6, 8)}`, fill: INK }),
      path({ d: `${ellipse(25, 54, 5, 3)} ${ellipse(75, 54, 5, 3)}`, fill: '#ff9fc0', opacity: 0.75 }),
    ],
  },
  {
    id: 'bat',
    label: 'コウモリ',
    width: 120,
    height: 70,
    defaultWidth: 0.34,
    outline: { color: CUT, width: 3.5 },
    layers: [
      path({
        d: 'M60 17 L54 8 L52 20 C47 22 45 26 44 30 C38 22 26 15 6 18 C14 23 18 30 16 38 C22 34 28 36 31 42 C35 38 41 40 43 46 C47 43 52 46 54 51 L60 60 L66 51 C68 46 73 43 77 46 C79 40 85 38 89 42 C92 36 98 34 104 38 C102 30 106 23 114 18 C94 15 82 22 76 30 C75 26 73 22 68 20 L66 8 Z',
        fill: PLUM,
        outline: true,
      }),
      path({ d: `${circle(56.5, 26, 2.6)} ${circle(63.5, 26, 2.6)}`, fill: GOLD }),
      path({ d: 'M57 33 L58.5 36.5 L60 33 Z M60 33 L61.5 36.5 L63 33 Z', fill: CUT }),
    ],
  },
  {
    id: 'cat',
    label: '黒猫',
    width: 80,
    height: 100,
    defaultWidth: 0.22,
    outline: { color: CUT, width: 3.5 },
    layers: [
      path({ d: 'M64 92 C76 92 80 80 74 69 C72 66 69 68 70 71 C74 79 72 86 62 87 Z', fill: '#17111c', outline: true }),
      path({
        d: 'M22 40 L18 14 L32 26 C37 24 43 24 48 26 L62 14 L58 40 C60 46 58 52 54 56 C64 62 70 74 68 90 L68 96 L12 96 L12 90 C10 74 16 62 26 56 C22 52 20 46 22 40 Z',
        fill: '#17111c',
        outline: true,
      }),
      path({ d: 'M28 40 C30 36 36 36 38 40 C36 44 30 44 28 40 Z M42 40 C44 36 50 36 52 40 C50 44 44 44 42 40 Z', fill: '#ffd23a' }),
      path({ d: `${ellipse(33.2, 40, 1.2, 3)} ${ellipse(47.2, 40, 1.2, 3)}`, fill: '#17111c' }),
      path({ d: 'M38.5 47 L41.5 47 L40 49 Z', fill: '#ff9fb0' }),
    ],
  },
  {
    id: 'witch-hat',
    label: '魔女の帽子',
    width: 100,
    height: 100,
    defaultWidth: 0.3,
    outline: { color: CUT, width: 4 },
    layers: [
      path({ d: 'M6 78 C6 70 30 66 50 66 C70 66 94 70 94 78 C94 86 70 89 50 89 C30 89 6 86 6 78 Z', fill: '#3a1d52', outline: true }),
      path({ d: 'M30 72 C34 54 38 36 46 22 C52 12 62 6 76 8 C67 12 62 18 60 27 C64 42 68 58 72 72 C60 76 40 76 30 72 Z', fill: '#4a2668', outline: true }),
      path({ d: 'M32 64 C44 68 58 68 70 64 L72 72 C60 76 40 76 30 72 Z', fill: PUMPKIN }),
      path({ d: 'M45 63 L55 63 L55 73 L45 73 Z M48 66 L48 70 L52 70 L52 66 Z', fill: GOLD, fillRule: 'evenodd' }),
      path({ d: sparkle(50, 44, 6), fill: GOLD }),
    ],
  },
  {
    id: 'moon',
    label: '三日月',
    width: 100,
    height: 100,
    defaultWidth: 0.24,
    outline: { color: PLUM, width: 3 },
    layers: [
      path({ d: 'M62 12 A40 40 0 1 0 88 66 A32 32 0 0 1 62 12 Z', fill: '#ffd98a', outline: true }),
      path({ d: `${circle(32, 40, 4)} ${circle(40, 66, 6)} ${circle(24, 58, 3)}`, fill: '#efbd57', opacity: 0.85 }),
    ],
  },
  {
    id: 'candy',
    label: 'キャンディ',
    width: 120,
    height: 64,
    defaultWidth: 0.28,
    outline: { color: CUT, width: 3.5 },
    layers: [
      path({ d: 'M40 32 L12 12 C8 22 8 42 12 52 Z M80 32 L108 12 C112 22 112 42 108 52 Z', fill: PUMPKIN, outline: true }),
      path({ d: circle(60, 32, 22), fill: '#9b4dff', outline: true }),
      path({ d: 'M49 15.5 C57 24 57 40 49 48.5 M62 12 C71 22 71 42 62 52', stroke: CUT, strokeWidth: 4.5 }),
      path({ d: ellipse(52, 21, 4, 2.5), fill: '#ffffff', opacity: 0.55 }),
    ],
  },
  {
    id: 'candy-corn',
    label: 'キャンディコーン',
    width: 60,
    height: 80,
    defaultWidth: 0.13,
    outline: { color: CUT, width: 3.5 },
    layers: [
      path({ d: 'M30 4 C36 4 56 60 54 70 C52 78 8 78 6 70 C4 60 24 4 30 4 Z', fill: '#ffd23a', outline: true }),
      path({ d: 'M30 4 C36 4 50 40 52.5 56 C40 59 20 59 7.5 56 C10 40 24 4 30 4 Z', fill: PUMPKIN }),
      path({ d: 'M30 4 C34 4 42 22 44 30 C36 32 24 32 16 30 C18 22 26 4 30 4 Z', fill: CUT }),
    ],
  },
  {
    id: 'skull',
    label: 'ドクロ',
    width: 100,
    height: 100,
    defaultWidth: 0.22,
    outline: { color: PLUM, width: 3.5 },
    layers: [
      path({
        d: 'M50 10 C28 10 14 26 14 46 C14 58 20 66 28 70 L28 82 C28 86 31 88 35 88 L65 88 C69 88 72 86 72 82 L72 70 C80 66 86 58 86 46 C86 26 72 10 50 10 Z',
        fill: '#f4ecdf',
        outline: true,
      }),
      path({
        d: 'M26 46 C26 38 34 36 40 40 C44 44 42 54 34 56 C28 56 26 52 26 46 Z M74 46 C74 38 66 36 60 40 C56 44 58 54 66 56 C72 56 74 52 74 46 Z',
        fill: '#24131f',
      }),
      path({ d: 'M50 57 C48 61 45 64 46 66 C47 68 50 67 50 65 C50 67 53 68 54 66 C55 64 52 61 50 57 Z', fill: '#24131f' }),
      path({ d: 'M32 76 L68 76 M38 76 L38 87 M46 76 L46 87 M54 76 L54 87 M62 76 L62 87', stroke: '#24131f', strokeWidth: 2.5 }),
    ],
  },
  {
    id: 'spider',
    label: 'クモ',
    width: 80,
    height: 100,
    defaultWidth: 0.17,
    outline: { color: CUT, width: 2.5 },
    layers: [
      path({ d: 'M40 0 L40 46', stroke: '#e9e2f0', strokeWidth: 1.5 }),
      path({
        d:
          'M34 58 C26 50 20 50 12 42 M33 61 C24 58 16 59 8 56 M33 65 C24 68 17 71 10 75 M35 69 C29 76 25 82 21 90 ' +
          'M46 58 C54 50 60 50 68 42 M47 61 C56 58 64 59 72 56 M47 65 C56 68 63 71 70 75 M45 69 C51 76 55 82 59 90',
        stroke: '#1b1020',
        strokeWidth: 3.5,
        outline: true,
      }),
      path({ d: `${circle(40, 50, 7)} ${circle(40, 65, 12)}`, fill: '#1b1020', outline: true }),
      path({ d: `${circle(37, 49, 2.2)} ${circle(43, 49, 2.2)}`, fill: CUT }),
      path({ d: `${circle(37.4, 49.6, 1)} ${circle(43.4, 49.6, 1)}`, fill: '#1b1020' }),
    ],
  },
  {
    id: 'web',
    label: 'クモの巣',
    width: 100,
    height: 100,
    defaultWidth: 0.36,
    outline: { color: PLUM, width: 1.1 },
    layers: [path({ d: cobweb(), stroke: '#efe8f7', strokeWidth: 1.8, outline: true })],
  },
  {
    id: 'sparkles',
    label: 'キラキラ',
    width: 100,
    height: 100,
    defaultWidth: 0.18,
    outline: { color: PLUM, width: 3.5 },
    layers: [path({ d: `${sparkle(40, 58, 34)} ${sparkle(78, 22, 16)} ${sparkle(80, 80, 10)}`, fill: GOLD, outline: true })],
  },
]

export const STICKER_BY_ID: Readonly<Record<StickerId, StickerDef>> = Object.fromEntries(STICKERS.map((s) => [s.id, s])) as Record<
  StickerId,
  StickerDef
>

export function isStickerId(v: string): v is StickerId {
  return Object.prototype.hasOwnProperty.call(STICKER_BY_ID, v)
}
