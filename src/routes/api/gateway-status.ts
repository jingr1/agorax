import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import {
  HERMES_API,
  CLAUDE_DASHBOARD_URL,
  ensureGatewayCoreProbed,
  ensureGatewayEnhancedProbed,
  getGatewayMode,
} from '../../server/gateway-capabilities'
import {
  getGatewayPoolStatus,
  isGatewayPoolEnabled,
} from '../../server/gateway-pool'

export const Route = createFileRoute('/api/gateway-status')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }

        // Core probe sets mcpFallback for local control plane; kick enhanced
        // probe in the background so native mcp can flip true without blocking.
        const capabilities = await ensureGatewayCoreProbed()
        void ensureGatewayEnhancedProbed().catch(() => {})
        let pool: unknown = null
        try {
          if (isGatewayPoolEnabled()) {
            pool = {
              enabled: true,
              gateways: await getGatewayPoolStatus(),
            }
          }
        } catch {
          pool = { enabled: false }
        }
        return json({
          capabilities,
          mode: getGatewayMode(),
          claudeUrl: HERMES_API,
          dashboardUrl: CLAUDE_DASHBOARD_URL,
          gateway: {
            available: capabilities.health || capabilities.chatCompletions,
            url: HERMES_API,
          },
          dashboard: capabilities.dashboard,
          pool,
        })
      },
    },
  },
})
