import { act, renderHook } from '@testing-library/react'
import { QueryClient } from '@tanstack/react-query'
import { expect, it, vi } from 'vitest'
import { useChatSlashCommands } from './use-chat-slash-commands'
import { clearHistoryMessages } from '../chat-queries'

vi.mock('../chat-queries', () => ({ clearHistoryMessages: vi.fn() }))
vi.mock('@/components/ui/toast', () => ({ toast: vi.fn() }))

function context(): Parameters<typeof useChatSlashCommands>[0] {
  return {
    navigate: vi.fn().mockResolvedValue(undefined),
    forcedSessionKey: 'forced', resolvedSessionKey: 'resolved', activeSessionKey: 'active', activeFriendlyId: 'friendly',
    queryClient: new QueryClient(), finalDisplayMessages: [], canTruncateSession: true,
    UNAVAILABLE_TRUNCATE_MSG: 'Not available on this Hermes build (needs upstream session_truncate)',
    interactionBusy: false, truncateCurrentSession: vi.fn().mockResolvedValue(0), sendMessage: vi.fn(),
    setQueueVersion: vi.fn(), abortActiveStreamRef: { current: vi.fn() }, localStreamingRunId: null,
    streamingRunId: null, workspaceProfileName: 'developer', activeProfileName: 'developer',
    canCompressSession: true, UNAVAILABLE_COMPRESS_MSG: 'Not available on this Hermes build (needs upstream session_compress)',
    setIsCompacting: vi.fn(), refreshHistoryRef: { current: vi.fn() }, setBtwCard: vi.fn(), setBackgroundTasks: vi.fn(),
    activeIsRealtimeStreaming: false, sending: false,
  }
}

it('opens the explicit new-session route and clears the forced session identity', () => {
  const input = context()
  const { result } = renderHook(() => useChatSlashCommands(input))
  act(() => { expect(result.current('/new')).toBe(true) })
  expect(input.navigate).toHaveBeenCalledWith({ to: '/chat/$sessionKey', params: { sessionKey: 'new' } })
  act(() => { expect(result.current('/clear')).toBe(true) })
  expect(clearHistoryMessages).toHaveBeenCalledWith(input.queryClient, 'friendly', 'forced')
  expect(result.current('not a command')).toBe(false)
})

it('does not truncate or resend while a turn is busy', () => {
  const input = { ...context(), interactionBusy: true }
  const { result } = renderHook(() => useChatSlashCommands(input))
  act(() => { expect(result.current('/retry')).toBe(true) })
  expect(input.truncateCurrentSession).not.toHaveBeenCalled()
  expect(input.sendMessage).not.toHaveBeenCalled()
})