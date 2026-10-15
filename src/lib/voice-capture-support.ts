/**
 * Browser voice-capture capability detection.
 *
 * Desktop Safari has no Web Speech API, so the mic button must be gated on
 * MediaRecorder / getUserMedia instead. Safari also leaves `mediaDevices`
 * undefined during SSR and sometimes on the first client tick, so callers
 * should read these helpers after mount (useLayoutEffect).
 */

type NavigatorWithLegacyMedia = Navigator & {
  webkitGetUserMedia?: (
    constraints: MediaStreamConstraints,
    success: (stream: MediaStream) => void,
    error: (error: Error) => void,
  ) => void
  getUserMedia?: (
    constraints: MediaStreamConstraints,
    success: (stream: MediaStream) => void,
    error: (error: Error) => void,
  ) => void
}

const AUDIO_MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/aac',
] as const

function getNavigator(): NavigatorWithLegacyMedia | null {
  if (typeof navigator === 'undefined') return null
  return navigator as NavigatorWithLegacyMedia
}

/** Browsers only expose getUserMedia on secure origins (HTTPS or localhost). */
export function isMicrophoneContextSecure(): boolean {
  if (typeof window === 'undefined') return false
  return window.isSecureContext
}

export const INSECURE_MICROPHONE_MESSAGE =
  'Microphone requires HTTPS or localhost. Browsers block mic access on HTTP remote IPs (for example Tailscale). Open http://127.0.0.1:6734 on this Mac, or serve Agorax over HTTPS.'

type MicrophonePlatform = 'ios' | 'android' | 'macos' | 'desktop'

export function detectMicrophonePlatform(): MicrophonePlatform {
  const nav = getNavigator()
  const ua = nav?.userAgent ?? ''
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios'
  if (/Android/i.test(ua)) return 'android'
  if (/Macintosh|Mac OS X/i.test(ua)) return 'macos'
  return 'desktop'
}

export function microphonePermissionHelpMessage(): string {
  switch (detectMicrophonePlatform()) {
    case 'ios':
      return 'Microphone blocked — on iPhone: Settings → Safari → Microphone → Allow, then reload this page. If you denied the popup earlier, also check Settings → Privacy & Security → Microphone → Safari.'
    case 'android':
      return 'Microphone blocked — in Chrome tap the lock icon (left of the URL) → Microphone → Allow, then reload. If still blocked: Android Settings → Apps → Chrome → Permissions → Microphone → Allow.'
    case 'macos':
      return 'Microphone blocked — allow it in the browser site settings and System Settings → Privacy & Security → Microphone.'
    default:
      return 'Microphone blocked — allow it in your browser site settings and system privacy settings for the microphone.'
  }
}

export function formatMicrophoneAccessError(error: unknown): string {
  if (!isMicrophoneContextSecure()) {
    return INSECURE_MICROPHONE_MESSAGE
  }
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
      return microphonePermissionHelpMessage()
    }
    if (error.name === 'NotFoundError') {
      return 'No microphone detected'
    }
    if (error.message?.trim()) return error.message
    return error.name
  }
  if (typeof error === 'string') {
    return formatSpeechRecognitionError(error)
  }
  if (error instanceof Error && error.message.trim()) return error.message
  return 'Microphone access denied'
}

/** Web Speech API error codes (Chrome/Android/iOS). */
export function formatSpeechRecognitionError(error: string): string {
  switch (error) {
    case 'not-allowed':
    case 'service-not-allowed':
      return detectMicrophonePlatform() === 'android'
        ? 'Speech recognition blocked — tap the lock icon next to the URL → Microphone → Allow, then reload this page. If it already says Allow, force-close Chrome and reopen, or check Android Settings → Apps → Chrome → Permissions → Microphone.'
        : microphonePermissionHelpMessage()
    case 'audio-capture':
      return microphonePermissionHelpMessage()
    case 'network':
      return 'Speech recognition needs internet access. Chrome sends audio to Google — check your network or VPN.'
    case 'no-speech':
      return 'No speech detected. Try speaking closer to the microphone.'
    case 'aborted':
      return 'Speech recognition was interrupted.'
    default:
      return error.trim() || 'Speech recognition failed'
  }
}

export function detectMicrophoneBrowserSupport(): boolean {
  if (typeof window === 'undefined') return false
  if (typeof MediaRecorder !== 'undefined') return true
  const win = window as Window & {
    SpeechRecognition?: unknown
    webkitSpeechRecognition?: unknown
  }
  if (win.SpeechRecognition || win.webkitSpeechRecognition) return true
  const nav = getNavigator()
  if (!nav) return false
  try {
    if (typeof nav.mediaDevices?.getUserMedia === 'function') return true
    if (typeof nav.webkitGetUserMedia === 'function') return true
    if (typeof nav.getUserMedia === 'function') return true
  } catch {
    return false
  }
  return false
}

export function detectSpeechRecognitionSupport(): boolean {
  if (!detectMicrophoneBrowserSupport()) return false
  if (!isMicrophoneContextSecure()) return false
  const win = window as Window & {
    SpeechRecognition?: unknown
    webkitSpeechRecognition?: unknown
  }
  return Boolean(win.SpeechRecognition || win.webkitSpeechRecognition)
}

/** BCP-47 tag for Web Speech API; defaults to browser locale instead of en-US. */
export function resolveSpeechRecognitionLang(): string {
  const nav = getNavigator()
  const browserLang = nav?.language?.trim()
  if (browserLang) return browserLang
  return 'en-US'
}

/** Touch-first devices (phones/tablets). Used to avoid long-press record timers that lose iOS user activation. */
export function isCoarsePointerDevice(): boolean {
  if (typeof window === 'undefined') return false
  return window.matchMedia('(pointer: coarse)').matches
}

export function detectGetUserMediaSupport(): boolean {
  if (!isMicrophoneContextSecure()) return false
  const nav = getNavigator()
  if (!nav) return false
  try {
    if (typeof nav.mediaDevices?.getUserMedia === 'function') return true
    if (typeof nav.webkitGetUserMedia === 'function') return true
    if (typeof nav.getUserMedia === 'function') return true
    return false
  } catch {
    return false
  }
}

export function detectAudioRecordingSupport(): boolean {
  if (!detectMicrophoneBrowserSupport()) return false
  if (!isMicrophoneContextSecure()) return false
  if (typeof MediaRecorder === 'undefined') {
    return detectGetUserMediaSupport()
  }
  // Safari can expose MediaRecorder while lazily initializing mediaDevices.
  // Treat either API as enough to show the mic; click-time errors stay explicit.
  return true
}

export async function requestAudioStream(): Promise<MediaStream> {
  if (!isMicrophoneContextSecure()) {
    throw new DOMException(INSECURE_MICROPHONE_MESSAGE, 'SecurityError')
  }

  const nav = getNavigator()
  if (!nav) {
    throw new DOMException(
      'Microphone APIs are unavailable',
      'NotSupportedError',
    )
  }

  if (typeof nav.mediaDevices?.getUserMedia === 'function') {
    return nav.mediaDevices.getUserMedia({ audio: true })
  }

  const legacy = nav.webkitGetUserMedia ?? nav.getUserMedia
  if (typeof legacy === 'function') {
    return new Promise<MediaStream>((resolve, reject) => {
      legacy.call(nav, { audio: true }, resolve, reject)
    })
  }

  throw new DOMException(
    'Microphone APIs are unavailable in this browser',
    'NotSupportedError',
  )
}

/**
 * Mobile browsers require getUserMedia to be requested inside the user-gesture
 * handler (pointerdown/touchstart). Call this synchronously on pointerdown,
 * then await resolveAudioStream() in the async record pipeline.
 */
let primedAudioStreamPromise: Promise<MediaStream> | null = null

export function primeAudioStreamFromUserGesture(): void {
  if (!detectGetUserMediaSupport()) return
  primedAudioStreamPromise = requestAudioStream()
}

export function clearPrimedAudioStream(): void {
  primedAudioStreamPromise = null
}

/** Stop tracks held open for Web Speech API (Android needs an active capture). */
export function releaseHeldAudioStream(
  stream: MediaStream | null | undefined,
): void {
  if (!stream) return
  stream.getTracks().forEach((track) => track.stop())
}

export async function resolveAudioStream(): Promise<MediaStream> {
  const primed = primedAudioStreamPromise
  primedAudioStreamPromise = null
  if (primed) return primed
  return requestAudioStream()
}

export function createAudioRecorder(stream: MediaStream): {
  recorder: MediaRecorder
  mimeType: string
} {
  for (const mimeType of AUDIO_MIME_CANDIDATES) {
    try {
      if (
        typeof MediaRecorder.isTypeSupported === 'function' &&
        !MediaRecorder.isTypeSupported(mimeType)
      ) {
        continue
      }
      return { recorder: new MediaRecorder(stream, { mimeType }), mimeType }
    } catch {
      // Safari may report a type as supported then reject the constructor.
    }
  }

  const recorder = new MediaRecorder(stream)
  return { recorder, mimeType: recorder.mimeType || 'audio/mp4' }
}

export function startAudioRecorder(
  recorder: MediaRecorder,
  timesliceMs = 100,
): void {
  try {
    recorder.start(timesliceMs)
  } catch {
    // Safari ignores or rejects timeslice on some versions.
    recorder.start()
  }
}
