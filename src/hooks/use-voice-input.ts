'use client'

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import {
  clearPrimedAudioStream,
  createAudioRecorder,
  detectAudioRecordingSupport,
  detectGetUserMediaSupport,
  detectSpeechRecognitionSupport,
  formatMicrophoneAccessError,
  formatSpeechRecognitionError,
  isCoarsePointerDevice,
  releaseHeldAudioStream,
  resolveAudioStream,
  resolveSpeechRecognitionLang,
  startAudioRecorder,
} from '@/lib/voice-capture-support'

type VoiceInputState = 'idle' | 'listening' | 'processing' | 'error'

type UseVoiceInputOptions = {
  lang?: string
  interim?: boolean
  transcribe?: (blob: Blob) => Promise<string>
  onResult?: (text: string) => void
  onInterim?: (text: string) => void
  onError?: (error: string) => void
}

type UseVoiceInputReturn = {
  state: VoiceInputState
  isListening: boolean
  isSupported: boolean
  transcript: string
  start: () => void
  stop: () => void
  toggle: () => void
}

type SpeechRecognitionInstance = any
type SpeechRecognitionConstructor = new () => SpeechRecognitionInstance

function getSpeechRecognition(): SpeechRecognitionConstructor | null {
  if (typeof window === 'undefined') return null

  const win = window as any
  return win.SpeechRecognition ?? win.webkitSpeechRecognition ?? null
}

function formatVoiceInputError(error: unknown): string {
  return formatMicrophoneAccessError(error)
}

export function useVoiceInput(
  options: UseVoiceInputOptions = {},
): UseVoiceInputReturn {
  const {
    lang = resolveSpeechRecognitionLang(),
    interim = true,
    transcribe,
    onResult,
    onInterim,
    onError,
  } = options
  const [state, setState] = useState<VoiceInputState>('idle')
  const [transcript, setTranscript] = useState('')
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const recordedChunksRef = useRef<Array<Blob>>([])
  const recorderMimeTypeRef = useRef('audio/mp4')
  const [isSupported, setIsSupported] = useState(false)
  const startInFlightRef = useRef(false)
  const speechStartTokenRef = useRef(0)
  const listenTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const speechStreamRef = useRef<MediaStream | null>(null)

  const releaseSpeechStream = useCallback(() => {
    releaseHeldAudioStream(speechStreamRef.current)
    speechStreamRef.current = null
  }, [])

  const callbacksRef = useRef({ onResult, onInterim, onError, transcribe })
  callbacksRef.current = { onResult, onInterim, onError, transcribe }

  const clearListenTimeout = useCallback(() => {
    if (listenTimeoutRef.current) {
      clearTimeout(listenTimeoutRef.current)
      listenTimeoutRef.current = null
    }
  }, [])

  const resetSpeechRecognition = useCallback(() => {
    const recognition = recognitionRef.current
    recognitionRef.current = null
    if (!recognition) return
    try {
      recognition.stop()
    } catch {
      /* */
    }
    try {
      recognition.abort?.()
    } catch {
      /* */
    }
  }, [])

  useLayoutEffect(() => {
    setIsSupported(
      transcribe
        ? detectAudioRecordingSupport()
        : detectSpeechRecognitionSupport(),
    )
  }, [transcribe])

  const cleanupRecorder = useCallback(() => {
    const recorder = recorderRef.current
    if (recorder) {
      recorder.stream.getTracks().forEach((track) => track.stop())
    }
    recorderRef.current = null
    recordedChunksRef.current = []
  }, [])

  const stop = useCallback(() => {
    startInFlightRef.current = false
    speechStartTokenRef.current += 1
    clearListenTimeout()
    clearPrimedAudioStream()
    releaseSpeechStream()

    if (callbacksRef.current.transcribe) {
      const recorder = recorderRef.current
      if (!recorder || recorder.state === 'inactive') {
        setState('idle')
        cleanupRecorder()
        return
      }
      setState('processing')
      recorder.stop()
      return
    }

    resetSpeechRecognition()
    setState('idle')
  }, [
    cleanupRecorder,
    clearListenTimeout,
    releaseSpeechStream,
    resetSpeechRecognition,
  ])

  const armListenTimeout = useCallback(() => {
    clearListenTimeout()
    listenTimeoutRef.current = setTimeout(() => {
      listenTimeoutRef.current = null
      stop()
    }, 60_000)
  }, [clearListenTimeout, stop])

  const start = useCallback(async () => {
    if (startInFlightRef.current) return

    if (callbacksRef.current.transcribe) {
      if (!detectAudioRecordingSupport()) {
        callbacksRef.current.onError?.(
          'Audio recording not supported in this browser',
        )
        setState('error')
        return
      }

      if (recorderRef.current && recorderRef.current.state !== 'inactive') {
        recorderRef.current.stop()
        cleanupRecorder()
      }

      // Create the getUserMedia promise immediately so mobile Chrome keeps
      // the user-gesture grant even across await boundaries.
      startInFlightRef.current = true
      setState('listening')
      armListenTimeout()
      const streamPromise = resolveAudioStream()

      try {
        const stream = await streamPromise
        const { recorder, mimeType } = createAudioRecorder(stream)
        recorderMimeTypeRef.current = mimeType
        recordedChunksRef.current = []

        recorder.onstart = () => {
          setState('listening')
          setTranscript('')
        }

        recorder.ondataavailable = (event) => {
          if (event.data.size > 0) {
            recordedChunksRef.current.push(event.data)
          }
        }

        recorder.onerror = () => {
          cleanupRecorder()
          setState('error')
          callbacksRef.current.onError?.('Recording failed')
        }

        recorder.onstop = async () => {
          const blob = new Blob(recordedChunksRef.current, {
            type: recorderMimeTypeRef.current,
          })
          cleanupRecorder()

          if (blob.size === 0) {
            setState('idle')
            return
          }

          setState('processing')
          try {
            const text = await callbacksRef.current.transcribe!(blob)
            const trimmed = text.trim()
            setTranscript(trimmed)
            if (trimmed) {
              callbacksRef.current.onResult?.(trimmed)
            }
            setState('idle')
          } catch (error) {
            setState('error')
            callbacksRef.current.onError?.(
              error instanceof Error ? error.message : 'Transcription failed',
            )
          }
        }

        recorderRef.current = recorder
        startAudioRecorder(recorder)
        return
      } catch (error) {
        startInFlightRef.current = false
        clearListenTimeout()
        setState('error')
        callbacksRef.current.onError?.(formatVoiceInputError(error))
        return
      }
    }

    startInFlightRef.current = true
    setState('listening')
    armListenTimeout()

    const SpeechRecognition = getSpeechRecognition()
    if (!SpeechRecognition) {
      startInFlightRef.current = false
      clearListenTimeout()
      callbacksRef.current.onError?.(
        'Live dictation is not supported in Safari. Hold the mic to record a voice note, or set STT to Groq/OpenAI in Settings.',
      )
      setState('error')
      return
    }

    const mobile = isCoarsePointerDevice()

    const beginRecognition = () => {
      if (!startInFlightRef.current || recognitionRef.current) return

      const recognition = new SpeechRecognition()
      recognition.lang = lang
      recognition.interimResults = interim
      // Keep listening until the user taps stop — required for reliable Android UX.
      recognition.continuous = true
      recognition.maxAlternatives = 1

      recognition.onstart = () => {
        startInFlightRef.current = false
        setState('listening')
        setTranscript('')
        armListenTimeout()
      }

      recognition.onresult = (event: any) => {
        let finalText = ''
        let interimText = ''

        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i]
          if (!result?.[0]) continue
          const text = result[0].transcript
          if (result.isFinal) {
            finalText += text
          } else {
            interimText += text
          }
        }

        if (finalText) {
          setTranscript((prev) => `${prev}${finalText}`)
          callbacksRef.current.onResult?.(finalText)
        }
        if (interimText) {
          callbacksRef.current.onInterim?.(interimText)
        }
      }

      recognition.onerror = (event: any) => {
        startInFlightRef.current = false
        clearListenTimeout()
        releaseSpeechStream()
        if (event.error === 'aborted' || event.error === 'no-speech') {
          setState('idle')
          recognitionRef.current = null
          return
        }
        setState('error')
        callbacksRef.current.onError?.(
          formatSpeechRecognitionError(event.error),
        )
        recognitionRef.current = null
      }

      recognition.onend = () => {
        startInFlightRef.current = false
        clearListenTimeout()
        releaseSpeechStream()
        setState('idle')
        recognitionRef.current = null
      }

      resetSpeechRecognition()

      recognitionRef.current = recognition
      try {
        recognition.start()
      } catch (error) {
        startInFlightRef.current = false
        clearListenTimeout()
        setState('error')
        callbacksRef.current.onError?.(formatVoiceInputError(error))
        recognitionRef.current = null
      }
    }

    // Android Chrome: request mic via getUserMedia in the pointerdown gesture,
    // keep the capture open, then start SpeechRecognition in the same activation chain.
    if (mobile && detectGetUserMediaSupport()) {
      const startToken = speechStartTokenRef.current
      const streamPromise = resolveAudioStream()

      const attachStreamAndStart = (stream: MediaStream) => {
        if (startToken !== speechStartTokenRef.current) {
          releaseHeldAudioStream(stream)
          return
        }
        releaseSpeechStream()
        speechStreamRef.current = stream
        beginRecognition()
      }

      void streamPromise.then(attachStreamAndStart).catch((error) => {
        if (startToken !== speechStartTokenRef.current) return
        startInFlightRef.current = false
        clearListenTimeout()
        releaseSpeechStream()
        setState('error')
        callbacksRef.current.onError?.(formatVoiceInputError(error))
      })

      // If mic was already allowed, start immediately in the gesture turn.
      beginRecognition()
      return
    }

    beginRecognition()
  }, [
    armListenTimeout,
    cleanupRecorder,
    clearListenTimeout,
    interim,
    lang,
    releaseSpeechStream,
    resetSpeechRecognition,
    stop,
  ])

  const toggle = useCallback(() => {
    if (state === 'listening') {
      stop()
    } else {
      void start()
    }
  }, [state, start, stop])

  useEffect(() => {
    return () => {
      clearListenTimeout()
      resetSpeechRecognition()
      releaseSpeechStream()
      if (recorderRef.current) {
        try {
          recorderRef.current.stop()
        } catch {
          /* */
        }
      }
      cleanupRecorder()
    }
  }, [
    cleanupRecorder,
    clearListenTimeout,
    releaseSpeechStream,
    resetSpeechRecognition,
  ])

  return {
    state,
    isListening: state === 'listening',
    isSupported,
    transcript,
    start: () => {
      void start()
    },
    stop,
    toggle,
  }
}
