// Camera lifecycle: permission, constraints with fallbacks, error mapping,
// track-ended recovery and guaranteed cleanup (no orphaned video tracks).
import { onBeforeUnmount, ref, shallowRef } from 'vue'

export type CameraState = 'idle' | 'requesting' | 'active' | 'denied' | 'unavailable' | 'busy' | 'insecure' | 'ended'

const CONSTRAINT_LADDER: MediaStreamConstraints[] = [
  {
    audio: false,
    video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } },
  },
  { audio: false, video: { facingMode: 'user' } },
  { audio: false, video: true },
]

function mapError(e: unknown): CameraState {
  const name = e instanceof DOMException || e instanceof Error ? e.name : ''
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') return 'denied'
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') return 'busy'
  return 'unavailable'
}

export function useCamera() {
  const state = ref<CameraState>('idle')
  const stream = shallowRef<MediaStream | null>(null)
  let video: HTMLVideoElement | null = null
  let generation = 0

  function stop(): void {
    generation++
    const s = stream.value
    if (s) for (const track of s.getTracks()) track.stop()
    stream.value = null
    if (video) {
      video.pause()
      video.srcObject = null
    }
    if (state.value === 'active' || state.value === 'requesting') state.value = 'idle'
  }

  async function start(el: HTMLVideoElement): Promise<boolean> {
    stop()
    const myGeneration = ++generation
    video = el
    if (typeof window === 'undefined') return false
    if (!window.isSecureContext) {
      state.value = 'insecure'
      return false
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      state.value = 'unavailable'
      return false
    }
    state.value = 'requesting'
    let s: MediaStream | null = null
    let lastError: unknown = null
    for (const constraints of CONSTRAINT_LADDER) {
      try {
        s = await navigator.mediaDevices.getUserMedia(constraints)
        break
      } catch (e) {
        lastError = e
        const mapped = mapError(e)
        // permission problems will not be fixed by relaxing constraints
        if (mapped === 'denied' || mapped === 'busy') break
      }
    }
    if (myGeneration !== generation) {
      s?.getTracks().forEach((t) => t.stop())
      return false
    }
    if (!s) {
      state.value = mapError(lastError)
      return false
    }
    stream.value = s
    for (const track of s.getVideoTracks()) {
      track.addEventListener('ended', () => {
        if (stream.value === s) state.value = 'ended'
      })
    }
    el.muted = true
    el.playsInline = true
    el.setAttribute('playsinline', '')
    el.setAttribute('muted', '')
    el.srcObject = s
    try {
      await el.play()
    } catch {
      // autoplay quirks: metadata wait below still resolves once frames flow
    }
    const ok = await new Promise<boolean>((resolve) => {
      if (el.videoWidth > 0) return resolve(true)
      const done = (v: boolean) => {
        el.removeEventListener('loadeddata', onData)
        clearTimeout(timer)
        resolve(v)
      }
      const onData = () => done(el.videoWidth > 0)
      el.addEventListener('loadeddata', onData)
      const timer = setTimeout(() => done(el.videoWidth > 0), 8000)
    })
    if (myGeneration !== generation) return false
    if (!ok) {
      stop()
      state.value = 'unavailable'
      return false
    }
    state.value = 'active'
    return true
  }

  onBeforeUnmount(stop)

  return { state, stream, start, stop }
}
