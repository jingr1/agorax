import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import { updateAllProfilesModelProvider } from '../../../server/profiles-browser'
import { requireJsonContentType } from '../../../server/rate-limit'

export const Route = createFileRoute('/api/profiles/update-all-model-provider')(
  {
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
              providerId?: string
              modelId?: string
            }
            const providerId = body.providerId?.trim() || ''
            const modelId = body.modelId?.trim() || ''
            if (!providerId || !modelId) {
              return json(
                { error: 'providerId and modelId are required' },
                { status: 400 },
              )
            }
            const result = updateAllProfilesModelProvider(providerId, modelId)
            const failed = result.updated.filter((entry) => !entry.ok)
            return json({
              ok: failed.length === 0,
              message:
                failed.length === 0
                  ? `Default model updated for ${result.updated.length} profiles.`
                  : `Updated ${result.updated.length - failed.length} profiles; ${failed.length} failed.`,
              updated: result.updated,
            })
          } catch (error) {
            return json(
              {
                error:
                  error instanceof Error
                    ? error.message
                    : 'Failed to update profiles',
              },
              { status: 500 },
            )
          }
        },
      },
    },
  },
)
