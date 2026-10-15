import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import { AgoraxManagedAgentHttpClient } from '../../../server/agent-runtime/agorax-managed-agent-http-client'
import { AGENT_PROVIDER_IDS } from '@/lib/managed-agent-runtime/provider-status'
import { applyAgentUpdate } from '../../../server/update-system'

const PROVIDER_ID_SET = new Set<string>([...AGENT_PROVIDER_IDS, 'hermes'])

/**
 * POST /api/agent-runtime/install — managed npm install/upgrade for daemon
 * providers, or Hermes Agent git upgrade via `applyAgentUpdate` when
 * `provider=hermes`. Body: `{ provider: string, version?: string }`.
 */
export const Route = createFileRoute('/api/agent-runtime/install')({
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
        const provider = typeof body?.provider === 'string' ? body.provider.trim() : ''
        const version = typeof body?.version === 'string' ? body.version.trim() : ''
        if (!provider) {
          return json({ error: 'provider is required' }, { status: 400 })
        }
        if (!PROVIDER_ID_SET.has(provider)) {
          return json(
            { error: `unknown provider ${provider}` },
            { status: 400 },
          )
        }
        if (provider === 'hermes') {
          try {
            const result = await applyAgentUpdate()
            if (!result.ok) {
              return json(
                { error: result.error || 'Hermes Agent update failed' },
                { status: 502 },
              )
            }
            return json({
              provider: 'hermes',
              status: 'installed' as const,
              version: result.status?.version,
            })
          } catch (error) {
            return json(
              {
                error: `Hermes Agent update failed: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              },
              { status: 502 },
            )
          }
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
          }).installProvider(provider, version ? { version } : undefined)
          return json(result)
        } catch (error) {
          const status =
            error instanceof Error && 'status' in error
              ? Number((error as { status?: number }).status) || 502
              : 502
          // Concurrent install is progress, not failure — UI shows 安装中.
          if (
            status === 409 ||
            (error instanceof Error &&
              /already in progress/i.test(error.message))
          ) {
            return json({
              provider,
              status: 'in_progress' as const,
            })
          }
          return json(
            {
              error: `Managed Agent install failed: ${
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
