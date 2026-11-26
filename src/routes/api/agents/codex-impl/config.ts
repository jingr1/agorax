import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../../server/auth-middleware'
import {
  CODEX_CONFIG_PATH,
  listCodexModels,
  patchCodexConfig,
  readCodexConfig,
  resolveCodexProviderDisplay,
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
    modelCatalogJson?: string
  }
}

export type CodexConfigPatchBody = {
  model?: string
  /** Provider id from the Hermes provider catalog. */
  provider?: string
  /** Legacy: same as provider. */
  copyFromCatalogProvider?: string
  /** Rebuild ~/.codex/model-catalogs/<provider>.json for the active catalog provider. */
  rebuildModelCatalog?: boolean
}

function buildConfigSnapshot() {
  const cfg = readCodexConfig()
  const providerName = resolveCodexProviderDisplay(cfg)
  const models = listCodexModels(cfg)
  const modelCatalogJson =
    typeof cfg.raw.model_catalog_json === 'string'
      ? cfg.raw.model_catalog_json
      : undefined

  return {
    model: cfg.model,
    provider: cfg.provider,
    providerName,
    configPath: CODEX_CONFIG_PATH,
    catalogProviders: listCatalogProvidersForClaudeCode(),
    availableModels: models,
    modelCatalogJson,
  }
}

/**
 * GET /api/agents/codex-impl/config
 * PATCH /api/agents/codex-impl/config
 *
 * Codex runtime configuration surface. Model and provider are persisted to
 * ~/.codex/config.toml. When a Hermes catalog provider id is supplied, the
 * server reads that provider's real base_url and key env into
 * [model_providers.<id>], regenerates ~/.codex/model-catalogs/<id>.json from
 * catalog models + Hermes endpoint metadata, and sets model_catalog_json.
 * Switching to OpenAI direct clears model_catalog_json so the built-in catalog
 * is used. The raw secret is never sent to the UI.
 */
export const Route = createFileRoute('/api/agents/codex-impl/config')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }

        return json({
          ok: true,
          config: buildConfigSnapshot(),
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

        if (body.rebuildModelCatalog === true) {
          patch.rebuildModelCatalog = true
          // Rebuild-only: use the active catalog provider when the client did
          // not also send a provider switch.
          if (!patch.copyFromCatalogProvider && !patch.provider) {
            const current = readCodexConfig()
            const catalogIds = new Set(
              listCatalogProvidersForClaudeCode().map((p) => p.id),
            )
            if (current.provider && catalogIds.has(current.provider)) {
              patch.copyFromCatalogProvider = current.provider
            } else {
              return json(
                {
                  error:
                    'Rebuild catalog requires a Hermes catalog provider (not OpenAI direct)',
                },
                { status: 400 },
              )
            }
          }
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

        return json({
          ok: true,
          config: buildConfigSnapshot(),
        })
      },
    },
  },
})
