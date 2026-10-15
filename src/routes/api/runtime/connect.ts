import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import { ensureManagedAgentDaemon } from '../../../server/agent-runtime/managed-agent-daemon'
import { ensureActiveProfileGateway } from '../../../server/gateway-pool'

type RuntimeLink = {
  ok: boolean
  detail: string
  url?: string
}

function hermesLink(result: {
  ok: boolean
  message?: string
  error?: string
  url?: string
}): RuntimeLink {
  if (result.ok) {
    return {
      ok: true,
      detail: result.message || 'connected',
      url: result.url,
    }
  }
  return {
    ok: false,
    detail: result.error || 'Hermes Agent gateway did not start',
  }
}

/**
 * POST /api/runtime/connect — bring up the two product runtimes:
 * Hermes Agent gateway and the managed-agent daemon.
 * Each side is a no-op when it is already healthy.
 */
export const Route = createFileRoute('/api/runtime/connect')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }

        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          const deadline = new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('runtime connect timed out')),
              8_000,
            )
          })
          const [hermesResult, managedResult] = await Promise.race([
            Promise.all([
              ensureActiveProfileGateway().catch((error: unknown) => {
                const detail =
                  error instanceof Error ? error.message : String(error)
                return {
                  ok: false as const,
                  error: detail,
                }
              }),
              ensureManagedAgentDaemon().catch((error: unknown) => ({
                ok: false,
                healthy: false,
                detail: error instanceof Error ? error.message : String(error),
              })),
            ]),
            deadline,
          ])

          const hermes = hermesLink(hermesResult)
          const managed: RuntimeLink = {
            ok: managedResult.ok && managedResult.healthy,
            detail: managedResult.detail,
          }
          const ok = hermes.ok && managed.ok

          return json({ ok, hermes, managed }, { status: ok ? 200 : 503 })
        } catch (error) {
          const detail =
            error instanceof Error ? error.message : 'runtime connect timed out'
          return json(
            {
              ok: false,
              hermes: { ok: false, detail },
              managed: { ok: false, detail },
            },
            { status: 503 },
          )
        } finally {
          if (timer) clearTimeout(timer)
        }
      },
    },
  },
})
