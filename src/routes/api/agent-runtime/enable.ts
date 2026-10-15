import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import { AgoraxManagedAgentHttpClient } from '../../../server/agent-runtime/agorax-managed-agent-http-client'
import { AGENT_PROVIDER_IDS } from '@/lib/managed-agent-runtime/provider-status'

const PROVIDER_ID_SET = new Set<string>(AGENT_PROVIDER_IDS)

/**
 * POST /api/agent-runtime/enable — enables or disables a managed provider
 * runtime in the embedded daemon. Body: `{ provider: string, enabled: boolean }`.
 * The daemon filters the provider out of registered targets when disabled,
 * which the Runtimes page renders as the "enabled" Switch.
 */
export const Route = createFileRoute('/api/agent-runtime/enable')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        const body = (await request.json().catch(() => null)) as Record<
          string,
          unknown
        > | null
        const provider =
          typeof body?.provider === 'string' ? body.provider.trim() : ''
        const enabled = body?.enabled === true
        if (!provider) {
          return json({ error: 'provider is required' }, { status: 400 })
        }
        if (!PROVIDER_ID_SET.has(provider)) {
          return json(
            { error: `unknown provider ${provider}` },
            { status: 400 },
          )
        }
        const baseUrl = process.env.AGORAX_MANAGED_AGENT_URL?.trim()
        if (!baseUrl) {
          return json(
            { error: 'Managed Agent daemon is not configured' },
            { status: 503 },
          )
        }
        try {
          const result = await new AgoraxManagedAgentHttpClient({
            baseUrl,
            workspaceId: process.env.AGORAX_WORKSPACE_ID?.trim() || 'default',
          }).setProviderEnabled(provider, enabled)
          return json(result)
        } catch (error) {
          const status =
            error instanceof Error && 'status' in error
              ? Number((error as { status?: number }).status) || 502
              : 502
          return json(
            {
              error: `Managed Agent enable failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
            { status },
          )
        }
      },
    },
  },
})
