import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import {
  getGatewayPoolStatus,
  isGatewayPoolEnabled,
  resolveProfileGatewayPort,
} from '../../../server/gateway-pool'
import {
  listProfilesLight,
  listProfilesWithFallback,
} from '../../../server/profiles-browser'

export const Route = createFileRoute('/api/profiles/list')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        try {
          const url = new URL(request.url, 'http://localhost')
          const light = url.searchParams.get('light') === '1'

          if (light) {
            const profiles = listProfilesLight()
            const activeProfile =
              profiles.find((p) => p.active)?.name || 'default'
            return json({ profiles, activeProfile })
          }

          const { profiles, activeProfile } = await listProfilesWithFallback()
          if (!isGatewayPoolEnabled()) {
            return json({ profiles, activeProfile })
          }
          const pool = await getGatewayPoolStatus()
          const byName = new Map(pool.map((entry) => [entry.profile, entry]))
          return json({
            profiles: profiles.map((profile) => {
              const gateway = byName.get(profile.name)
              const port =
                gateway?.port ?? resolveProfileGatewayPort(profile.name)
              return {
                ...profile,
                gatewayPort: port,
                gatewayUrl: gateway?.url ?? `http://127.0.0.1:${port}`,
                gatewayState: gateway?.state ?? 'stopped',
              }
            }),
            activeProfile,
            gatewayPool: pool,
          })
        } catch (error) {
          return json(
            {
              error:
                error instanceof Error
                  ? error.message
                  : 'Failed to list profiles',
              profiles: [],
            },
            { status: 500 },
          )
        }
      },
    },
  },
})
