/**
 * @deprecated Managed (Claude Code) chats now persist in collab.db
 * (`managed_chat_sessions` / `managed_chat_messages`) via server APIs.
 * This localStorage helper remains only for optional one-off migration /
 * debugging — new code should use `/api/agents/:id/sessions`.
 */
import type { AgentSession } from '@/lib/agent-types'
import type { ChatMessage } from '@/screens/chat/types'

export const EXTERNAL_CHAT_STORAGE_PREFIX = 'hermes:external-chat:'

function messageStorageKey(agentId: string, sessionId: string): string {
  return `${EXTERNAL_CHAT_STORAGE_PREFIX}${agentId}:${sessionId}`
}

function indexStorageKey(agentId: string): string {
  return `hermes:external-chat-index:${agentId}`
}

type SessionIndexEntry = {
  title?: string
  lastMessageAt?: string
}

type SessionIndex = Record<string, SessionIndexEntry>

function readIndex(agentId: string): SessionIndex {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(indexStorageKey(agentId))
    if (!raw) return {}
    const parsed = JSON.parse(raw) as SessionIndex
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeIndex(agentId: string, index: SessionIndex): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(indexStorageKey(agentId), JSON.stringify(index))
  } catch {
    // ignore quota
  }
}

function loadMessages(agentId: string, sessionId: string): Array<ChatMessage> {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(
      messageStorageKey(agentId, sessionId),
    )
    if (!raw) return []
    const parsed = JSON.parse(raw) as Array<ChatMessage>
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function titleFromMessages(messages: Array<ChatMessage>): string {
  for (const message of messages) {
    if (message.role !== 'user') continue
    const text = message.content
      ?.map((part) => (part.type === 'text' ? String(part.text ?? '') : ''))
      .join('')
      .trim()
    if (text) return text.slice(0, 60)
  }
  return 'Chat'
}

function lastMessageAtFromMessages(messages: Array<ChatMessage>): string {
  let latest = 0
  for (const message of messages) {
    const ts = typeof message.timestamp === 'number' ? message.timestamp : 0
    if (ts > latest) latest = ts
  }
  return new Date(latest || Date.now()).toISOString()
}

/**
 * Discover all persisted chats for an agent from message keys + optional index.
 * @deprecated Prefer fetchSessionsForAgent (SQLite).
 */
export function listExternalChatSessions(agentId: string): Array<AgentSession> {
  if (typeof window === 'undefined') return []
  const prefix = `${EXTERNAL_CHAT_STORAGE_PREFIX}${agentId}:`
  const index = readIndex(agentId)
  const sessionIds = new Set<string>(Object.keys(index))

  for (let i = 0; i < window.localStorage.length; i += 1) {
    const key = window.localStorage.key(i)
    if (!key?.startsWith(prefix)) continue
    const sessionId = key.slice(prefix.length)
    if (!sessionId || sessionId.startsWith('new-')) continue
    sessionIds.add(sessionId)
  }

  const sessions: Array<AgentSession> = []
  for (const sessionId of sessionIds) {
    const messages = loadMessages(agentId, sessionId)
    const indexed = index[sessionId]
    if (messages.length === 0 && !indexed) continue
    const title =
      indexed?.title?.trim() ||
      (messages.length > 0 ? titleFromMessages(messages) : 'Chat')
    sessions.push({
      sessionId,
      agentId,
      title,
      state: messages.length > 0 ? 'completed' : 'idle',
      lastMessageAt:
        indexed?.lastMessageAt ||
        (messages.length > 0
          ? lastMessageAtFromMessages(messages)
          : new Date().toISOString()),
      summary:
        messages.length > 0 ? `Messages: ${messages.length}` : undefined,
    })
  }

  sessions.sort(
    (a, b) =>
      new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime(),
  )
  return sessions
}

/** @deprecated */
export function upsertExternalChatSession(input: {
  agentId: string
  sessionId: string
  messages: Array<ChatMessage>
  title?: string
}): AgentSession | null {
  if (typeof window === 'undefined') return null
  const { agentId, sessionId, messages } = input
  if (!sessionId || sessionId.startsWith('new-')) return null

  const index = readIndex(agentId)
  const previous = index[sessionId]
  const title =
    input.title?.trim() ||
    previous?.title?.trim() ||
    (messages.length > 0 ? titleFromMessages(messages) : 'Chat')
  const lastMessageAt =
    messages.length > 0
      ? lastMessageAtFromMessages(messages)
      : previous?.lastMessageAt || new Date().toISOString()

  index[sessionId] = { title, lastMessageAt }
  writeIndex(agentId, index)

  return {
    sessionId,
    agentId,
    title,
    state: messages.length > 0 ? 'completed' : 'idle',
    lastMessageAt,
    summary: messages.length > 0 ? `Messages: ${messages.length}` : undefined,
  }
}

/** @deprecated */
export function renameExternalChatSession(
  agentId: string,
  sessionId: string,
  title: string,
): AgentSession | null {
  if (typeof window === 'undefined') return null
  const trimmed = title.trim()
  if (!trimmed) return null
  const index = readIndex(agentId)
  const messages = loadMessages(agentId, sessionId)
  const lastMessageAt =
    index[sessionId]?.lastMessageAt ||
    (messages.length > 0
      ? lastMessageAtFromMessages(messages)
      : new Date().toISOString())
  index[sessionId] = { title: trimmed, lastMessageAt }
  writeIndex(agentId, index)
  return {
    sessionId,
    agentId,
    title: trimmed,
    state: messages.length > 0 ? 'completed' : 'idle',
    lastMessageAt,
    summary: messages.length > 0 ? `Messages: ${messages.length}` : undefined,
  }
}

/** @deprecated */
export function deleteExternalChatSession(
  agentId: string,
  sessionId: string,
): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(messageStorageKey(agentId, sessionId))
  } catch {
    // ignore
  }
  const index = readIndex(agentId)
  if (sessionId in index) {
    delete index[sessionId]
    writeIndex(agentId, index)
  }
}

export { messageStorageKey as externalChatMessageStorageKey }
