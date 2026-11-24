import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '@/server/auth-middleware'
import {
  AgoraxManagedAgentHttpClient,
  AgoraxManagedAgentHttpError,
} from '@/server/agent-runtime/agorax-managed-agent-http-client'
import {
  getHermesDaemonBridgeClient,
  hermesDaemonWorkspaceId,
} from '@/server/hermes-daemon-bridge'
import type { AgentActivityEditRetryAvailability } from '@agorax/agent-activity-core'

/**
 * Tutti-aligned Hermes session detail for authoritative reconcile fence.
 * Reads daemon activity under workspace `hermes:<profile>`.
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
        const client = getHermesDaemonBridgeClient({ profileName: profile })
        if (!client) {
          return json(
            { error: 'Hermes daemon transport is not configured' },
            { status: 503 },
          )
        }
        try {
          // Prefer full activity aggregate (same client as managed).
          const baseUrl = process.env.AGORAX_MANAGED_AGENT_URL!.trim()
          const workspaceId = hermesDaemonWorkspaceId(profile)
          const http = new AgoraxManagedAgentHttpClient({
            baseUrl,
            workspaceId,
          })
          const detail = await http.getSessionDetail(sessionId)
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
