// Stamp board state for the result view: placed stamps (bottom → top) and the
// current selection. Purely local; nothing here leaves the device.
import { computed, ref } from 'vue'
import { STICKER_BY_ID, type StickerId } from '~/utils/stickerCatalog'
import { MAX_STICKERS, createSticker, stickersSignature, type PlacedSticker } from '~/utils/stickers'

export function useStickers() {
  const items = ref<PlacedSticker[]>([])
  const selectedId = ref<string | null>(null)
  let seq = 0

  const selected = computed(() => items.value.find((s) => s.uid === selectedId.value) ?? null)
  const signature = computed(() => stickersSignature(items.value))
  const full = computed(() => items.value.length >= MAX_STICKERS)

  function add(type: StickerId): PlacedSticker | null {
    const def = STICKER_BY_ID[type]
    if (!def || full.value) return null
    const s = createSticker(def, items.value.length, `st${++seq}`)
    items.value = [...items.value, s]
    selectedId.value = s.uid
    return s
  }

  function update(next: PlacedSticker): void {
    items.value = items.value.map((s) => (s.uid === next.uid ? next : s))
  }

  function remove(uid: string): void {
    items.value = items.value.filter((s) => s.uid !== uid)
    if (selectedId.value === uid) selectedId.value = null
  }

  /** Selects a stamp and moves it to the top of the stack. */
  function pick(uid: string): void {
    selectedId.value = uid
    const i = items.value.findIndex((s) => s.uid === uid)
    if (i >= 0 && i < items.value.length - 1) {
      const list = items.value.slice()
      const [s] = list.splice(i, 1)
      list.push(s!)
      items.value = list
    }
  }

  function clear(): void {
    items.value = []
    selectedId.value = null
  }

  return { items, selectedId, selected, signature, full, add, update, remove, pick, clear }
}

export type StickerBoard = ReturnType<typeof useStickers>
