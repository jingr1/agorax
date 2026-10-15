import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import { AgoraxManagedAgentHttpClient } from '../../../server/agent-runtime/agorax-managed-agent-http-client'
import { aggregateAgentRuntimeStatus } from '../../../server/agent-runtime/aggregate-runtime-status'
import type { AgentProviderStatusListDto } from '@/lib/managed-agent-runtime/provider-status'

/**
 * GET /api/agent-runtime/status — aggregates managed daemon provider status
 * with Hermes Agent (update-system) and an honest deepseek stub. When the
 * daemon is unreachable, managed providers still appear as offline stubs
 * (service unavailable) so the Runtimes catalog stays complete.
 *
 * Hermes update tips are **local-only** here (no `git fetch`). Remote checks
 * live solely on `GET /api/update/status`.
 *
 * Pass `?refresh=1` for interactive「重新检测」— forwards ForceRefresh to the
 * daemon so the 30m readiness cache cannot keep a ghost "installed" row.
 */
export const Route = createFileRoute('/api/agent-runtime/status')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        const url = new URL(request.url)
        const refresh =
          url.searchParams.get('refresh') === '1' ||
          url.searchParams.get('refresh') === 'true' ||
          url.searchParams.get('forceRefresh') === '1' ||
          url.searchParams.get('forceRefresh') === 'true'
        const baseUrl = process.env.AGORAX_MANAGED_AGENT_URL?.trim()
        let daemonStatus: AgentProviderStatusListDto | null = null
        if (baseUrl) {
          try {
            daemonStatus = await new AgoraxManagedAgentHttpClient({
              baseUrl,
              workspaceId: process.env.AGORAX_WORKSPACE_ID?.trim() || 'default',
            }).getProviderStatus({ refresh })
          } catch {
            daemonStatus = null
          }
        }
        const status = await aggregateAgentRuntimeStatus(daemonStatus, {
          fetch: 'local',
          refresh: refresh || undefined,
        })
        return json(status satisfies AgentProviderStatusListDto)
      },
    },
  },
})
