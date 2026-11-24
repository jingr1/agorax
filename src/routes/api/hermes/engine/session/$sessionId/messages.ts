import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '@/server/auth-middleware'
import { AgoraxManagedAgentHttpError } from '@/server/agent-runtime/agorax-managed-agent-http-client'
import { findHermesDaemonMessages } from '@/server/hermes-daemon-bridge'
import { resolveHermesDaemonSessionLookup } from '@/server/agorax-run-mapping'

const MAX_MESSAGE_PAGE_LIMIT = 1000

function parseVersionQuery(
  url: URL,
): { afterVersion?: number; limit?: number } | { error: string } {
  const afterVersionRaw = url.searchParams.get('afterVersion')
  let afterVersion: number | undefined
  if (afterVersionRaw !== null && afterVersionRaw !== '') {
    const parsed = Number(afterVersionRaw)
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      return { error: 'afterVersion must be a non-negative integer' }
    }
    afterVersion = parsed
  }
  const limitRaw = url.searchParams.get('limit')
  let limit: number | undefined
  if (limitRaw !== null && limitRaw !== '') {
    const parsed = Number(limitRaw)
    if (
      !Number.isSafeInteger(parsed) ||
      parsed < 1 ||
      parsed > MAX_MESSAGE_PAGE_LIMIT
    ) {
      return {
        error: `limit must be an integer between 1 and ${MAX_MESSAGE_PAGE_LIMIT}`,
      }
    }
    limit = parsed
  }
  return { afterVersion, limit }
}

/**
 * Tutti-aligned Hermes message pages for session reconcile executor.
 */
export const Route = createFileRoute(
  '/api/hermes/engine/session/$sessionId/messages',
)({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        const url = new URL(request.url)
        const profile =
          url.searchParams.get('profile')?.trim() || 'default'
        const sessionId = params.sessionId?.trim()
        if (!sessionId) {
          return json({ error: 'sessionId required' }, { status: 400 })
        }
        const baseUrl = process.env.AGORAX_MANAGED_AGENT_URL?.trim()
        if (!baseUrl) {
          return json(
            { error: 'Hermes daemon transport is not configured' },
            { status: 503 },
          )
        }
        const query = parseVersionQuery(url)
        if ('error' in query) {
          return json({ error: query.error }, { status: 400 })
        }
        try {
          const lookup = resolveHermesDaemonSessionLookup(sessionId)
          const hit = await findHermesDaemonMessages({
            candidateSessionIds: lookup.candidateSessionIds,
            preferredProfile: profile,
            afterVersion: query.afterVersion,
            limit: query.limit,
          })
          if (!hit) {
            return json(
              { error: 'workspace agent session not found' },
              { status: 404 },
            )
          }
          return json({
            messages: hit.messages,
            latestVersion: hit.latestVersion,
            hasMore: hit.hasMore,
            daemonSessionId: hit.daemonSessionId,
            resolvedProfile: hit.profileName,
          })
        } catch (error) {
          const status =
            error instanceof AgoraxManagedAgentHttpError && error.status === 404
              ? 404
              : 502
          return json(
            {
              error: error instanceof Error ? error.message : String(error),
            },
            { status },
          )
        }
      },
    },
  },
})
