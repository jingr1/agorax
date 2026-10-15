import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import { AgoraxManagedAgentHttpClient } from '../../../server/agent-runtime/agorax-managed-agent-http-client'
import { AGENT_PROVIDER_IDS } from '@/lib/managed-agent-runtime/provider-status'

const PROVIDER_ID_SET = new Set<string>(AGENT_PROVIDER_IDS)

/**
 * POST /api/agent-runtime/login — ask the managed daemon to launch the
 * provider's interactive login CLI (terminal emulator when available).
 * Body: `{ provider: string }`.
 */
export const Route = createFileRoute('/api/agent-runtime/login')({
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
          const preferWebTerminal = body?.preferWebTerminal !== false
          const result = await new AgoraxManagedAgentHttpClient({
            baseUrl,
            workspaceId: process.env.AGORAX_WORKSPACE_ID?.trim() || 'default',
          }).loginProvider(provider, { preferWebTerminal })
          return json(result)
        } catch (error) {
          const status =
            error instanceof Error && 'status' in error
              ? Number((error as { status?: number }).status) || 502
              : 502
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
              error: `Managed Agent login failed: ${
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
