/**
 * Tutti-aligned Hermes session reconcile port.
 *
 * Mirrors managed `createManagedAgentSessionReconcilePort`, but reads the
 * Hermes daemon workspace (`hermes:<profile>`) via:
 *   GET /api/hermes/engine/session/<id>/detail?profile=
 *   GET /api/hermes/engine/session/<id>/messages?profile=&afterVersion=
 *
 * Detail responses attach `editRetry.historyRevision = session.messageVersion`
 * so `createAgentActivitySessionReconcileExecutor` can fence authoritative
 * replaces the same way Tutti does.
 */

import type {
  AgentActivityDurableMessage,
  AgentActivitySessionDetailSnapshot,
  AgentActivitySessionReconcilePort,
} from '@agorax/agent-activity-core'

export interface CreateHermesSessionReconcilePortInput {
  profileName: string
  fetchImpl?: typeof fetch
  pageLimit?: number
  maxPages?: number
}

export const HERMES_RECONCILE_DEFAULT_PAGE_LIMIT = 100
export const HERMES_RECONCILE_DEFAULT_MAX_PAGES = 1_000

export function hermesSessionDetailUrl(
  sessionId: string,
  profileName: string,
): string {
  const params = new URLSearchParams({ profile: profileName })
  return `/api/hermes/engine/session/${encodeURIComponent(sessionId)}/detail?${params}`
}

export function hermesSessionMessagesUrl(
  sessionId: string,
  profileName: string,
  query: { afterVersion: number; limit: number },
): string {
  const params = new URLSearchParams({
    profile: profileName,
    afterVersion: String(query.afterVersion),
    limit: String(query.limit),
  })
  return `/api/hermes/engine/session/${encodeURIComponent(sessionId)}/messages?${params}`
}

export function createHermesSessionReconcilePort(
  input: CreateHermesSessionReconcilePortInput,
): AgentActivitySessionReconcilePort {
  const fetchImpl =
    input.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
  const profileName = input.profileName.trim() || 'default'
  const pageLimit = input.pageLimit ?? HERMES_RECONCILE_DEFAULT_PAGE_LIMIT
  const maxPages = input.maxPages ?? HERMES_RECONCILE_DEFAULT_MAX_PAGES

  return {
    async getSessionDetail({ agentSessionId, projection, signal }) {
      const response = await fetchImpl(
        hermesSessionDetailUrl(agentSessionId, profileName),
        { signal },
      )
      if (!response.ok) {
        throw Object.assign(
          new Error(`Hermes session detail failed: ${response.status}`),
          { statusCode: response.status },
        )
      }
      const body = asRecord(await response.json().catch(() => null))
      const detail = body?.detail
      if (!isSessionDetailSnapshotLike(detail)) {
        throw new Error('Hermes session detail returned an invalid snapshot')
      }
      return {
        ...detail,
        projection,
        lifecycleCapabilitiesProjected: projection === 'authoritative',
      }
    },

    async listSessionMessages({
      agentSessionId,
      afterVersion,
      beforeVersion,
      limit,
      order,
      signal,
    }) {
      const floorVersion = normalizeVersion(afterVersion)
      const history = await loadMessageHistory(
        agentSessionId,
        floorVersion,
        signal,
      )
      const latestVersion = history.reduce(
        (latest, message) =>
          Math.max(latest, normalizeVersion(messageVersion(message))),
        0,
      )
      const ceiling = normalizeVersion(beforeVersion)
      const withinCeiling =
        ceiling > 0
          ? history.filter(
              (message) => normalizeVersion(messageVersion(message)) < ceiling,
            )
          : history
      if (order === 'desc') {
        if (ceiling > 0) {
          return {
            messages: withinCeiling.slice().reverse(),
            latestVersion,
            hasMore: false,
          }
        }
        const bounded =
          limit && limit > 0
            ? withinCeiling.slice(-Math.trunc(limit))
            : withinCeiling
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
    agentSessionId: string,
    afterVersion: number,
    signal?: AbortSignal,
  ): Promise<AgentActivityDurableMessage[]> {
    const messages: AgentActivityDurableMessage[] = []
    let cursor = afterVersion
    for (let page = 0; page < maxPages; page += 1) {
      const response = await fetchImpl(
        hermesSessionMessagesUrl(agentSessionId, profileName, {
          afterVersion: cursor,
          limit: pageLimit,
        }),
        { signal },
      )
      if (!response.ok) {
        throw Object.assign(
          new Error(`Hermes session messages failed: ${response.status}`),
          { statusCode: response.status },
        )
      }
      const body = asRecord(await response.json().catch(() => null))
      const pageMessages = Array.isArray(body?.messages) ? body.messages : null
      if (!pageMessages || !pageMessages.every(isMessageLike)) {
        throw new Error('Hermes session messages returned an invalid page')
      }
      messages.push(...(pageMessages as AgentActivityDurableMessage[]))
      const latestVersion = normalizeVersion(body?.latestVersion)
      const hasMore = body?.hasMore === true
      if (!hasMore) return messages
      const nextCursor = Math.max(
        cursor,
        latestVersion,
        pageMessages.reduce(
          (latest, message) =>
            Math.max(latest, normalizeVersion(messageVersion(message))),
          0,
        ),
      )
      if (nextCursor <= cursor) {
        throw new Error('Hermes session messages pagination did not advance')
      }
      cursor = nextCursor
    }
    throw new Error(`Hermes session messages exceeded ${maxPages} pages`)
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
  return typeof value === 'number' && Number.isSafeInteger(value)
    ? Math.max(0, value)
    : 0
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
