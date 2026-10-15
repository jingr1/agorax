/**
 * Rolling summary generation for group chat rooms.
 *
 * Keeps context windows bounded by summarizing older messages. When the number
 * of messages since the last summary reaches GROUP_SUMMARY_THRESHOLD, a new
 * summary is generated from the un-summarized tail and persisted.
 *
 * Summary generation is done on a throwaway session on a profile gateway so it
 * does not pollute any member's canonical session. The profile is taken from the
 * member whose turn just finished; if none is supplied, the active gateway is
 * used as a fallback.
 *
 * Failed / empty LLM replies must NOT be persisted — otherwise
 * through_message_id advances and real history is permanently skipped.
 */
import { getHermesApiClient } from '../hermes-api-profile'
import { ensureProfileGateway } from '../gateway-pool'
import {
  createSession as globalCreateSession,
  getMessages as globalGetMessages,
  sendChat as globalSendChat,
} from '../hermes-api'
import {
  getLatestMessages,
  getLatestSummary,
  listParticipants,
  saveSummary,
} from './room-store'
import {
  GROUP_SUMMARY_THRESHOLD,
  GROUP_SUMMARY_WINDOW_MAX,
} from './constants'
import type { RoomMessage, RoomSummary } from './types'

/**
 * Summary instructions: keep agent ids distinct from model/provider names so
 * later turns (esp. managed kimi vs Hermes model "Kimi-K2.7-Code" on Token-X)
 * do not conflate them.
 */
export const SUMMARY_PROMPT = `Summarize the following group chat messages concisely. Capture the key decisions, open questions, and who is responsible for what. Do not include greetings or meta-commentary.

Naming rules (critical):
- Attribute actions and failures to room members by their agent id / @handle (e.g. orchestrator, kimi-impl, cc-impl), never by a model or provider product name alone.
- Model names (e.g. Kimi-K2.7-Code, claude-opus) and providers (e.g. Token-X, Anthropic) are NOT room members. If a billing/quota/rate-limit error mentions a model, write it as "agent <id> failed calling model <model> via <provider>", not as if that model were the agent.
- Do not merge similarly named entities (kimi-impl ≠ Kimi-K2.7-Code).`

/** Format one transcript line with stable agent-id tags for the summarizer. */
export function formatSummaryTranscriptLine(message: RoomMessage): string {
  if (message.senderKind === 'human') {
    return `${message.senderName} (user): ${message.content}`
  }
  if (message.senderKind === 'system') {
    return `system: ${message.content}`
  }
  const agentId = message.senderParticipantId?.trim()
  const name = message.senderName.trim() || agentId || 'agent'
  if (agentId) {
    return `${name} [agent_id=${agentId}]: ${message.content}`
  }
  return `${name}: ${message.content}`
}

/** Optional roster legend so the LLM can map display names → agent ids. */
export function buildSummaryRosterLegend(
  roomId: string,
  input?: { dbPath?: string },
): string {
  const agents = listParticipants(roomId, input).filter(
    (p) => p.kind === 'agent' && !p.removedAt,
  )
  if (agents.length === 0) return ''
  const lines = agents.map((p) => {
    const handle = p.mentionName ? `@${p.mentionName}` : ''
    const runtime = p.runtime && p.runtime !== 'human' ? ` runtime=${p.runtime}` : ''
    return `- agent_id=${p.participantId} display=${p.displayName}${handle ? ` ${handle}` : ''}${runtime}`
  })
  return `Room members (agent_id is authoritative; model names are not members):\n${lines.join('\n')}\n\n`
}

const PLACEHOLDER_SUMMARY_RE = /^\(?\s*no summary\s*\)?$/i

/** True when text is worth injecting / persisting as a room summary. */
export function isUsableSummaryText(text: string | null | undefined): boolean {
  const t = String(text ?? '').trim()
  if (!t) return false
  if (PLACEHOLDER_SUMMARY_RE.test(t)) return false
  return true
}

function coerceContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'string') return block
        if (block && typeof block === 'object') {
          const rec = block as Record<string, unknown>
          if (typeof rec.text === 'string') return rec.text
          if (typeof rec.content === 'string') return rec.content
        }
        return ''
      })
      .join('')
  }
  if (content == null) return ''
  return String(content)
}

/** Pull assistant text from a /chat response (several gateway shapes). */
export function extractSummaryText(result: Record<string, unknown>): string {
  const buckets: Array<unknown> = []
  if (Array.isArray(result.messages)) buckets.push(...result.messages)
  if (Array.isArray(result.items)) buckets.push(...result.items)
  if (Array.isArray(result.data)) buckets.push(...result.data)
  if (result.message && typeof result.message === 'object') {
    buckets.push(result.message)
  }

  for (const entry of [...buckets].reverse()) {
    if (!entry || typeof entry !== 'object') continue
    const rec = entry as Record<string, unknown>
    if (String(rec.role ?? '') !== 'assistant') continue
    const text = coerceContent(rec.content).trim()
    if (text) return text
  }

  for (const key of ['response', 'text', 'content', 'output'] as const) {
    const text = coerceContent(result[key]).trim()
    if (text && !PLACEHOLDER_SUMMARY_RE.test(text)) return text
  }
  return ''
}

export async function maybeSummarizeRoom(
  roomId: string,
  input?: { dbPath?: string; model?: string; profile?: string },
): Promise<RoomSummary | null> {
  try {
    return await maybeSummarizeRoomInner(roomId, input)
  } catch (error) {
    console.warn(
      `[summaries] summarize failed for room ${roomId}:`,
      error instanceof Error ? error.message : String(error),
    )
    return null
  }
}

async function maybeSummarizeRoomInner(
  roomId: string,
  input?: { dbPath?: string; model?: string; profile?: string },
): Promise<RoomSummary | null> {
  const latest = getLatestSummary(roomId, input)
  const messages = getLatestMessages(roomId, {
    dbPath: input?.dbPath,
    limit: 200,
  })

  // Ignore unusable placeholders so a bad prior save cannot permanently
  // skip the unsummarized window via through_message_id.
  let startIndex = 0
  if (latest?.throughMessageId && isUsableSummaryText(latest.content)) {
    const idx = messages.findIndex((m) => m.id === latest.throughMessageId)
    if (idx >= 0) startIndex = idx + 1
  }

  const unsummarized = messages.slice(startIndex)
  if (unsummarized.length < GROUP_SUMMARY_THRESHOLD) {
    return null
  }

  // Oldest-first window: large backlogs roll across multiple ticks.
  const window = unsummarized.slice(0, GROUP_SUMMARY_WINDOW_MAX)
  const priorNote = isUsableSummaryText(latest?.content)
    ? `Previous summary:\n${latest!.content}\n\n`
    : ''
  const roster = buildSummaryRosterLegend(roomId, input)
  const transcript = window.map(formatSummaryTranscriptLine).join('\n')
  const fullPrompt = `${SUMMARY_PROMPT}\n\n${roster}${priorNote}${transcript}`

  const profile = input?.profile
  if (profile) {
    await ensureProfileGateway(profile).catch((error) => {
      console.warn(
        `[summaries] could not ensure gateway for ${profile}:`,
        error instanceof Error ? error.message : String(error),
      )
    })
  }
  const client = profile ? getHermesApiClient(profile) : null
  let session
  try {
    session = client
      ? await client.createSession({
          title: `Summary for room ${roomId}`,
        })
      : await globalCreateSession({
          title: `Summary for room ${roomId}`,
        })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    if (msg.includes('Title already in use')) {
      session = client
        ? await client.createSession({
            title: `Summary for room ${roomId} ${Date.now()}`,
          })
        : await globalCreateSession({
            title: `Summary for room ${roomId} ${Date.now()}`,
          })
    } else {
      throw error
    }
  }

  const effectiveModel = input?.model
  const result = client
    ? await client.sendChat(session.id, {
        message: fullPrompt,
        ...(effectiveModel ? { model: effectiveModel } : {}),
      })
    : await globalSendChat(session.id, {
        message: fullPrompt,
        ...(effectiveModel ? { model: effectiveModel } : {}),
      })

  let text = extractSummaryText(result)
  if (!isUsableSummaryText(text)) {
    // Fallback: read the throwaway session transcript (some gateways omit
    // assistant text from the /chat JSON body).
    try {
      const sessionMessages = client
        ? await client.getMessages(session.id)
        : await globalGetMessages(session.id)
      const lastAssistant = [...sessionMessages]
        .reverse()
        .find((m) => m.role === 'assistant' && coerceContent(m.content).trim())
      if (lastAssistant) {
        text = coerceContent(lastAssistant.content).trim()
      }
    } catch (error) {
      console.warn(
        `[summaries] getMessages fallback failed for room ${roomId}:`,
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  if (!isUsableSummaryText(text)) {
    console.warn(
      `[summaries] refusing to persist empty/placeholder summary for room ${roomId} (${window.length}/${unsummarized.length} msgs)`,
    )
    return null
  }

  const lastMessage = window[window.length - 1]!
  return saveSummary(roomId, text, lastMessage.id, window.length, input)
}

/**
 * Return the active summary text plus the list of messages that should be
 * included in a member's delta (everything after the summary).
 */
export function getContextForMember(
  roomId: string,
  input?: { dbPath?: string },
): {
  summary: string | null
  messages: Array<{ senderName: string; content: string; createdAt: number }>
} {
  const summary = getLatestSummary(roomId, input)
  const all = getLatestMessages(roomId, { dbPath: input?.dbPath, limit: 200 })
  if (!summary?.throughMessageId || !isUsableSummaryText(summary.content)) {
    // Unusable / missing summary: do not hide history behind a bad anchor.
    return { summary: null, messages: all }
  }
  const idx = all.findIndex((m) => m.id === summary.throughMessageId)
  const messages = idx >= 0 ? all.slice(idx + 1) : all
  return { summary: summary.content, messages }
}
