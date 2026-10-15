'use client'

import type { ReactNode } from 'react'
import { ChatMessageList } from './chat-message-list'
import type { ChatMessage } from '../types'

/**
 * Shared message pane for Hermes and managed AgentChatFrame children.
 * Forwards the same streaming / activity props so both runtimes render
 * thinking through ChatMessageList identically (message content parts and/or
 * streamingThinking overlay).
 *
 * Always uses ChatMessageList's own scroll root — do not wrap in another
 * ChatContainer (nested viewports break wheel scrolling).
 */
export function AgentChatMessagePane({
  messages,
  turnBusy = false,
  isStreaming = false,
  streamingMessageId = null,
  streamingText,
  streamingThinking,
  sessionKey,
  emptyState,
  headerHeight = 48,
  activeToolCalls,
  lifecycleEvents,
  hideSystemMessages,
  onRetryMessage,
  onEditMessage,
  onRegenerateMessage,
  onRefresh,
  loading = false,
}: {
  messages: Array<ChatMessage>
  /** Busy turn — chrome on the open MessageItem. */
  turnBusy?: boolean
  /** Turn-active: message-level live chrome / Stop, not the bottom pill. */
  isStreaming?: boolean
  streamingMessageId?: string | null
  /** Portable/Hermes legacy sidecar; Engine hosts embed thinking via fold. */
  streamingText?: string
  streamingThinking?: string
  sessionKey: string
  emptyState?: ReactNode
  headerHeight?: number
  activeToolCalls?: Array<{
    id: string
    name: string
    phase: string
    args?: unknown
  }>
  lifecycleEvents?: Array<{
    text: string
    emoji: string
    timestamp: number
    isError: boolean
  }>
  hideSystemMessages?: boolean
  onRetryMessage?: (message: ChatMessage) => void
  onEditMessage?: (message: ChatMessage) => void
  onRegenerateMessage?: (message: ChatMessage) => void
  onRefresh?: () => void
  loading?: boolean
}) {
  const empty = messages.length === 0

  return (
    <ChatMessageList
      messages={messages}
      turnBusy={turnBusy}
      researchCard={undefined}
      loading={loading}
      empty={empty}
      emptyState={emptyState}
      pinToTop={false}
      pinGroupMinHeight={0}
      headerHeight={headerHeight}
      sessionKey={sessionKey}
      isStreaming={isStreaming}
      streamingMessageId={streamingMessageId}
      streamingText={streamingText}
      streamingThinking={streamingThinking}
      lifecycleEvents={lifecycleEvents}
      hideSystemMessages={hideSystemMessages}
      activeToolCalls={activeToolCalls}
      onRetryMessage={onRetryMessage}
      onEditMessage={onEditMessage}
      onRegenerateMessage={onRegenerateMessage}
      onRefresh={onRefresh}
    />
  )
}
