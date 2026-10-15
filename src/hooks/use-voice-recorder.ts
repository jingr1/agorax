'use client'

import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import {
  createAudioRecorder,
  detectAudioRecordingSupport,
  formatMicrophoneAccessError,
  requestAudioStream,
  resolveAudioStream,
  startAudioRecorder,
} from '@/lib/voice-capture-support'

type RecorderState = 'idle' | 'recording' | 'processing'

type UseVoiceRecorderOptions = {
  /** Max recording duration in ms. Default: 120000 (2 min) */
  maxDurationMs?: number
  /** Called with the recorded audio blob + duration */
  onRecorded?: (blob: Blob, durationMs: number) => void
  onError?: (error: string) => void
}

type UseVoiceRecorderReturn = {
  state: RecorderState
  isRecording: boolean
  isSupported: boolean
  durationMs: number
  start: () => void
  stop: () => void
}

function formatVoiceRecorderError(error: unknown): string {
  return formatMicrophoneAccessError(error)
}

export function useVoiceRecorder(
  options: UseVoiceRecorderOptions = {},
): UseVoiceRecorderReturn {
  const { maxDurationMs = 120_000, onRecorded, onError } = options
  const [state, setState] = useState<RecorderState>('idle')
  const [durationMs, setDurationMs] = useState(0)
  const [isSupported, setIsSupported] = useState(false)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Array<Blob>>([])
  const mimeTypeRef = useRef('audio/mp4')
  const startTimeRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const maxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const callbacksRef = useRef({ onRecorded, onError })
  callbacksRef.current = { onRecorded, onError }

  useLayoutEffect(() => {
    setIsSupported(detectAudioRecordingSupport())
  }, [])

  const cleanup = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    if (maxTimerRef.current) {
      clearTimeout(maxTimerRef.current)
      maxTimerRef.current = null
    }
  }, [])

  const stop = useCallback(() => {
    const recorder = recorderRef.current
    if (!recorder || recorder.state === 'inactive') {
      setState('idle')
      return
    }
    recorder.stop()
    // Stream tracks cleanup
    recorder.stream.getTracks().forEach((t) => t.stop())
    cleanup()
  }, [cleanup])

  const start = useCallback(async () => {
    if (!detectAudioRecordingSupport()) {
      callbacksRef.current.onError?.('Audio recording not supported')
      return
    }

    // Stop any existing recording
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop()
      recorderRef.current.stream.getTracks().forEach((t) => t.stop())
    }
    cleanup()

    const streamPromise = resolveAudioStream()

    try {
      const stream = await streamPromise
      const { recorder, mimeType } = createAudioRecorder(stream)
      mimeTypeRef.current = mimeType
      chunksRef.current = []
      startTimeRef.current = Date.now()
      setDurationMs(0)

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data)
        }
      }

      recorder.onstop = () => {
        setState('processing')
        const blob = new Blob(chunksRef.current, { type: mimeTypeRef.current })
        const duration = Date.now() - startTimeRef.current
        chunksRef.current = []
        recorderRef.current = null
        setState('idle')

        if (blob.size > 0 && duration > 500) {
          callbacksRef.current.onRecorded?.(blob, duration)
        }
      }

      recorder.onerror = () => {
        callbacksRef.current.onError?.('Recording failed')
        setState('idle')
        cleanup()
      }

      recorderRef.current = recorder
      startAudioRecorder(recorder)
      setState('recording')

      // Duration counter
      timerRef.current = setInterval(() => {
        setDurationMs(Date.now() - startTimeRef.current)
      }, 100)

      // Max duration auto-stop
      maxTimerRef.current = setTimeout(() => {
        stop()
      }, maxDurationMs)
    } catch (err) {
      callbacksRef.current.onError?.(formatVoiceRecorderError(err))
      setState('idle')
    }
  }, [cleanup, stop, maxDurationMs])

  return {
    state,
    isRecording: state === 'recording',
    isSupported,
    durationMs,
    start,
    stop,
  }
}
