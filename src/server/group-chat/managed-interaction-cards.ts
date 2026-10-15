/**
 * Managed-agent interaction cards for group chat.
 *
 * Canonical data flow (no second pending state machine):
 *
 *   daemon WS interaction_update (via the managed transport/activity stream)
 *     → turn-executor sees the canonical `activity` AgentStreamEvent
 *     → this module upserts a room message card whose embedded payload
 *       carries the canonical interaction verbatim (ids + status + input)
 *     → members answer through the card → POST interaction-response route
 *       writes back through the daemon HTTP client → the daemon's canonical
 *       interaction list is re-read to refresh the card in place.
 *
 * The card's displayed status ALWAYS comes from the canonical interaction
 * (event-driven during the turn, canonical list read after writeback).
 * The card wire codec itself lives in src/lib/group-chat-interaction-card.ts
 * (client-safe) so the room UI decodes the exact same shape.
 */
import type { AgentActivityInteraction } from '@agorax/agent-activity-core'
import {
  agentActivityInteractionFromDaemonInteraction,
  type DaemonCanonicalInteraction,
} from '@agorax/agent-activity-daemon-adapter'
import {
  cardPayloadFromCanonical,
  decodeManagedInteractionCard,
  encodeManagedInteractionCard,
  type ManagedInteractionCardPayload,
} from '@/lib/group-chat-interaction-card'
import { publishChatEvent } from '../chat-event-bus'
import { AgoraxManagedAgentHttpClient } from '../agent-runtime/agorax-managed-agent-http-client'
import { isAgoraxManagedAgentBackend } from '../agent-runtime/agorax-managed-agent-bridge'
import { getAgentRuntimeRouter } from '../agent-runtime/router'
import {
  getLatestMessages,
  getMessage,
  insertMessage,
  updateMessageContent,
} from './room-store'
import type { GroupMember, RoomMessage } from './types'

export {
  MANAGED_INTERACTION_CARD_MARKER,
  decodeManagedInteractionCard,
  type ManagedInteractionCardPayload,
} from '@/lib/group-chat-interaction-card'

export function findManagedInteractionCardMessage(
  roomId: string,
  identity: { agentSessionId: string; turnId: string; requestId: string },
  options?: { dbPath?: string },
): RoomMessage | null {
  for (const message of getLatestMessages(roomId, { limit: 200, ...options })) {
    const payload = decodeManagedInteractionCard(message.content)
    if (
      payload &&
      payload.agentSessionId === identity.agentSessionId &&
      payload.turnId === identity.turnId &&
      payload.requestId === identity.requestId
    ) {
      return message
    }
  }
  return null
}

/**
 * Persists (or refreshes in place) the room card for one canonical
 * interaction_update. Called from the managed member-turn event path only;
 * returns the upserted message.
 */
export function upsertManagedInteractionCard(input: {
  roomId: string
  member: GroupMember
  runId?: string | null
  interaction: AgentActivityInteraction
  dbPath?: string
}): RoomMessage | null {
  const { interaction } = input
  const payload = cardPayloadFromCanonical(interaction)
  const store = { dbPath: input.dbPath }
  const existing = findManagedInteractionCardMessage(input.roomId, payload, store)
  const message = existing
    ? updateMessageContent(
        existing.id,
        encodeManagedInteractionCard(payload),
        store,
      )
    : insertMessage({
        roomId: input.roomId,
        senderKind: 'agent',
        senderParticipantId: input.member.participantId,
        senderName: input.member.displayName,
        content: encodeManagedInteractionCard(payload),
        runId: input.runId ?? null,
        dbPath: input.dbPath,
      })
  if (message) {
    publishChatEvent('group_chat_message', {
      roomId: input.roomId,
      messageId: message.id,
    })
  }
  return message
}

/**
 * Re-reads the daemon's canonical interaction list for a session and refreshes
 * the room cards to match (canonical reads reconcile after writeback, and on
 * any missed event). Returns the number of cards refreshed.
 */
export async function refreshManagedInteractionCards(input: {
  roomId: string
  agentSessionId: string
  agentId: string
  dbPath?: string
}): Promise<number> {
  const client = managedAgentHttpClient(input.agentId)
  if (!client) return 0
  const listed = await client.listInteractions(input.agentSessionId)
  const interactions = Array.isArray(
    (listed as { interactions?: unknown }).interactions,
  )
    ? (listed as { interactions: Array<unknown> }).interactions
    : []
  let refreshed = 0
  for (const raw of interactions) {
    const canonical = mapCanonicalInteraction(raw)
    if (!canonical) continue
    const existing = findManagedInteractionCardMessage(
      input.roomId,
      {
        agentSessionId: canonical.agentSessionId,
        turnId: canonical.turnId,
        requestId: canonical.requestId,
      },
      { dbPath: input.dbPath },
    )
    if (!existing) continue
    const payload = cardPayloadFromCanonical(canonical)
    const updated = updateMessageContent(
      existing.id,
      encodeManagedInteractionCard(payload),
      { dbPath: input.dbPath },
    )
    if (updated) {
      refreshed += 1
      publishChatEvent('group_chat_message', {
        roomId: input.roomId,
        messageId: updated.id,
      })
    }
  }
  return refreshed
}

export async function respondToManagedInteractionCard(input: {
  roomId: string
  messageId: string
  action?: string
  optionId?: string
  payload?: Record<string, unknown>
  dbPath?: string
}): Promise<
  | { ok: true; status: AgentActivityInteraction['status'] }
  | { ok: false; status: number; error: string }
> {
  const message = getMessage(input.messageId, { dbPath: input.dbPath })
  if (!message || message.roomId !== input.roomId) {
    return { ok: false, status: 404, error: 'interaction card not found' }
  }
  const card = decodeManagedInteractionCard(message.content)
  if (!card) {
    return {
      ok: false,
      status: 400,
      error: 'message is not an interaction card',
    }
  }
  if (card.kind === 'plan') {
    if (input.action !== 'implement') {
      return {
        ok: false,
        status: 400,
        error: 'plan cards only support action=implement',
      }
    }
    const client = managedAgentHttpClient(message.senderParticipantId ?? '')
    if (!client) {
      return { ok: false, status: 404, error: 'Managed Agent is unavailable' }
    }
    const turnId = card.turnId.trim()
    const scopeKey = [
      'plan-implementation',
      process.env.AGORAX_WORKSPACE_ID?.trim() || 'default',
      card.agentSessionId,
      turnId,
    ].join(':')
    try {
      await client.submitPlanDecision({
        agentSessionId: card.agentSessionId,
        turnId,
        // Host SubmitPlanDecision requires requestId === turnId.
        requestId: turnId,
        promptKind: 'plan-implementation',
        action: 'implement',
        idempotencyKey: scopeKey,
      })
    } catch (error) {
      return {
        ok: false,
        status: 502,
        error: error instanceof Error ? error.message : String(error),
      }
    }
    try {
      await refreshManagedInteractionCards({
        roomId: input.roomId,
        agentSessionId: card.agentSessionId,
        agentId: message.senderParticipantId ?? '',
        dbPath: input.dbPath,
      })
    } catch (error) {
      console.warn(
        '[managed-interaction-cards] refresh after plan decision failed:',
        error instanceof Error ? error.message : String(error),
      )
    }
    const refreshed = findManagedInteractionCardMessage(input.roomId, card, {
      dbPath: input.dbPath,
    })
    const status = refreshed
      ? (decodeManagedInteractionCard(refreshed.content)?.status ?? 'answered')
      : 'answered'
    return { ok: true, status }
  }
  if (card.status !== 'pending') {
    return {
      ok: false,
      status: 409,
      error: `interaction is already ${card.status}`,
    }
  }
  const client = managedAgentHttpClient(message.senderParticipantId ?? '')
  if (!client) {
    return { ok: false, status: 404, error: 'Managed Agent is unavailable' }
  }
  try {
    await client.respondToInteraction({
      agentSessionId: card.agentSessionId,
      turnId: card.turnId,
      requestId: card.requestId,
      ...(input.action ? { action: input.action } : {}),
      ...(input.optionId ? { optionId: input.optionId } : {}),
      ...(input.payload ? { payload: input.payload } : {}),
    })
  } catch (error) {
    return {
      ok: false,
      status: 502,
      error: error instanceof Error ? error.message : String(error),
    }
  }
  // Canonical read reconcile: refresh the card from the daemon interaction
  // list so its status reflects the answered/superseded canonical truth.
  try {
    await refreshManagedInteractionCards({
      roomId: input.roomId,
      agentSessionId: card.agentSessionId,
      agentId: message.senderParticipantId ?? '',
      dbPath: input.dbPath,
    })
  } catch (error) {
    console.warn(
      '[managed-interaction-cards] refresh after respond failed:',
      error instanceof Error ? error.message : String(error),
    )
  }
  const refreshed = findManagedInteractionCardMessage(input.roomId, card, {
    dbPath: input.dbPath,
  })
  const status = refreshed
    ? (decodeManagedInteractionCard(refreshed.content)?.status ?? 'pending')
    : 'pending'
  return { ok: true, status }
}

function managedAgentHttpClient(
  agentId: string,
): AgoraxManagedAgentHttpClient | null {
  const declaration = getAgentRuntimeRouter().registry.byId.get(agentId)
  if (!declaration || !isAgoraxManagedAgentBackend(declaration.runtime)) {
    return null
  }
  const baseUrl = process.env.AGORAX_MANAGED_AGENT_URL?.trim()
  const workspaceId = process.env.AGORAX_WORKSPACE_ID?.trim()
  if (!baseUrl || !workspaceId) return null
  return new AgoraxManagedAgentHttpClient({ baseUrl, workspaceId })
}

/** PascalCase daemon DTO → canonical interaction (daemon-adapter contract). */
function mapCanonicalInteraction(
  raw: unknown,
): AgentActivityInteraction | null {
  const dto = record(raw)
  if (!dto) return null
  try {
    return agentActivityInteractionFromDaemonInteraction(
      dto as unknown as DaemonCanonicalInteraction,
    )
  } catch {
    return null
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}
