/**
 * Shared Activity → list ChatMessage projection (Hermes + managed).
 *
 * Activity may store reasoning / tool / text as separate rows; the transcript
 * lane folds one turn into a single assistant host (contract §2/§4).
 */

import type { AgentActivityMessage } from '@agorax/agent-activity-core'
import {
  thinkingTextFromMessage,
  thinkingTextFromPayload,
} from '@/lib/chat-message-parts'
import { projectLiveAssistantMessage } from '@/lib/chat-turn-identity'
import type { ChatMessage } from '../types'
import {
  activityMessageToChatMessage,
  visibleTextFromActivityPayload,
} from './activity-message-mapper'

function isAssistantLaneRole(role: string): boolean {
  return role === 'assistant' || role === 'assistant_thinking'
}

function isToolCallKind(kind: string): boolean {
  return kind === 'tool_call' || kind === 'tool'
}

/**
 * Group key for assistant-lane rows that belong to one list host.
 * Prefer turnId; fall back to assistant:<runId> family (strip :thinking / :text:N).
 */
export function assistantActivityFamilyKey(
  message: AgentActivityMessage,
): string | null {
  if (message.role === 'user' || message.role === 'system') return null
  const turnId = message.turnId?.trim()
  if (turnId) return `turn:${turnId}`
  const id = message.messageId.trim()
  if (id.startsWith('toolcall:')) return null
  if (id.startsWith('assistant:')) {
    let rest = id.slice('assistant:'.length)
    if (rest.endsWith(':thinking')) rest = rest.slice(0, -':thinking'.length)
    const textSep = rest.indexOf(':text:')
    if (textSep >= 0) rest = rest.slice(0, textSep)
    return rest ? `asst:${rest}` : null
  }
  return null
}

function hostMessageId(family: readonly AgentActivityMessage[]): string {
  // Prefer send-time pending shell so started→assistant:<runId> does not remount.
  for (const message of family) {
    const id = message.messageId.trim()
    if (id.includes(':pending:')) {
      return id.replace(/:thinking$/, '').replace(/:text:\d+$/, '')
    }
  }
  for (const message of family) {
    if (message.kind === 'text' && isAssistantLaneRole(message.role)) {
      return message.messageId
    }
  }
  for (const message of family) {
    if (message.messageId.startsWith('assistant:')) {
      return message.messageId
        .replace(/:thinking$/, '')
        .replace(/:text:\d+$/, '')
    }
  }
  return family[0]?.messageId ?? 'assistant:unknown'
}

function normalizeStreamingHostId(messageId: string): string {
  return messageId.replace(/:thinking$/, '').replace(/:text:\d+$/, '')
}

function foldActivityFamilyToChat(
  family: readonly AgentActivityMessage[],
  streamingMessageId: string | null,
): ChatMessage {
  let thinking = ''
  let text = ''
  const toolCalls: Array<{
    id: string
    name: string
    phase: string
    args?: unknown
    preview?: string
    result?: string
  }> = []
  let timestamp = 0
  let streaming = false
  for (const message of family) {
    timestamp = Math.max(timestamp, message.occurredAtUnixMs)
    if (message.status === 'streaming') streaming = true
    if (
      message.kind === 'reasoning' ||
      message.role === 'assistant_thinking'
    ) {
      const part = thinkingTextFromPayload(message.payload)
      if (part) thinking = thinking ? `${thinking}\n${part}` : part
      continue
    }
    if (isToolCallKind(message.kind)) {
      const name =
        (typeof message.payload.toolName === 'string' &&
          message.payload.toolName) ||
        (typeof message.payload.name === 'string' && message.payload.name) ||
        'tool'
      const output = message.payload.output
      const error =
        (typeof message.payload.error === 'string' &&
          message.payload.error.trim()) ||
        (typeof message.payload.errorMessage === 'string' &&
          message.payload.errorMessage.trim()) ||
        ''
      const outputText =
        typeof output === 'string'
          ? output
          : output &&
              typeof output === 'object' &&
              typeof (output as { text?: unknown }).text === 'string'
            ? String((output as { text: string }).text)
            : undefined
      toolCalls.push({
        id: message.messageId.replace(/^toolcall:/, ''),
        name,
        phase:
          message.status === 'failed'
            ? 'error'
            : message.status === 'completed'
              ? 'complete'
              : 'calling',
        args: message.payload.input ?? message.payload.arguments,
        result: error || outputText,
      })
      continue
    }
    const part =
      message.kind === 'text'
        ? visibleTextFromActivityPayload(message.role, message.payload)
        : typeof message.payload.text === 'string'
          ? message.payload.text
          : ''
    if (part) text = part
  }
  const hostId = hostMessageId(family)
  const runId = hostId.startsWith('assistant:')
    ? hostId.slice('assistant:'.length).split(':')[0] ?? null
    : null
  const projected = projectLiveAssistantMessage({
    messageId: hostId,
    runId,
    text,
    thinking,
    toolCalls,
    streaming:
      streaming ||
      (streamingMessageId !== null &&
        (streamingMessageId === hostId ||
          streamingMessageId.startsWith(`${hostId}:`) ||
          normalizeStreamingHostId(streamingMessageId) === hostId ||
          family.some((row) => row.messageId === streamingMessageId))),
    timestamp: timestamp || Date.now(),
  })
  return {
    ...projected,
    id: hostId,
    messageId: hostId,
  }
}

function mapSingleton(message: AgentActivityMessage): ChatMessage {
  const chat = activityMessageToChatMessage({
    messageId: message.messageId,
    role: message.role,
    kind: message.kind,
    payload: message.payload,
    occurredAtUnixMs: message.occurredAtUnixMs,
    status: message.status,
    semantics: message.semantics ?? null,
  })
  return {
    ...chat,
    id: message.messageId,
    messageId: message.messageId,
  }
}

/**
 * Project Engine/overlay Activity rows to list ChatMessages.
 * User/system stay 1:1; assistant-lane rows that share a turn/run fold into one host.
 */
export function projectActivityMessagesToChat(
  sessionMessages: readonly AgentActivityMessage[],
  streamingMessageId: string | null = null,
): ChatMessage[] {
  const out: ChatMessage[] = []
  let index = 0
  while (index < sessionMessages.length) {
    const message = sessionMessages[index]!
    if (message.role === 'user' || message.role === 'system') {
      out.push(mapSingleton(message))
      index += 1
      continue
    }
    const familyKey = assistantActivityFamilyKey(message)
    if (!familyKey) {
      // Orphan tool without turn — emit alone (list may still attach later).
      out.push(mapSingleton(message))
      index += 1
      continue
    }
    const family: AgentActivityMessage[] = [message]
    const familyTurnId = message.turnId?.trim() || null
    let cursor = index + 1
    while (cursor < sessionMessages.length) {
      const next = sessionMessages[cursor]!
      if (next.role === 'user' || next.role === 'system') break
      const nextKey = assistantActivityFamilyKey(next)
      if (nextKey === familyKey) {
        family.push(next)
        cursor += 1
        continue
      }
      if (
        next.messageId.startsWith('toolcall:') &&
        familyTurnId &&
        next.turnId === familyTurnId
      ) {
        family.push(next)
        cursor += 1
        continue
      }
      break
    }
    out.push(foldActivityFamilyToChat(family, streamingMessageId))
    index = cursor
  }
  // Safety nets: (1) suffix text echoes (2) every post-user assistant fragment
  // into one host — thinking-only + reply must not paint as two MessageItems.
  return foldAssistantsPerUserTurn(collapseAdjacentAssistantEchoes(out))
}

function assistantPlainText(message: ChatMessage): string {
  if (!Array.isArray(message.content)) return ''
  return message.content
    .map((part) => {
      if (
        part &&
        typeof part === 'object' &&
        (part as { type?: unknown }).type === 'text' &&
        typeof (part as { text?: unknown }).text === 'string'
      ) {
        return (part as { text: string }).text
      }
      return ''
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
}

function assistantHostRichness(message: ChatMessage): number {
  let score = assistantPlainText(message).length
  if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (!part || typeof part !== 'object') continue
      const type = (part as { type?: unknown }).type
      if (type === 'thinking') score += 1_000
      if (type === 'tool-call' || type === 'tool_call') score += 500
    }
  }
  const streamTools = (message as { __streamToolCalls?: unknown })
    .__streamToolCalls
  if (Array.isArray(streamTools)) score += streamTools.length * 500
  return score
}

function isSuffixTextEcho(left: string, right: string): boolean {
  if (!left || !right) return false
  if (left === right) return true
  const shorter = left.length <= right.length ? left : right
  const longer = left.length <= right.length ? right : left
  // Avoid collapsing short unrelated replies.
  if (shorter.length < 32) return false
  return longer.endsWith(shorter)
}

/**
 * Collapse consecutive assistant hosts when one body is an echo/suffix of the
 * other (pending shell + gateway msg-N / assistant:runId fork).
 */
export function collapseAdjacentAssistantEchoes(
  messages: readonly ChatMessage[],
): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const message of messages) {
    const prev = out[out.length - 1]
    if (
      prev?.role === 'assistant' &&
      message.role === 'assistant' &&
      isSuffixTextEcho(assistantPlainText(prev), assistantPlainText(message))
    ) {
      const prevId = String(prev.messageId ?? prev.id ?? '')
      const nextId = String(message.messageId ?? message.id ?? '')
      const richer =
        assistantHostRichness(prev) >= assistantHostRichness(message)
          ? prev
          : message
      const pendingSide = prevId.includes(':pending:')
        ? prev
        : nextId.includes(':pending:')
          ? message
          : null
      out[out.length - 1] =
        pendingSide && pendingSide !== richer
          ? {
              ...richer,
              id: pendingSide.id ?? pendingSide.messageId,
              messageId: pendingSide.messageId ?? pendingSide.id,
            }
          : richer
      continue
    }
    out.push(message)
  }
  return out
}

function toolCallsFromChatMessage(message: ChatMessage): Array<{
  id: string
  name: string
  phase: string
  args?: unknown
  preview?: string
  result?: string
}> {
  const stream = Array.isArray(
    (message as { __streamToolCalls?: unknown }).__streamToolCalls,
  )
    ? (
        (message as {
          __streamToolCalls: Array<{
            id?: string
            name?: string
            phase?: string
            args?: unknown
            preview?: string
            result?: string
          }>
        }).__streamToolCalls
      )
    : []
  if (stream.length > 0) {
    return stream.map((toolCall, index) => ({
      id: toolCall.id || `tool-${index}`,
      name: toolCall.name || 'tool',
      phase: toolCall.phase || 'complete',
      args: toolCall.args,
      preview: toolCall.preview,
      result: toolCall.result,
    }))
  }
  if (!Array.isArray(message.content)) return []
  const out: Array<{
    id: string
    name: string
    phase: string
    args?: unknown
  }> = []
  for (const part of message.content) {
    if (!part || typeof part !== 'object') continue
    const type = (part as { type?: unknown }).type
    if (type !== 'toolCall' && type !== 'tool-call' && type !== 'tool_call') {
      continue
    }
    out.push({
      id:
        (typeof (part as { id?: unknown }).id === 'string' &&
          (part as { id: string }).id) ||
        `tool-${out.length}`,
      name:
        (typeof (part as { name?: unknown }).name === 'string' &&
          (part as { name: string }).name) ||
        'tool',
      phase: 'complete',
      args: (part as { arguments?: unknown }).arguments,
    })
  }
  return out
}

function mergeAssistantHostGroup(hosts: readonly ChatMessage[]): ChatMessage {
  let thinking = ''
  let text = ''
  let tools: ReturnType<typeof toolCallsFromChatMessage> = []
  let streaming = false
  let timestamp = 0
  let hostId = ''
  let runId: string | null = null
  for (const host of hosts) {
    const id = String(host.messageId ?? host.id ?? '')
    if (!hostId || id.includes(':pending:')) hostId = id || hostId
    if (
      !runId &&
      typeof (host as { runId?: unknown }).runId === 'string' &&
      (host as { runId: string }).runId &&
      (host as { runId: string }).runId !== 'pending'
    ) {
      runId = (host as { runId: string }).runId
    }
    if (
      (host as { __streamingStatus?: unknown }).__streamingStatus ===
      'streaming'
    ) {
      streaming = true
    }
    timestamp = Math.max(
      timestamp,
      typeof host.timestamp === 'number' ? host.timestamp : 0,
    )
    const partThinking = thinkingTextFromMessage(host).trim()
    if (partThinking) {
      thinking = thinking
        ? thinking.length >= partThinking.length
          ? thinking
          : partThinking
        : partThinking
    }
    const partText = assistantPlainText(host)
    if (partText) {
      text = text
        ? text.length >= partText.length
          ? text
          : partText
        : partText
    }
    const partTools = toolCallsFromChatMessage(host)
    if (partTools.length > 0) {
      const seen = new Set(tools.map((tool) => tool.id))
      for (const tool of partTools) {
        if (seen.has(tool.id)) continue
        seen.add(tool.id)
        tools.push(tool)
      }
    }
  }
  if (!hostId) hostId = String(hosts[0]?.messageId ?? hosts[0]?.id ?? 'assistant')
  if (!runId && hostId.startsWith('assistant:')) {
    const rest = hostId.slice('assistant:'.length)
    const bare = rest.includes(':pending:')
      ? null
      : rest.split(':')[0] || null
    if (bare && bare !== 'pending' && bare !== 'history') runId = bare
  }
  const projected = projectLiveAssistantMessage({
    messageId: hostId,
    runId,
    text,
    thinking,
    toolCalls: tools,
    streaming,
    timestamp: timestamp || Date.now(),
  })
  return {
    ...projected,
    id: hostId,
    messageId: hostId,
  }
}

/**
 * Contract §2/§4: one assistant list host per user turn. Thinking-only rows
 * that landed beside the reply (different Activity family / turnId) must fold
 * back — otherwise MessageItem paints a stray Activity under the bubble.
 */
export function foldAssistantsPerUserTurn(
  messages: readonly ChatMessage[],
): ChatMessage[] {
  const out: ChatMessage[] = []
  let index = 0
  while (index < messages.length) {
    const message = messages[index]!
    if (message.role !== 'assistant') {
      out.push(message)
      index += 1
      continue
    }
    const group: ChatMessage[] = [message]
    let cursor = index + 1
    while (
      cursor < messages.length &&
      messages[cursor]?.role === 'assistant'
    ) {
      group.push(messages[cursor]!)
      cursor += 1
    }
    out.push(
      group.length === 1 ? group[0]! : mergeAssistantHostGroup(group),
    )
    index = cursor
  }
  return out
}

function isProcessingHostMessage(message: AgentActivityMessage): boolean {
  if (!isAssistantLaneRole(message.role)) return false
  if (isToolCallKind(message.kind)) return true
  if (message.kind === 'reasoning' || message.role === 'assistant_thinking') {
    return thinkingTextFromPayload(message.payload).trim().length > 0
  }
  if (message.kind === 'text') {
    return (
      typeof message.payload.text === 'string' &&
      message.payload.text.trim().length > 0
    )
  }
  return (
    typeof message.payload.text === 'string' &&
    message.payload.text.trim().length > 0
  )
}

/**
 * Live streaming chrome key — prefer the text host id (not :thinking).
 * Includes managed orphan-turn trailing fallback when turnId is missing on rows.
 */
export function selectAssistantStreamingMessageId(
  sessionMessages: readonly AgentActivityMessage[],
  activeTurnId: string,
): string | null {
  for (let index = sessionMessages.length - 1; index >= 0; index -= 1) {
    const message = sessionMessages[index]
    if (!message || message.turnId !== activeTurnId) continue
    if (message.role === 'assistant' && message.kind === 'text') {
      return message.messageId
    }
  }
  for (let index = sessionMessages.length - 1; index >= 0; index -= 1) {
    const message = sessionMessages[index]
    if (!message || message.turnId !== activeTurnId) continue
    if (!isAssistantLaneRole(message.role)) continue
    if (!isProcessingHostMessage(message)) continue
    return normalizeStreamingHostId(message.messageId)
  }
  // Orphan turnId: fall back to the latest trailing host message.
  for (let index = sessionMessages.length - 1; index >= 0; index -= 1) {
    const message = sessionMessages[index]
    if (!message) continue
    if (message.role === 'user') break
    if (isProcessingHostMessage(message)) {
      return normalizeStreamingHostId(message.messageId)
    }
  }
  return null
}
