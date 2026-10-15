import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import {
  ensureGatewayCoreProbed,
  getConfig,
  getGatewayCapabilities,
  getSession,
} from '../../server/hermes-api'
import {
  isSyntheticSessionKey,
  resolveMainChatSessionId,
} from '../../server/session-utils'
import { getLocalSession } from '../../server/local-session-store'
import {
  listSessionsForProfile,
  getActiveProfileName,
} from '../../server/profiles-browser'
import { getActiveRunForSession } from '../../server/run-store'
import { isAuthenticated } from '@/server/auth-middleware'
import { readContextUsage } from '@/server/context-usage'

function estimateTokensFromText(text: string): number {
  const chars = text.trim().length
  return chars > 0 ? Math.max(1, Math.ceil(chars / 4)) : 0
}

export const Route = createFileRoute('/api/session-status')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }

        // Probe the gateway with a hard timeout so the session-status response
        // is never blocked by a slow/unreachable gateway. Core probes use a
        // 400ms loopback timeout; enhanced MCP/conductor probes run in the
        // background and must not delay this endpoint.
        const GATEWAY_PROBE_DEADLINE_MS = 4_000
        try {
          await Promise.race([
            ensureGatewayCoreProbed(),
            new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(new Error('Gateway probe deadline exceeded')),
                GATEWAY_PROBE_DEADLINE_MS,
              ),
            ),
          ])
        } catch {
          return json({
            ok: true,
            payload: {
              status: 'idle',
              sessionKey: 'new',
              sessionLabel: '',
              model: '',
              modelProvider: '',
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              sessions: [],
            },
          })
        }

        try {
          const capabilities = getGatewayCapabilities()
          if (!capabilities.sessions) {
            return json({
              ok: true,
              payload: {
                status: 'idle',
                sessionKey: 'new',
                sessionLabel: '',
                model: '',
                modelProvider: '',
                inputTokens: 0,
                outputTokens: 0,
                totalTokens: 0,
                sessions: [],
              },
            })
          }
          const url = new URL(request.url)
          const requestedKey = url.searchParams.get('sessionKey')?.trim() || ''
          const profileParam =
            url.searchParams.get('profile')?.trim() ||
            getActiveProfileName() ||
            'default'
          let sessionKey = requestedKey || 'main'

          if (sessionKey === 'new') {
            const contextUsage = await readContextUsage('new')
            return json({
              ok: true,
              payload: {
                status: 'idle',
                sessionKey: 'new',
                sessionLabel: '',
                model: contextUsage.model,
                modelProvider: '',
                inputTokens: 0,
                outputTokens: 0,
                totalTokens: 0,
                contextPercent: contextUsage.contextPercent,
                maxTokens: contextUsage.maxTokens,
                usedTokens: contextUsage.usedTokens,
                sessions: [],
              },
            })
          }

          if (sessionKey === 'main') {
            try {
              const profile = profileParam
              const rawSessions = listSessionsForProfile(profile)
              const sessions = rawSessions.map((s) => ({
                id: s.key,
                title: s.title,
                message_count: s.messageCount ?? 0,
              }))
              const candidate = resolveMainChatSessionId(sessions)
              if (candidate) {
                sessionKey = candidate
              }
            } catch {
              // Fall through to local/synthetic handling below.
            }
          }

          const localSession = getLocalSession(sessionKey)
          if (localSession) {
            const contextUsage = await readContextUsage(sessionKey)
            const activeRun = await getActiveRunForSession(sessionKey)
            const outputTokens = estimateTokensFromText(
              activeRun?.assistantText ?? '',
            )
            return json({
              ok: true,
              payload: {
                status: activeRun ? activeRun.status : 'idle',
                sessionKey,
                sessionLabel: localSession.title ?? '',
                model: localSession.model ?? contextUsage.model,
                modelProvider: 'local',
                inputTokens: contextUsage.usedTokens,
                outputTokens,
                totalTokens: contextUsage.usedTokens + outputTokens,
                contextPercent: contextUsage.contextPercent,
                maxTokens: contextUsage.maxTokens,
                usedTokens: contextUsage.usedTokens,
                sessions: [],
              },
            })
          }

          if (isSyntheticSessionKey(sessionKey)) {
            const contextUsage = await readContextUsage(sessionKey)
            return json({
              ok: true,
              payload: {
                status: 'idle',
                sessionKey,
                sessionLabel: '',
                model: contextUsage.model,
                modelProvider: '',
                inputTokens: 0,
                outputTokens: 0,
                totalTokens: 0,
                contextPercent: contextUsage.contextPercent,
                maxTokens: contextUsage.maxTokens,
                usedTokens: contextUsage.usedTokens,
                sessions: [],
              },
            })
          }

          try {
            const session = await getSession(sessionKey)
            const config = capabilities.config
              ? await getConfig()
              : ({ model: '', provider: '' } as const)

            const inputTokens = session.input_tokens ?? 0
            const outputTokens = session.output_tokens ?? 0
            const contextUsage = await readContextUsage(session.id)

            return json({
              ok: true,
              payload: {
                status: session.ended_at ? 'ended' : 'idle',
                sessionKey: session.id,
                sessionLabel: session.title ?? '',
                model: session.model ?? config.model ?? '',
                modelProvider: config.provider ?? '',
                inputTokens,
                outputTokens,
                totalTokens: inputTokens + outputTokens,
                contextPercent: contextUsage.contextPercent,
                maxTokens: contextUsage.maxTokens,
                usedTokens: contextUsage.usedTokens,
                sessions: [
                  {
                    key: session.id,
                    agentId: session.id,
                    label: session.title ?? session.id,
                    model: session.model ?? config.model ?? '',
                    modelProvider: config.provider ?? '',
                    updatedAt: session.last_active ?? session.started_at ?? 0,
                    usage: {
                      input: inputTokens,
                      output: outputTokens,
                    },
                  },
                ],
              },
            })
          } catch (sessionErr) {
            const message =
              sessionErr instanceof Error
                ? sessionErr.message
                : String(sessionErr)
            // During profile switches the gateway is often briefly unreachable
            // ("fetch failed"). Treat as idle rather than hard-failing the meter.
            if (
              /not found|404/i.test(message) ||
              /fetch failed|failed to fetch|econnrefused|timeout|network/i.test(
                message,
              )
            ) {
              const contextUsage = await readContextUsage(sessionKey)
              return json({
                ok: true,
                payload: {
                  status: 'idle',
                  sessionKey,
                  sessionLabel: '',
                  model: contextUsage.model,
                  modelProvider: '',
                  inputTokens: 0,
                  outputTokens: 0,
                  totalTokens: 0,
                  contextPercent: contextUsage.contextPercent,
                  maxTokens: contextUsage.maxTokens,
                  usedTokens: contextUsage.usedTokens,
                  sessions: [],
                },
              })
            }
            throw sessionErr
          }
        } catch (err) {
          return json(
            {
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            },
            { status: 503 },
          )
        }
      },
    },
  },
})
