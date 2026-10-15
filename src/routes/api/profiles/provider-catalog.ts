import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import {
  getProviderCatalog,
  isBuiltinCatalogProvider,
  readProfileProviderSelection,
  removeCatalogProvider,
  updateProfileFallback,
  upsertCatalogKey,
  upsertCatalogProvider,
} from '../../../server/provider-catalog'
import { requireJsonContentType } from '../../../server/rate-limit'

export const Route = createFileRoute('/api/profiles/provider-catalog')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        try {
          const url = new URL(request.url)
          const profile = (url.searchParams.get('profile') || '').trim()
          return json({
            ok: true,
            catalog: getProviderCatalog(),
            selection: profile ? readProfileProviderSelection(profile) : null,
          })
        } catch (error) {
          return json(
            {
              error:
                error instanceof Error
                  ? error.message
                  : 'Failed to read provider catalog',
            },
            { status: 500 },
          )
        }
      },
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        const csrfCheck = requireJsonContentType(request)
        if (csrfCheck) return csrfCheck
        try {
          const body = (await request.json()) as {
            action?: string
            id?: string
            name?: string
            base_url?: string
            key_env?: string
            key_value?: string
            value?: string
            models?: Array<string>
            providerId?: string
            modelId?: string
          }
          const action = body.action?.trim() || ''
          if (action === 'upsert-provider') {
            const catalog = upsertCatalogProvider({
              id: body.id || '',
              name: body.name,
              base_url: body.base_url,
              key_env: body.key_env,
              key_value: body.key_value,
              models: body.models,
            })
            return json({
              ok: true,
              catalog,
              message: `Provider ${body.id} saved to all profiles.`,
            })
          }
          if (action === 'upsert-key') {
            const catalog = upsertCatalogKey(
              body.name || body.key_env || '',
              body.value || body.key_value || '',
              body.id || body.providerId,
            )
            const builtin = isBuiltinCatalogProvider(
              body.id || body.providerId || '',
            )
            return json({
              ok: true,
              catalog,
              message: builtin
                ? 'API key saved to all profile .env files.'
                : 'API key saved to all profiles.',
            })
          }
          if (action === 'remove-provider') {
            const id = body.id || body.providerId || ''
            const builtin = isBuiltinCatalogProvider(id)
            const catalog = removeCatalogProvider(id)
            return json({
              ok: true,
              catalog,
              message: builtin
                ? `Cleared ${id} API key from all profiles.`
                : `Removed provider ${id} from all profiles.`,
            })
          }
          if (action === 'select-fallback') {
            const selection = updateProfileFallback(
              body.name || '',
              body.providerId || '',
              body.modelId || '',
            )
            return json({
              ok: true,
              catalog: getProviderCatalog(),
              selection,
              message: `Fallback updated for ${body.name || 'default'}.`,
            })
          }
          return json({ error: 'Unknown action' }, { status: 400 })
        } catch (error) {
          return json(
            {
              error:
                error instanceof Error
                  ? error.message
                  : 'Failed to update provider catalog',
            },
            { status: 500 },
          )
        }
      },
    },
  },
})
