/**
 * Renders one AgentTranscriptRowVM.
 *
 * - `processing`: open-turn face slot (avatar + optional Thinking… pulse).
 * - `message` assistant under an open turn: no avatar (face stays on processing).
 * - settled / historical assistant: avatar on MessageItem.
 */

import type React from 'react'
import { cn } from '@/lib/utils'
import { AssistantAvatar } from '@/components/avatars'
import type { ChatMessage } from '../types'
import type { AgentTranscriptRowVM } from '../lib/agent-transcript-vm'
import { MessageItem } from './message-item'

export type AgentTranscriptItemViewProps = {
  row: AgentTranscriptRowVM
  formatLabel: (name: string, args?: Record<string, unknown>) => string
  formatArg: (name: string, args?: Record<string, unknown>) => string | null
  onRetryMessage?: (message: ChatMessage) => void
  onEditMessage?: (message: ChatMessage) => void
  onRegenerateMessage?: (message: ChatMessage) => void
  forceActionsVisible?: boolean
  isLastAssistant?: boolean
  isStreaming?: boolean
  streamingText?: string
  streamingThinking?: string
  lifecycleEvents?: Array<{
    text: string
    emoji: string
    timestamp: number
    isError: boolean
  }>
  toolCalls?: Array<{
    id: string
    name: string
    phase: string
    args?: unknown
    preview?: string
    result?: string
  }>
  expandAllToolSections?: boolean
  hideActivityCards?: boolean
  /** Override MessageItem face column (open-turn host uses none). */
  assistantFaceColumn?: 'avatar' | 'spacer' | 'none'
  /**
   * processing only: live waiting chrome (avatar glow + Thinking…).
   * Same lifecycle for both — off once durable Activity/text is beside the face.
   */
  processingPulse?: boolean
  /** processing only: avatar-only column (body rendered by list group). */
  processingAvatarOnly?: boolean
  wrapperClassName?: string
  wrapperDataMessageId?: string
  wrapperRef?: React.Ref<HTMLDivElement>
  wrapperScrollMarginTop?: number
  bubbleClassName?: string
}

export function AgentTranscriptItemView({
  row,
  formatLabel: _formatLabel,
  formatArg: _formatArg,
  onRetryMessage,
  onEditMessage,
  onRegenerateMessage,
  forceActionsVisible,
  isLastAssistant,
  isStreaming,
  streamingText,
  streamingThinking,
  lifecycleEvents,
  toolCalls,
  expandAllToolSections,
  hideActivityCards,
  assistantFaceColumn,
  processingPulse = true,
  processingAvatarOnly = false,
  wrapperClassName,
  wrapperDataMessageId,
  wrapperRef,
  wrapperScrollMarginTop,
  bubbleClassName,
}: AgentTranscriptItemViewProps) {
  if (row.kind === 'processing') {
    return (
      <div
        ref={wrapperRef}
        className={cn(
          processingAvatarOnly ? 'shrink-0' : 'w-full min-w-0',
          wrapperClassName,
        )}
        data-transcript-key={row.key}
        data-transcript-face="processing"
        data-chat-message-id={wrapperDataMessageId ?? row.key}
        style={
          typeof wrapperScrollMarginTop === 'number'
            ? { scrollMarginTop: `${wrapperScrollMarginTop}px` }
            : undefined
        }
      >
        {processingAvatarOnly ? (
          <AssistantAvatar
            size={24}
            className={cn(
              'mt-0.5 shrink-0',
              processingPulse && 'thinking-avatar-glow',
            )}
            alt={processingPulse ? 'Thinking' : undefined}
          />
        ) : (
          <div
            className={cn(
              'flex items-start gap-2 md:gap-3',
              processingPulse && 'thinking-live-pair',
            )}
          >
            <AssistantAvatar
              size={24}
              className={cn(
                'mt-0.5 shrink-0',
                processingPulse && 'thinking-avatar-glow',
              )}
              alt={processingPulse ? 'Thinking' : undefined}
            />
            {processingPulse ? (
              <div className="flex min-w-0 flex-1 flex-col gap-1 pt-0.5">
                <span className="thinking-live-label text-xs text-primary-400">
                  Thinking…
                </span>
              </div>
            ) : null}
          </div>
        )}
      </div>
    )
  }

  const faceColumn =
    assistantFaceColumn ??
    (row.speaker === 'assistant' ? 'avatar' : 'none')

  return (
    <div
      className="w-full min-w-0"
      data-transcript-key={row.key}
      data-transcript-face={row.speaker === 'assistant' ? 'message' : 'user'}
    >
      <MessageItem
        message={row.message}
        onRetryMessage={onRetryMessage}
        onEditMessage={onEditMessage}
        onRegenerateMessage={onRegenerateMessage}
        forceActionsVisible={forceActionsVisible}
        isLastAssistant={isLastAssistant}
        isStreaming={isStreaming}
        streamingText={streamingText}
        streamingThinking={streamingThinking}
        lifecycleEvents={lifecycleEvents}
        toolCalls={
          toolCalls as React.ComponentProps<typeof MessageItem>['toolCalls']
        }
        expandAllToolSections={expandAllToolSections}
        hideActivityCard={hideActivityCards}
        assistantFaceColumn={faceColumn}
        wrapperClassName={wrapperClassName}
        wrapperDataMessageId={wrapperDataMessageId ?? row.key}
        wrapperRef={wrapperRef}
        wrapperScrollMarginTop={wrapperScrollMarginTop}
        bubbleClassName={bubbleClassName}
      />
    </div>
  )
}
