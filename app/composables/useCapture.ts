// Save / share of exported PNG blobs. Everything stays local: downloads use a
// blob: URL, sharing uses the OS share sheet only on an explicit user tap.

export type ShareOutcome = 'shared' | 'cancelled' | 'unsupported' | 'failed'

export function useCapture() {
  function download(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.rel = 'noopener'
    a.style.display = 'none'
    document.body.appendChild(a)
    a.click()
    a.remove()
    // keep the URL alive long enough for slow mobile download handlers
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }

  function toFile(blob: Blob, filename: string): File | null {
    try {
      return new File([blob], filename, { type: 'image/png' })
    } catch {
      return null
    }
  }

  function canShare(blob: Blob, filename: string): boolean {
    if (typeof navigator === 'undefined' || typeof navigator.share !== 'function' || typeof navigator.canShare !== 'function') {
      return false
    }
    const file = toFile(blob, filename)
    try {
      return !!file && navigator.canShare({ files: [file] })
    } catch {
      return false
    }
  }

  /** Must be called directly from a user gesture handler (transient activation). */
  async function share(blob: Blob, filename: string): Promise<ShareOutcome> {
    const file = toFile(blob, filename)
    if (!file || !canShare(blob, filename)) return 'unsupported'
    try {
      await navigator.share({ files: [file], title: 'カボチャウ' })
      return 'shared'
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return 'cancelled'
      return 'failed'
    }
  }

  return { download, canShare, share }
}
