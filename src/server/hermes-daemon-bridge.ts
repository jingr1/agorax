/**
 * Hermes 1:1 → daemon agent.db display-canonical bridge.
 * Gateway remains execution-only; strong ids land in workspace_agent_messages.
 */

import { AgoraxManagedAgentHttpClient } from './agent-runtime/agorax-managed-agent-http-client'
import type { AgentActivityDurableMessage } from '@agorax/agent-activity-core'

export function hermesDaemonWorkspaceId(profileName?: string): string {
  const profile = (profileName ?? 'default').trim() || 'default'
  return `hermes:${profile}`
}

export function getHermesDaemonBridgeClient(input?: {
  profileName?: string
  workspaceId?: string
}): AgoraxManagedAgentHttpClient | null {
  const baseUrl = process.env.AGORAX_MANAGED_AGENT_URL?.trim()
  if (!baseUrl) return null
  const workspaceId =
    input?.workspaceId?.trim() || hermesDaemonWorkspaceId(input?.profileName)
  return new AgoraxManagedAgentHttpClient({ baseUrl, workspaceId })
}

export type HermesBridgeToolCall = {
  id: string
  name: string
  phase?: string
  args?: unknown
  result?: string
}

export type HermesBridgePersistInput = {
  agentSessionId: string
  profileName?: string
  clientSubmitId: string
  userText?: string
  hermesRunId?: string | null
  assistantText?: string | null
  thinkingText?: string | null
  /** Live/tool-backfill rows — kept across authoritative settle replace. */
  toolCalls?: readonly HermesBridgeToolCall[]
  status?: 'streaming' | 'completed' | 'failed' | 'canceled'
  settled?: boolean
  occurredAtUnixMs?: number
}

export type HermesBridgePersistResult = {
  ok: boolean
  /** Daemon messageVersion high-water after this write (0 when no-op / empty). */
  latestVersion: number
}

/**
 * Persist one Hermes turn frame into daemon agent.db.
 * No-ops when AGORAX_MANAGED_AGENT_URL is unset.
 */
export async function persistHermesTurnToDaemon(
  input: HermesBridgePersistInput,
): Promise<HermesBridgePersistResult> {
  const client = getHermesDaemonBridgeClient({
    profileName: input.profileName,
  })
  if (!client) return { ok: false, latestVersion: 0 }

  const agentSessionId = input.agentSessionId.trim()
  const clientSubmitId = input.clientSubmitId.trim()
  if (!agentSessionId || !clientSubmitId) {
    return { ok: false, latestVersion: 0 }
  }

  const turnId = `turn-${clientSubmitId}`
  const now = input.occurredAtUnixMs ?? Date.now()
  const runId = input.hermesRunId?.trim() || null
  const settled = input.settled === true
  const status = input.status ?? (settled ? 'completed' : 'streaming')
  const messages: Array<{
    messageId: string
    turnId: string
    role: string
    kind: string
    status: string
    payload: Record<string, unknown>
    occurredAtUnixMs: number
  }> = []

  if (typeof input.userText === 'string' && input.userText.length > 0) {
    messages.push({
      messageId: `user:${clientSubmitId}`,
      turnId,
      role: 'user',
      kind: 'text',
      status: 'completed',
      payload: { text: input.userText, clientSubmitId },
      occurredAtUnixMs: now,
    })
  }
  if (runId) {
    const assistantText =
      typeof input.assistantText === 'string' ? input.assistantText : null
    const thinkingText =
      typeof input.thinkingText === 'string' ? input.thinkingText.trim() : ''
    // Reasoning before text: one turn → one list host with Activity above reply.
    // No content-equality filter — whatever the model put in reasoning ships as-is.
    if (thinkingText) {
      messages.push({
        messageId: `assistant:${runId}:thinking`,
        turnId,
        role: 'assistant',
        kind: 'reasoning',
        status,
        payload: { text: thinkingText, runId, clientSubmitId },
        occurredAtUnixMs: now,
      })
    }
    if (assistantText !== null) {
      messages.push({
        messageId: `assistant:${runId}`,
        turnId,
        role: 'assistant',
        kind: 'text',
        status,
        payload: { text: assistantText, runId, clientSubmitId },
        occurredAtUnixMs: now + (thinkingText ? 1 : 0),
      })
    }
    if (Array.isArray(input.toolCalls)) {
      let toolOffset = 0
      for (const tool of input.toolCalls) {
        const id = typeof tool.id === 'string' ? tool.id.trim() : ''
        if (!id) continue
        const name =
          (typeof tool.name === 'string' && tool.name.trim()) || 'tool'
        const phase =
          (typeof tool.phase === 'string' && tool.phase.trim()) || 'complete'
        const failed = phase === 'error' || phase === 'failed'
        const terminal =
          failed ||
          phase === 'complete' ||
          phase === 'completed' ||
          phase === 'done' ||
          phase === 'result'
        toolOffset += 1
        messages.push({
          messageId: id.startsWith('toolcall:') ? id : `toolcall:${id}`,
          turnId,
          role: 'assistant',
          kind: 'tool_call',
          status: failed ? 'failed' : terminal ? 'completed' : 'running',
          payload: {
            name,
            toolName: name,
            phase,
            input: tool.args,
            output: typeof tool.result === 'string' ? tool.result : undefined,
            runId,
            clientSubmitId,
          },
          occurredAtUnixMs: now + (thinkingText ? 1 : 0) + toolOffset,
        })
      }
    }
  }

  const workspaceId = hermesDaemonWorkspaceId(input.profileName)
  const path = `/v1/workspaces/${encodeURIComponent(workspaceId)}/hermes-bridge/sessions/${encodeURIComponent(agentSessionId)}/activity`
  const baseUrl = process.env.AGORAX_MANAGED_AGENT_URL!.trim().replace(/\/$/, '')
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      providerSessionId: agentSessionId,
      turnId,
      phase: settled ? 'settled' : 'running',
      outcome: settled
        ? status === 'failed'
          ? 'failed'
          : status === 'canceled'
            ? 'canceled'
            : 'completed'
        : '',
      messages,
    }),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(
      `hermes daemon bridge failed: ${response.status} ${path}${detail ? `: ${detail}` : ''}`,
    )
  }
  const body = (await response.json().catch(() => null)) as {
    latestVersion?: unknown
  } | null
  const latestVersion =
    typeof body?.latestVersion === 'number' &&
    Number.isSafeInteger(body.latestVersion) &&
    body.latestVersion >= 0
      ? body.latestVersion
      : 0
  return { ok: true, latestVersion }
}

export async function listHermesDaemonMessages(input: {
  agentSessionId: string
  profileName?: string
  afterVersion?: number
  limit?: number
}): Promise<{
  messages: AgentActivityDurableMessage[]
  latestVersion: number
  hasMore: boolean
} | null> {
  const client = getHermesDaemonBridgeClient({
    profileName: input.profileName,
  })
  if (!client) return null
  try {
    return await client.listSessionMessages(input.agentSessionId, {
      afterVersion: input.afterVersion,
      limit: input.limit,
    })
  } catch (error) {
    // Missing session → treat as no canonical rows (external gateway history).
    if (
      error &&
      typeof error === 'object' &&
      'status' in error &&
      (error as { status: number }).status === 404
    ) {
      return { messages: [], latestVersion: 0, hasMore: false }
    }
    throw error
  }
}

function payloadText(payload: Record<string, unknown> | undefined): string {
  if (!payload) return ''
  if (typeof payload.text === 'string') return payload.text
  if (typeof payload.content === 'string') return payload.content
  return ''
}

/**
 * Project daemon activity rows to ChatMessage history.
 * Same-turn reasoning + text fold into one assistant host (thinking before
 * text) so the list never paints Activity as a second MessageItem under the
 * reply bubble. Reasoning never gets a top-level `text` field — that made
 * textFromMessage treat thinking as a second bubble body.
 */
export function daemonActivityToChatHistory(
  messages: readonly AgentActivityDurableMessage[],
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  const assistantIndexByTurn = new Map<string, number>()

  for (const row of messages) {
    const role = row.role === 'user' ? 'user' : row.role
    if (
      role !== 'user' &&
      role !== 'assistant' &&
      role !== 'assistant_thinking'
    ) {
      continue
    }
    const kind = row.kind || 'text'
    if (
      kind !== 'text' &&
      kind !== 'reasoning' &&
      kind !== 'message' &&
      kind !== 'tool_call' &&
      kind !== 'tool'
    ) {
      continue
    }

    const text = payloadText(row.payload as Record<string, unknown> | undefined)
    const isTool = kind === 'tool_call' || kind === 'tool'
    const clientSubmitId =
      typeof row.payload?.clientSubmitId === 'string'
        ? row.payload.clientSubmitId
        : row.messageId.startsWith('user:')
          ? row.messageId.slice('user:'.length)
          : undefined
    const turnId =
      typeof row.turnId === 'string' && row.turnId.trim()
        ? row.turnId.trim()
        : ''

    if (role === 'user') {
      assistantIndexByTurn.clear()
      out.push({
        id: row.messageId,
        messageId: row.messageId,
        role: 'user',
        content: [{ type: 'text', text }],
        text,
        timestamp: row.occurredAtUnixMs,
        turnId: row.turnId,
        sequence: row.sequence,
        version: row.version,
        __historyIndex: out.length,
        __canonical: true,
        __daemon: true,
        ...(clientSubmitId
          ? {
              clientSubmitId,
              clientId: clientSubmitId,
              client_id: clientSubmitId,
            }
          : {}),
      })
      continue
    }

    const isReasoning =
      kind === 'reasoning' || role === 'assistant_thinking'
    const existingIndex =
      turnId && assistantIndexByTurn.has(turnId)
        ? assistantIndexByTurn.get(turnId)!
        : -1

    // Orphan empty streaming shells (assistant:<workspaceUuid>) must not open
    // a turn host — a later real run_* row would share turnId and length-wins
    // merges can paint the next turn's body onto the prior reply.
    if (
      !isReasoning &&
      !isTool &&
      !text.trim() &&
      (row.status === 'streaming' || row.status === 'running')
    ) {
      continue
    }

    const toolContentPart = (): Record<string, unknown> | null => {
      if (!isTool) return null
      const payload = (row.payload ?? {}) as Record<string, unknown>
      const name =
        (typeof payload.toolName === 'string' && payload.toolName.trim()) ||
        (typeof payload.name === 'string' && payload.name.trim()) ||
        'tool'
      const id = row.messageId.replace(/^toolcall:/, '')
      return {
        type: 'toolCall',
        id,
        name,
        arguments: payload.input ?? payload.arguments,
        ...(typeof payload.output === 'string'
          ? { result: payload.output }
          : {}),
      }
    }

    if (existingIndex >= 0) {
      const host = out[existingIndex]!
      const content = Array.isArray(host.content)
        ? [...(host.content as Array<Record<string, unknown>>)]
        : []
      if (isReasoning) {
        if (!text.trim()) continue
        const hasThinking = content.some(
          (part) =>
            part &&
            (part.type === 'thinking' || part.type === 'redacted_thinking'),
        )
        if (!hasThinking) {
          content.unshift({ type: 'thinking', thinking: text })
        }
      } else if (isTool) {
        const part = toolContentPart()
        if (!part) continue
        const toolId = String(part.id)
        const already = content.some(
          (entry) =>
            (entry.type === 'toolCall' || entry.type === 'tool_call') &&
            String(entry.id) === toolId,
        )
        if (!already) {
          // Keep tools between thinking and text.
          const textIndex = content.findIndex((entry) => entry?.type === 'text')
          if (textIndex >= 0) content.splice(textIndex, 0, part)
          else content.push(part)
        }
      } else {
        if (!text.trim()) continue
        const withoutText = content.filter((part) => part?.type !== 'text')
        withoutText.push({ type: 'text', text })
        content.length = 0
        content.push(...withoutText)
        host.text = text
        // Prefer the durable text host id (assistant:<runId>).
        if (
          typeof row.messageId === 'string' &&
          row.messageId.startsWith('assistant:') &&
          !row.messageId.includes(':thinking')
        ) {
          host.id = row.messageId
          host.messageId = row.messageId
        }
      }
      host.content = content
      host.timestamp = Math.max(
        typeof host.timestamp === 'number' ? host.timestamp : 0,
        row.occurredAtUnixMs,
      )
      continue
    }

    if (isTool) {
      const part = toolContentPart()
      if (!part) continue
      const runFromPayload =
        typeof row.payload?.runId === 'string' ? row.payload.runId.trim() : ''
      const hostId = runFromPayload
        ? `assistant:${runFromPayload}`
        : turnId.startsWith('turn-')
          ? `assistant:${turnId.slice('turn-'.length)}`
          : `assistant:${turnId || String(part.id)}`
      const index = out.length
      if (turnId) assistantIndexByTurn.set(turnId, index)
      out.push({
        id: hostId,
        messageId: hostId,
        role: 'assistant',
        content: [part],
        timestamp: row.occurredAtUnixMs,
        turnId: row.turnId,
        sequence: row.sequence,
        version: row.version,
        __historyIndex: index,
        __canonical: true,
        __daemon: true,
        ...(clientSubmitId
          ? {
              clientSubmitId,
              clientId: clientSubmitId,
              client_id: clientSubmitId,
            }
          : {}),
      })
      continue
    }

    if (isReasoning) {
      if (!text.trim()) continue
      const index = out.length
      if (turnId) assistantIndexByTurn.set(turnId, index)
      out.push({
        id: row.messageId.replace(/:thinking$/, ''),
        messageId: row.messageId.replace(/:thinking$/, ''),
        role: 'assistant',
        content: [{ type: 'thinking', thinking: text }],
        // No top-level text — avoids textFromMessage bubble fallback.
        timestamp: row.occurredAtUnixMs,
        turnId: row.turnId,
        sequence: row.sequence,
        version: row.version,
        __historyIndex: index,
        __canonical: true,
        __daemon: true,
        ...(clientSubmitId
          ? {
              clientSubmitId,
              clientId: clientSubmitId,
              client_id: clientSubmitId,
            }
          : {}),
      })
      continue
    }

    const index = out.length
    if (turnId) assistantIndexByTurn.set(turnId, index)
    out.push({
      id: row.messageId,
      messageId: row.messageId,
      role: 'assistant',
      content: [{ type: 'text', text }],
      text,
      timestamp: row.occurredAtUnixMs,
      turnId: row.turnId,
      sequence: row.sequence,
      version: row.version,
      __historyIndex: index,
      __canonical: true,
      __daemon: true,
      ...(clientSubmitId
        ? {
            clientSubmitId,
            clientId: clientSubmitId,
            client_id: clientSubmitId,
          }
        : {}),
    })
  }

  return out
}
