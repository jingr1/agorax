import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../../server/auth-middleware'
import {
  listClaudeCodeModels,
  readClaudeCodeSettings,
} from '../../../../server/claude-code-settings'

/**
 * GET /api/agents/claude-code/models
 *
 * Models for the Claude Code chat picker — sourced from
 * ~/.claude/settings.json (ANTHROPIC_DEFAULT_* + current model), not the
 * Hermes /api/models provider catalog.
 */
export const Route = createFileRoute('/api/agents/claude-code/models')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }

        const listed = listClaudeCodeModels(readClaudeCodeSettings())
        return json({
          ok: true,
          models: listed.models,
          currentModel: listed.currentModel,
          currentProvider: listed.currentProvider,
          configuredProviders: listed.currentProvider
            ? [listed.currentProvider]
            : [],
          providerLabels: {
            [listed.currentProvider]: listed.currentProvider,
          },
          providers: listed.currentProvider
            ? [{ id: listed.currentProvider, name: listed.currentProvider }]
            : [],
        })
      },
    },
  },
})
