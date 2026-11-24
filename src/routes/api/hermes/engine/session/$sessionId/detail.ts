import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '@/server/auth-middleware'
import { AgoraxManagedAgentHttpError } from '@/server/agent-runtime/agorax-managed-agent-http-client'
import { findHermesDaemonSessionDetail } from '@/server/hermes-daemon-bridge'
import { resolveHermesDaemonSessionLookup } from '@/server/agorax-run-mapping'
import type { AgentActivityEditRetryAvailability } from '@agorax/agent-activity-core'

/**
 * Tutti-aligned Hermes session detail for authoritative reconcile fence.
 * Reads daemon activity under workspace `hermes:<profile>`, falling back to
 * other known Hermes profiles when the preferred workspace 404s.
 */
export const Route = createFileRoute(
  '/api/hermes/engine/session/$sessionId/detail',
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
        if (!process.env.AGORAX_MANAGED_AGENT_URL?.trim()) {
          return json(
            { error: 'Hermes daemon transport is not configured' },
            { status: 503 },
          )
        }
        try {
          const lookup = resolveHermesDaemonSessionLookup(sessionId)
          const hit = await findHermesDaemonSessionDetail({
            candidateSessionIds: lookup.candidateSessionIds,
            preferredProfile: profile,
          })
          if (!hit) {
            return json(
              { error: 'workspace agent session not found' },
              { status: 404 },
            )
          }
          const { detail } = hit
          const historyRevision = Math.max(
            0,
            typeof detail.session.messageVersion === 'number'
              ? detail.session.messageVersion
              : 0,
          )
          const editRetry: AgentActivityEditRetryAvailability = {
            supported: false,
            eligible: false,
            historyRevision,
            recoveryState: 'completed',
            availableActions: [],
          }
          return json({
            detail: {
              ...detail,
              editRetry,
              projection: 'authoritative',
              lifecycleCapabilitiesProjected: false,
            },
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
