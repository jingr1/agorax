import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../../server/auth-middleware'
import {
  readCodexConfig,
  resolveCodexProviderDisplay,
  listCodexModels,
} from '../../../../server/codex-settings'

/**
 * GET /api/agents/codex-impl/models
 *
 * Models for the Codex chat picker. Prefer the Hermes provider catalog model
 * list when the configured provider matches a catalog entry, otherwise fall
 * back to models declared in ~/.codex/config.toml.
 */
export const Route = createFileRoute('/api/agents/codex-impl/models')({
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
          models,
          currentModel: cfg.model,
          currentProvider: providerName || cfg.provider,
          providers: cfg.provider
            ? [{ id: cfg.provider, name: providerName || cfg.provider }]
            : [],
        })
      },
    },
  },
})
