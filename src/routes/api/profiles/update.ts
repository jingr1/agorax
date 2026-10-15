import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import {
  updateProfileConfig,
  updateProfileModelProvider,
} from '../../../server/profiles-browser'
import { requireJsonContentType } from '../../../server/rate-limit'

export const Route = createFileRoute('/api/profiles/update')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        const csrfCheck = requireJsonContentType(request)
        if (csrfCheck) return csrfCheck
        try {
          const body = (await request.json()) as {
            name?: string
            patch?: Record<string, unknown>
            providerId?: string
            modelId?: string
          }
          const providerId = body.providerId?.trim() || ''
          const modelId = body.modelId?.trim() || ''
          if (providerId && modelId) {
            const profile = updateProfileModelProvider(
              body.name || '',
              providerId,
              modelId,
            )
            return json({ ok: true, profile })
          }
          if (!body.patch || typeof body.patch !== 'object') {
            return json(
              { error: 'patch is required, or provide providerId and modelId' },
              { status: 400 },
            )
          }
          const profile = updateProfileConfig(body.name || '', body.patch)
          return json({ ok: true, profile })
        } catch (error) {
          return json(
            {
              error:
                error instanceof Error
                  ? error.message
                  : 'Failed to update profile',
            },
            { status: 500 },
          )
        }
      },
    },
  },
})
