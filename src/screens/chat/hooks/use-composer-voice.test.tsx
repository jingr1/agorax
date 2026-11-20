import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { useComposerVoice } from './use-composer-voice'
import type { useVoiceInput } from '@/hooks/use-voice-input'

const controls = vi.hoisted(() => ({ startDictation: vi.fn(), stopDictation: vi.fn(), startRecording: vi.fn(), stopRecording: vi.fn() }))
let voiceOptions: Parameters<typeof useVoiceInput>[0]
vi.mock('@/hooks/use-voice-input', () => ({ useVoiceInput: (options: Parameters<typeof useVoiceInput>[0]) => {
  voiceOptions = options
  return { isSupported: true, isListening: false, start: controls.startDictation, stop: controls.stopDictation }
} }))
vi.mock('@/hooks/use-voice-recorder', () => ({ useVoiceRecorder: () => ({ isSupported: true, isRecording: false, durationMs: 0, start: controls.startRecording, stop: controls.stopRecording }) }))
vi.mock('@/lib/voice-capture-support', () => ({ detectMicrophoneBrowserSupport: () => true, detectSpeechRecognitionSupport: () => true, isMicrophoneContextSecure: () => true, isCoarsePointerDevice: () => false, primeAudioStreamFromUserGesture: vi.fn(), INSECURE_MICROPHONE_MESSAGE: 'insecure' }))
afterEach(() => { vi.clearAllMocks(); vi.useRealTimers() })

function useVoiceHarness() {
  const [value, setValue] = useState('Existing draft')
  const voice = useComposerVoice({ value, setValue, persistDraft: vi.fn(), setAttachments: vi.fn(), isMobileViewport: false, sttConfigQuery: { data: { config: { stt: { provider: 'remote' } } } }, sttStatusQuery: { data: { remoteReady: true } } })
  return { value, voice }
}

it('preserves the draft when dictation produces text', () => {
  const { result } = renderHook(useVoiceHarness)
  act(() => result.current.voice.handleMicClick())
  expect(controls.startDictation).toHaveBeenCalledOnce()
  act(() => voiceOptions.onResult('new words'))
  expect(result.current.value).toBe('Existing draft new words')
})

it('does not start a pending long-press recording after unmount', () => {
  vi.useFakeTimers()
  const { result, unmount } = renderHook(useVoiceHarness)
  act(() => result.current.voice.handleMicPointerDown({ pointerType: 'mouse' }))
  unmount()
  act(() => vi.advanceTimersByTime(600))
  expect(controls.startRecording).not.toHaveBeenCalled()
})