import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../../server/auth-middleware'
import {
  CODEX_CONFIG_PATH,
  listCodexModels,
  patchCodexConfig,
  readCodexConfig,
  resolveCodexProviderDisplay,
  resolveCodexProviderName,
} from '../../../../server/codex-settings'
import { listCatalogProvidersForClaudeCode } from '../../../../server/provider-catalog'

export type CodexConfigResponse = {
  ok: true
  config: {
    model: string
    provider: string
    providerName: string
    configPath: string
    catalogProviders: Array<{
      id: string
      name: string
      baseUrl: string
      models: Array<string>
      keyConfigured: boolean
      maskedKey: string
    }>
    availableModels: Array<{ id: string; name: string; provider: string }>
  }
}

export type CodexConfigPatchBody = {
  model?: string
  /** Provider id from the Hermes provider catalog. */
  provider?: string
  /** Legacy: same as provider. */
  copyFromCatalogProvider?: string
}

/**
 * GET /api/agents/codex-impl/config
 * PATCH /api/agents/codex-impl/config
 *
 * Codex runtime configuration surface. Model and provider are persisted to
 * ~/.codex/config.toml. When a Hermes catalog provider id is supplied, the
 * server reads that provider's real base_url and api_key and writes them into
 * the [model_providers.<id>] block; the raw secret is never sent to the UI.
 */
export const Route = createFileRoute('/api/agents/codex-impl/config')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }

        const cfg = readCodexConfig()
        const providerName = resolveCodexProviderDisplay(cfg)
        const models = listCodexModels(cfg)

        return json({
          ok: true,
          config: {
            model: cfg.model,
            provider: cfg.provider,
            providerName,
            configPath: CODEX_CONFIG_PATH,
            catalogProviders: listCatalogProvidersForClaudeCode(),
            availableModels: models,
          },
        })
      },
      PATCH: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }

        let body: CodexConfigPatchBody = {}
        try {
          body = (await request.json()) as CodexConfigPatchBody
        } catch {
          return json({ error: 'Invalid JSON body' }, { status: 400 })
        }

        const patch: CodexConfigPatchBody = {}
        if (typeof body.model === 'string' && body.model.trim()) {
          patch.model = body.model.trim()
        }
        // Catalog providers write a [model_providers.<id>] block; a bare provider
        // (e.g. "openai" for direct OpenAI) only updates model_provider.
        if (
          typeof body.copyFromCatalogProvider === 'string' &&
          body.copyFromCatalogProvider.trim()
        ) {
          patch.copyFromCatalogProvider = body.copyFromCatalogProvider.trim()
        } else if (
          typeof body.provider === 'string' &&
          body.provider.trim()
        ) {
          patch.provider = body.provider.trim()
        }

        try {
          patchCodexConfig(patch)
        } catch (err) {
          return json(
            {
              error:
                err instanceof Error
                  ? err.message
                  : 'Failed to write Codex config',
            },
            { status: 500 },
          )
        }

        const cfg = readCodexConfig()
        const providerName = resolveCodexProviderDisplay(cfg)
        const models = listCodexModels(cfg)

        return json({
          ok: true,
          config: {
            model: cfg.model,
            provider: cfg.provider,
            providerName,
            configPath: CODEX_CONFIG_PATH,
            catalogProviders: listCatalogProvidersForClaudeCode(),
            availableModels: models,
          },
        })
      },
    },
  },
})
