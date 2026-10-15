import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { z } from 'zod'

const BodySchema = z.object({
  provider: z.string().min(1),
  deviceCode: z.string().min(1),
})

type PortalOAuthPollResponse = {
  status?: unknown
  error?: unknown
  error_message?: unknown
  message?: unknown
  access_token?: unknown
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

// RFC 8628 device-flow intermediate states — keep polling.
const PENDING_STATUSES = new Set([
  'pending',
  'authorization_pending',
  'slow_down',
])

export function mapDashboardOAuthPoll(data: PortalOAuthPollResponse) {
  const status = readString(data.status)
  if (status === 'approved' || status === 'success' || data.access_token) {
    return { status: 'success' }
  }
  if (PENDING_STATUSES.has(status)) return { status: 'pending' }

  return {
    status: 'error',
    message:
      readString(data.error_message) ||
      readString(data.message) ||
      readString(data.error) ||
      (status ? `OAuth ${status}` : 'OAuth authorization failed'),
  }
}

function readError(data: unknown, fallback: string): string {
  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>
    if (typeof record.detail === 'string') return record.detail
    if (typeof record.error === 'string') return record.error
    if (typeof record.message === 'string') return record.message
  }
  return fallback
}

export const Route = createFileRoute('/api/oauth/poll-token')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: unknown
        try {
          body = await request.json()
        } catch {
          return json({ error: 'Invalid JSON' }, { status: 400 })
        }

        const parsed = BodySchema.safeParse(body)
        if (!parsed.success) {
          return json(
            { status: 'error', message: 'Missing provider or deviceCode' },
            { status: 400 },
          )
        }

        const provider = parsed.data.provider.trim()
        const deviceCode = parsed.data.deviceCode.trim()

        if (provider !== 'nous') {
          return json({
            status: 'error',
            message: `OAuth device flow not supported for provider: ${provider}`,
          })
        }

        try {
          // Mirror oauth.device-code.ts: talk to Nous Portal directly.
          // Do not proxy through Hermes Dashboard :9119.
          const res = await fetch(
            'https://portal.nousresearch.com/api/oauth/device/token',
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
              },
              body: new URLSearchParams({
                client_id: 'claude-cli',
                device_code: deviceCode,
                grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
              }).toString(),
              signal: AbortSignal.timeout(15_000),
            },
          )
          const data = (await res.json().catch(() => ({}))) as PortalOAuthPollResponse

          if (!res.ok) {
            const mapped = mapDashboardOAuthPoll({
              ...data,
              status:
                readString(data.error) ||
                readString(data.status) ||
                (res.status === 400 ? 'authorization_pending' : 'error'),
            })
            if (mapped.status === 'pending') return json(mapped)
            return json({
              status: 'error',
              message: readError(data, 'OAuth polling failed'),
            })
          }

          return json(mapDashboardOAuthPoll(data))
        } catch (err) {
          return json({
            status: 'error',
            message: err instanceof Error ? err.message : 'Network error',
          })
        }
      },
    },
  },
})
