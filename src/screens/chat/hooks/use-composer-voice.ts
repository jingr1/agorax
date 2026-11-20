import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useVoiceInput } from '@/hooks/use-voice-input';
import { useVoiceRecorder } from '@/hooks/use-voice-recorder';
import { detectMicrophoneBrowserSupport, detectSpeechRecognitionSupport, INSECURE_MICROPHONE_MESSAGE, isCoarsePointerDevice, isMicrophoneContextSecure, primeAudioStreamFromUserGesture } from '@/lib/voice-capture-support';
import { toast } from '@/components/ui/toast';
import type { Dispatch, SetStateAction } from 'react'
import type { ChatComposerAttachment } from '../components/chat-composer'
type ComposerVoiceContext = {
sttConfigQuery: { data?: { config?: Record<string, unknown> } }
sttStatusQuery: { data?: { provider?: unknown; remoteReady?: unknown; error?: unknown } }
setValue: Dispatch<SetStateAction<string>>
persistDraft: (nextValue: string) => void
setAttachments: Dispatch<SetStateAction<ChatComposerAttachment[]>>
isMobileViewport: boolean
value: string
}

export function useComposerVoice(context: ComposerVoiceContext) {
const { sttConfigQuery, sttStatusQuery, setValue, persistDraft, setAttachments, isMobileViewport, value } = context
const sttConfig =
    (sttConfigQuery.data?.config?.stt as Record<string, unknown> | undefined) ||
    {}

const sttProvider =
    typeof sttStatusQuery.data?.provider === 'string' &&
    sttStatusQuery.data.provider.trim()
      ? sttStatusQuery.data.provider.trim()
      : typeof sttConfig.provider === 'string'
        ? sttConfig.provider.trim()
        : 'local'

const useRemoteStt = sttStatusQuery.data?.remoteReady === true

const remoteSttError =
    typeof sttStatusQuery.data?.error === 'string'
      ? sttStatusQuery.data.error.trim()
      : ''

const appendTextToDraft = useCallback(
    (text: string, separator = ' ') => {
      const normalized = text.trim()
      if (!normalized) return
      setValue((prev) => {
        const next =
          prev.trim().length > 0
            ? `${prev}${separator}${normalized}`
            : normalized
        persistDraft(next)
        return next
      })
    },
    [persistDraft],
  )

const dictationDraftRef = useRef('')

const transcribeVoiceBlob = useCallback(async (blob: Blob) => {
    const form = new FormData()
    const extension = blob.type.includes('mp4') ? 'mp4' : 'webm'
    form.set('file', blob, `voice-input.${extension}`)

    const response = await fetch('/api/transcribe', {
      method: 'POST',
      body: form,
    })
    const payload = (await response.json().catch(() => ({}))) as {
      ok?: boolean
      text?: string
      error?: string
    }
    if (!response.ok || payload.ok === false) {
      throw new Error(
        payload.error || `Transcription failed (${response.status})`,
      )
    }
    return typeof payload.text === 'string' ? payload.text : ''
  }, [])

const voiceInput = useVoiceInput({
    transcribe: useRemoteStt ? transcribeVoiceBlob : undefined,
    onResult: useCallback(
      (text: string) => {
        const normalized = text.trim()
        if (!normalized) return
        const base = dictationDraftRef.current
        const next = base ? `${base} ${normalized}` : normalized
        setValue(next)
        persistDraft(next)
        dictationDraftRef.current = next.trim()
      },
      [persistDraft],
    ),
    onInterim: useCallback(
      (text: string) => {
        const base = dictationDraftRef.current
        const next = base ? `${base} ${text}` : text
        setValue(next)
        persistDraft(next)
      },
      [persistDraft],
    ),
    onError: useCallback(
      (error: string) => {
        const hint =
          remoteSttError && !useRemoteStt
            ? `${error} ${sttProvider === 'local' ? 'Local STT' : `Remote STT (${sttProvider})`} is not ready: ${remoteSttError}`
            : error || 'Voice transcription failed'
        toast(hint, { type: 'error' })
      },
      [remoteSttError, sttProvider, useRemoteStt],
    ),
  })

const voiceRecorder = useVoiceRecorder({
    onRecorded: useCallback(
      (blob: Blob, durationMs: number) => {
        const ext = blob.type.includes('webm') ? 'webm' : 'mp4'
        const name = `voice-note-${Date.now()}.${ext}`
        const reader = new FileReader()
        reader.onload = () => {
          const dataUrl = typeof reader.result === 'string' ? reader.result : ''
          if (!dataUrl) return
          const secs = Math.round(durationMs / 1000)
          setAttachments((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              name,
              contentType: blob.type || 'audio/webm',
              size: blob.size,
              dataUrl,
              previewUrl: '',
            },
          ])
          appendTextToDraft(`🎤 Voice note (${secs}s)`, '\n')
          if (useRemoteStt) {
            void transcribeVoiceBlob(blob)
              .then((text) => {
                if (text.trim()) {
                  appendTextToDraft(`Transcript: ${text.trim()}`, '\n')
                }
              })
              .catch((error) => {
                toast(
                  error instanceof Error
                    ? error.message
                    : 'Voice note transcription failed',
                  { type: 'error' },
                )
              })
          }
        }
        reader.readAsDataURL(blob)
      },
      [appendTextToDraft, transcribeVoiceBlob, useRemoteStt],
    ),
  })

const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current)
  }, [])

const isLongPressRef = useRef(false)

const skipMicClickRef = useRef(false)

const [micContextSecure, setMicContextSecure] = useState(true)

const [micBrowserSupported, setMicBrowserSupported] = useState(false)

useLayoutEffect(() => {
    setMicContextSecure(isMicrophoneContextSecure())
    setMicBrowserSupported(detectMicrophoneBrowserSupport())
  }, [])

const micCaptureAvailable =
    voiceInput.isSupported || voiceRecorder.isSupported

const micBlockedByInsecureContext = !micContextSecure

const micUsesLongPress = !isMobileViewport && !isCoarsePointerDevice()

const touchMicHandledRef = useRef(false)

const handleMicActivate = useCallback(() => {
    if (micBlockedByInsecureContext) {
      toast(INSECURE_MICROPHONE_MESSAGE, { type: 'error' })
      return
    }
    if (skipMicClickRef.current) {
      skipMicClickRef.current = false
      return
    }
    if (voiceInput.isListening) {
      voiceInput.stop()
      dictationDraftRef.current = ''
      return
    }
    if (voiceRecorder.isRecording) {
      voiceRecorder.stop()
      return
    }

    dictationDraftRef.current = value.trim()

    if (useRemoteStt && voiceInput.isSupported) {
      voiceInput.start()
      return
    }

    if (sttProvider === 'local' && !useRemoteStt) {
      toast(
        remoteSttError ||
          'Local STT needs faster-whisper on the Mac. Run `hermes doctor` to install it.',
        { type: 'error' },
      )
      return
    }

    if (detectSpeechRecognitionSupport()) {
      voiceInput.start()
      return
    }

    if (voiceRecorder.isSupported) {
      voiceRecorder.start()
      return
    }

    const hint =
      remoteSttError && !useRemoteStt
        ? sttProvider === 'local'
          ? `Local STT is not ready: ${remoteSttError}`
          : `Voice input needs OpenAI/Groq STT: ${remoteSttError}`
        : 'Voice input is not supported in this browser'
    toast(hint, { type: 'error' })
  }, [
    micBlockedByInsecureContext,
    remoteSttError,
    sttProvider,
    useRemoteStt,
    voiceInput,
    voiceRecorder,
  ])

const handleMicPointerDown = useCallback(
    (event: Pick<React.PointerEvent<HTMLButtonElement>, 'pointerType'>) => {
      if (micBlockedByInsecureContext) return

      if (event.pointerType === 'touch' || isCoarsePointerDevice()) {
        touchMicHandledRef.current = true
        if (voiceInput.isListening || voiceRecorder.isRecording) {
          handleMicActivate()
          return
        }
        primeAudioStreamFromUserGesture()
        handleMicActivate()
        return
      }

      if (!micUsesLongPress) return
      isLongPressRef.current = false
      if (!voiceInput.isListening && !voiceRecorder.isRecording) {
        longPressTimerRef.current = setTimeout(() => {
          isLongPressRef.current = true
          primeAudioStreamFromUserGesture()
          voiceRecorder.start()
        }, 500)
      }
    },
    [
      handleMicActivate,
      micBlockedByInsecureContext,
      micUsesLongPress,
      useRemoteStt,
      voiceRecorder,
      voiceInput.isListening,
    ],
  )

const handleMicPointerUp = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
    if (isLongPressRef.current) {
      voiceRecorder.stop()
      isLongPressRef.current = false
      skipMicClickRef.current = true
    }
  }, [voiceRecorder])

const handleMicClick = useCallback(
    (event?: React.MouseEvent<HTMLButtonElement>) => {
      if (touchMicHandledRef.current) {
        touchMicHandledRef.current = false
        event?.preventDefault()
        return
      }
      handleMicActivate()
    },
    [handleMicActivate],
  )

const micTooltip = micBlockedByInsecureContext
    ? 'Voice input needs HTTPS or localhost on this device'
    : voiceRecorder.isRecording
      ? `Recording… ${Math.round(voiceRecorder.durationMs / 1000)}s`
      : voiceInput.isListening
        ? useRemoteStt
          ? sttProvider === 'local'
            ? 'Recording — tap again to transcribe on Mac'
            : 'Recording — tap again to transcribe'
          : 'Listening — tap to stop'
        : useRemoteStt
          ? isMobileViewport
            ? sttProvider === 'local'
              ? 'Tap to record · tap again to transcribe on Mac'
              : 'Tap to record · tap again to transcribe'
            : 'Tap: dictate · Hold: voice note'
          : detectSpeechRecognitionSupport()
            ? isMobileViewport
              ? 'Tap to dictate · tap again to stop'
              : 'Tap: dictate · Hold: voice note'
            : 'Tap to record a voice note'
return { micCaptureAvailable, micBrowserSupported, handleMicClick, handleMicPointerDown, handleMicPointerUp, micBlockedByInsecureContext, voiceRecorder, voiceInput, micTooltip }
}
