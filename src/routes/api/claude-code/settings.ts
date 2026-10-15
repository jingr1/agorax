import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import {
  listClaudeCodeModels,
  maskClaudeCodeSettings,
  patchClaudeCodeSettings,
  readClaudeCodeSettings,
} from '../../../server/claude-code-settings'
import {
  getCatalogProviderCredential,
  listCatalogProvidersForClaudeCode,
} from '../../../server/provider-catalog'

/**
 * GET /api/claude-code/settings
 * PATCH /api/claude-code/settings
 *
 * Read/write Claude Code's ~/.claude/settings.json. GET returns a masked
 * snapshot (env values are hidden); PATCH merges partial updates and returns
 * the refreshed model list so callers can refresh their picker immediately.
 *
 * PATCH also accepts `copyFromCatalogProvider: <id>` to copy a provider's
 * real base_url/API key from the Hermes provider catalog (Model & Provider
 * page) into ~/.claude/settings.json. Resolution happens entirely
 * server-side — the raw secret is never sent to the browser.
 */
export const Route = createFileRoute('/api/claude-code/settings')({
  server: {
    handlers: {
      GET: ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }

        const settings = readClaudeCodeSettings()
        const listed = listClaudeCodeModels(settings)
        return json({
          ok: true,
          settings: maskClaudeCodeSettings(settings),
          models: listed.models,
          currentModel: listed.currentModel,
          currentProvider: listed.currentProvider,
          // Every provider configured on the Hermes Model & Provider page,
          // for the panel's provider dropdown.
          catalogProviders: listCatalogProvidersForClaudeCode(),
        })
      },
      PATCH: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }

        let body: Record<string, unknown>
        try {
          body = (await request.json()) as Record<string, unknown>
        } catch {
          return json({ ok: false, error: 'Invalid JSON body' }, { status: 400 })
        }

        const patch: {
          model?: string
          env?: Record<string, string | number | boolean | null | undefined>
        } = {}

        if (typeof body.model === 'string') {
          patch.model = body.model
        }
        if (body.env && typeof body.env === 'object') {
          patch.env = body.env as Record<
            string,
            string | number | boolean | null | undefined
          >
        }

        const copyFromCatalogProvider =
          typeof body.copyFromCatalogProvider === 'string'
            ? body.copyFromCatalogProvider.trim()
            : ''
        const authMode = body.authMode === 'auth_token' ? 'auth_token' : 'api_key'
        if (copyFromCatalogProvider) {
          const credential = getCatalogProviderCredential(
            copyFromCatalogProvider,
          )
          if (!credential) {
            return json(
              { ok: false, error: `Unknown provider ${copyFromCatalogProvider}` },
              { status: 400 },
            )
          }
          patch.env = {
            ...patch.env,
            ANTHROPIC_BASE_URL:
              credential.baseUrl.replace(/\/v1\/?$/, '') || null,
            ...(credential.apiKey
              ? authMode === 'auth_token'
                ? {
                    ANTHROPIC_AUTH_TOKEN: credential.apiKey,
                    ANTHROPIC_API_KEY: null,
                  }
                : {
                    ANTHROPIC_API_KEY: credential.apiKey,
                    ANTHROPIC_AUTH_TOKEN: null,
                  }
              : {}),
          }
        }

        try {
          const nextSettings = patchClaudeCodeSettings(patch)
          const listed = listClaudeCodeModels(nextSettings)
          return json({
            ok: true,
            settings: maskClaudeCodeSettings(nextSettings),
            models: listed.models,
            currentModel: listed.currentModel,
            currentProvider: listed.currentProvider,
          })
        } catch (err) {
          return json(
            {
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            },
            { status: 500 },
          )
        }
      },
    },
  },
})
