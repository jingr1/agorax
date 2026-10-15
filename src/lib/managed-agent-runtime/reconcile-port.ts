// Client-safe reconcile port for the Agorax managed-agent engine session.
//
// Implements the core `AgentActivitySessionReconcilePort` over the workspace
// server routes:
//   GET /api/agents/<agentId>/engine/session/<displaySessionId>/detail
//   GET /api/agents/<agentId>/engine/session/<displaySessionId>/messages?afterVersion=&limit=
//
// The messages route only supports forward `afterVersion` pagination, so the
// port paginates to exhaustion and assembles the page shape the reconcile
// executor expects for its asc / desc / beforeVersion query patterns.

import type {
  AgentActivityDurableMessage,
  AgentActivityMessagePage,
  AgentActivitySessionDetailSnapshot,
  AgentActivitySessionReconcilePort,
} from '@agorax/agent-activity-core'

export interface CreateManagedAgentSessionReconcilePortInput {
  agentId: string
  /** Maps a canonical agentSessionId to the server-visible display session id. */
  resolveDisplaySessionId: (agentSessionId: string) => string
  fetchImpl?: typeof fetch
  detailUrl?: (agentId: string, displaySessionId: string) => string
  messagesUrl?: (
    agentId: string,
    displaySessionId: string,
    query: { afterVersion: number; limit: number },
  ) => string
  /** Per-request page size hint sent to the server route. */
  pageLimit?: number
  /** Safety cap on afterVersion pagination depth. */
  maxPages?: number
}

export const MANAGED_AGENT_RECONCILE_DEFAULT_PAGE_LIMIT = 100
export const MANAGED_AGENT_RECONCILE_DEFAULT_MAX_PAGES = 1_000

export function managedAgentSessionDetailUrl(
  agentId: string,
  displaySessionId: string,
): string {
  return `/api/agents/${encodeURIComponent(agentId)}/engine/session/${encodeURIComponent(displaySessionId)}/detail`
}

export function managedAgentSessionMessagesUrl(
  agentId: string,
  displaySessionId: string,
  query: { afterVersion: number; limit: number },
): string {
  const params = new URLSearchParams({
    afterVersion: String(query.afterVersion),
    limit: String(query.limit),
  })
  return `/api/agents/${encodeURIComponent(agentId)}/engine/session/${encodeURIComponent(displaySessionId)}/messages?${params.toString()}`
}

export function createManagedAgentSessionReconcilePort(
  input: CreateManagedAgentSessionReconcilePortInput,
): AgentActivitySessionReconcilePort {
  const fetchImpl = input.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
  const detailUrl = input.detailUrl ?? managedAgentSessionDetailUrl
  const messagesUrl = input.messagesUrl ?? managedAgentSessionMessagesUrl
  const pageLimit = input.pageLimit ?? MANAGED_AGENT_RECONCILE_DEFAULT_PAGE_LIMIT
  const maxPages = input.maxPages ?? MANAGED_AGENT_RECONCILE_DEFAULT_MAX_PAGES

  const resolveUrlSessionId = (agentSessionId: string): string => {
    const displaySessionId = input.resolveDisplaySessionId(agentSessionId).trim()
    return displaySessionId || agentSessionId
  }

  return {
    async getSessionDetail({ agentSessionId, projection, signal }) {
      const response = await fetchImpl(detailUrl(input.agentId, resolveUrlSessionId(agentSessionId)), {
        signal,
      })
      if (!response.ok) {
        throw Object.assign(
          new Error(`Managed Agent session detail failed: ${response.status}`),
          { statusCode: response.status },
        )
      }
      const body = asRecord(await response.json().catch(() => null))
      const detail = body?.detail
      if (!isSessionDetailSnapshotLike(detail)) {
        throw new Error('Managed Agent session detail returned an invalid snapshot')
      }
      // The daemon detail route always serves the full aggregate and carries
      // no projection discriminator; the reconcile executor requires the
      // snapshot to be labeled with the projection it asked for so it can
      // trust/untrust capability values. Adapt the labels here.
      return {
        ...detail,
        projection,
        lifecycleCapabilitiesProjected: projection === 'authoritative',
      }
    },

    async listSessionMessages({ agentSessionId, afterVersion, beforeVersion, limit, order, signal }) {
      const displaySessionId = resolveUrlSessionId(agentSessionId)
      const floorVersion = normalizeVersion(afterVersion)
      const history = await loadMessageHistory(displaySessionId, floorVersion, signal)
      const latestVersion = history.reduce(
        (latest, message) => Math.max(latest, normalizeVersion(messageVersion(message))),
        0,
      )
      const ceiling = normalizeVersion(beforeVersion)
      const withinCeiling = ceiling > 0
        ? history.filter((message) => normalizeVersion(messageVersion(message)) < ceiling)
        : history
      if (order === 'desc') {
        // The executor walks `beforeVersion` pages backwards for the
        // authoritative-history read; serving the whole filtered tail in one
        // page terminates that walk after a single request round.
        if (ceiling > 0) {
          return {
            messages: withinCeiling.slice().reverse(),
            latestVersion,
            hasMore: false,
          }
        }
        const bounded = limit && limit > 0 ? withinCeiling.slice(-Math.trunc(limit)) : withinCeiling
        return {
          messages: bounded.slice().reverse(),
          latestVersion,
          hasMore: withinCeiling.length > bounded.length,
        }
      }
      return { messages: withinCeiling, latestVersion, hasMore: false }
    },
  }

  async function loadMessageHistory(
    displaySessionId: string,
    afterVersion: number,
    signal?: AbortSignal,
  ): Promise<AgentActivityDurableMessage[]> {
    const messages: AgentActivityDurableMessage[] = []
    let cursor = afterVersion
    for (let page = 0; page < maxPages; page += 1) {
      const response = await fetchImpl(
        messagesUrl(input.agentId, displaySessionId, { afterVersion: cursor, limit: pageLimit }),
        { signal },
      )
      if (!response.ok) {
        throw Object.assign(
          new Error(`Managed Agent session messages failed: ${response.status}`),
          { statusCode: response.status },
        )
      }
      const body = asRecord(await response.json().catch(() => null))
      const pageMessages = Array.isArray(body?.messages) ? body.messages : null
      if (!pageMessages || !pageMessages.every(isMessageLike)) {
        throw new Error('Managed Agent session messages returned an invalid page')
      }
      messages.push(...(pageMessages as AgentActivityDurableMessage[]))
      const latestVersion = normalizeVersion(body?.latestVersion)
      const hasMore = body?.hasMore === true
      if (!hasMore) return messages
      const nextCursor = Math.max(
        cursor,
        latestVersion,
        pageMessages.reduce(
          (latest, message) => Math.max(latest, normalizeVersion(messageVersion(message))),
          0,
        ),
      )
      if (nextCursor <= cursor) {
        throw new Error('Managed Agent session messages pagination did not advance')
      }
      cursor = nextCursor
    }
    throw new Error(`Managed Agent session messages exceeded ${maxPages} pages`)
  }
}

function isSessionDetailSnapshotLike(
  value: unknown,
): value is AgentActivitySessionDetailSnapshot {
  const detail = asRecord(value)
  const session = asRecord(detail?.session)
  return Boolean(
    detail &&
      session &&
      readTrimmedString(session.agentSessionId) &&
      Array.isArray(detail.turns) &&
      Array.isArray(detail.childSessions),
  )
}

function isMessageLike(value: unknown): boolean {
  const message = asRecord(value)
  return Boolean(
    message &&
      readTrimmedString(message.agentSessionId) &&
      readTrimmedString(message.messageId) &&
      typeof message.version === 'number',
  )
}

function messageVersion(message: unknown): unknown {
  return asRecord(message)?.version
}

function normalizeVersion(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) ? Math.max(0, value) : 0
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function readTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}
