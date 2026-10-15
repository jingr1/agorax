import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import {
  getGatewayPoolStatus,
  isGatewayPoolEnabled,
} from '../../server/gateway-pool'
import { getActiveProfileName } from '../../server/profiles-browser'
import { HERMES_API } from '../../server/gateway-capabilities'

export const Route = createFileRoute('/api/gateway-pool')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        const enabled = isGatewayPoolEnabled()
        const gateways = enabled ? await getGatewayPoolStatus() : []
        return json({
          enabled,
          activeProfile: getActiveProfileName(),
          routedUrl: HERMES_API,
          gateways,
        })
      },
    },
  },
})
