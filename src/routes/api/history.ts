import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { getMessages, toChatMessage } from '../../server/hermes-api'
import {
  resolveMainChatSessionId,
  resolveSessionKey,
} from '../../server/session-utils'
import { isAuthenticated } from '@/server/auth-middleware'
import {
  getLocalSession,
  getLocalMessages,
} from '../../server/local-session-store'
import {
  getActiveProfileName,
  getMessagesForProfile,
  listSessionsForProfile,
} from '../../server/profiles-browser'
import {
  daemonActivityToChatHistory,
  findHermesDaemonMessages,
} from '../../server/hermes-daemon-bridge'
import {
  hasHermesCanonicalMessages,
  hermesCanonicalMessagesToChatHistory,
  listHermesCanonicalMessages,
} from '../../server/hermes-canonical-store'
import { resolveHermesDaemonSessionLookup } from '../../server/agorax-run-mapping'

function legacyCanonicalHistoryJson(
  sqliteSessionId: string,
  limit: number,
) {
  const page = listHermesCanonicalMessages({
    agentSessionId: sqliteSessionId,
    limit: limit > 0 ? limit : 1000,
  })
  const chatMessages = hermesCanonicalMessagesToChatHistory(page.messages)
  const bounded = limit > 0 ? chatMessages.slice(-limit) : chatMessages
  return json({
    sessionKey: sqliteSessionId,
    sessionId: sqliteSessionId,
    messages: bounded,
    source: 'hermes-canonical-legacy',
    latestVersion: page.latestVersion,
  })
}

export const Route = createFileRoute('/api/history')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        try {
          const url = new URL(request.url)
          const limit = Number(url.searchParams.get('limit') || '200')
          const rawSessionKey = url.searchParams.get('sessionKey')?.trim()
          const friendlyId = url.searchParams.get('friendlyId')?.trim()
          const profile =
            url.searchParams.get('profile')?.trim() || getActiveProfileName()
          if (rawSessionKey === 'new' || friendlyId === 'new') {
            return json({
              sessionKey: 'new',
              sessionId: 'new',
              messages: [],
            })
          }
          const sqliteSessionId =
            rawSessionKey && rawSessionKey !== 'new' && rawSessionKey !== 'main'
              ? rawSessionKey
              : friendlyId && friendlyId !== 'new' && friendlyId !== 'main'
                ? friendlyId
                : ''
          if (sqliteSessionId) {
            // Display SoT for Agorax-initiated Hermes: daemon agent.db.
            // Engine agentSessionId may differ from gatewaySessionId (new-chat
            // activate); persist lands on gateway id — resolve via mapping.
            // Deep links may also arrive under the wrong active profile; scan
            // other hermes:<profile> workspaces after preferred 404s.
            const lookup = resolveHermesDaemonSessionLookup(sqliteSessionId)
            const mapped = lookup.mapping !== null
            try {
              const hit = await findHermesDaemonMessages({
                candidateSessionIds: lookup.candidateSessionIds,
                preferredProfile: profile,
                limit: limit > 0 ? limit : 1000,
              })
              if (hit && hit.messages.length > 0) {
                const chatMessages = daemonActivityToChatHistory(hit.messages)
                const bounded =
                  limit > 0 ? chatMessages.slice(-limit) : chatMessages
                return json({
                  sessionKey: sqliteSessionId,
                  sessionId: sqliteSessionId,
                  messages: bounded,
                  source: 'daemon-agent-db',
                  latestVersion: hit.latestVersion,
                  daemonSessionId: hit.daemonSessionId,
                  resolvedProfile: hit.profileName,
                })
              }
              // Mapped + preferred workspace confirmed empty: idle.
              // Do NOT fail-closed on daemon 404/unreachable — that wiped new
              // sessions when profile/id mismatched while gateway still had msg-*.
              if (mapped && hit && hit.messages.length === 0) {
                return json({
                  sessionKey: sqliteSessionId,
                  sessionId: sqliteSessionId,
                  messages: [],
                  source: 'daemon-agent-db',
                  latestVersion: 0,
                  resolvedProfile: hit.profileName,
                })
              }
            } catch (err) {
              console.warn('[history] hermes daemon read failed', err)
            }
            if (
              hasHermesCanonicalMessages({ agentSessionId: sqliteSessionId })
            ) {
              return legacyCanonicalHistoryJson(sqliteSessionId, limit)
            }
            const local = getMessagesForProfile(
              profile,
              sqliteSessionId,
              limit > 0 ? limit : 1000,
            )
            // Empty array means "no rows", not a hit — fall through so wrong
            // active profile can still resolve via gateway / other stores.
            if (local && local.length > 0) {
              const bounded = limit > 0 ? local.slice(-limit) : local
              return json({
                sessionKey: sqliteSessionId,
                sessionId: sqliteSessionId,
                messages: bounded.map((message, index) =>
                  toChatMessage(
                    {
                      id: Number(message.id) || 0,
                      session_id: message.session_id,
                      role: message.role,
                      content: message.content,
                      timestamp: message.timestamp,
                      tool_calls: message.tool_calls,
                      tool_call_id: message.tool_call_id,
                      tool_name: message.tool_name,
                      platform_message_id: message.platform_message_id,
                    },
                    { historyIndex: index },
                  ),
                ),
                source: `profile:${profile}`,
                external: true,
              })
            }
          }

          let { sessionKey } = await resolveSessionKey({
            rawSessionKey,
            friendlyId,
            defaultKey: 'main',
          })
          if (sessionKey === 'new') {
            return json({
              sessionKey: 'new',
              sessionId: 'new',
              messages: [],
            })
          }
          // "main" resolves to the most recent real session in state.db.
          // No dashboard dependency — reads directly from the profile directory.
          if (sessionKey === 'main') {
            try {
              const rawSessions = listSessionsForProfile(profile)
              const sessions = rawSessions.map((s) => ({
                id: s.key,
                title: s.title,
                message_count: s.messageCount ?? 0,
              }))
              const candidate = resolveMainChatSessionId(sessions)
              if (candidate) {
                sessionKey = candidate
              } else {
                return json({
                  sessionKey: 'new',
                  sessionId: 'new',
                  messages: [],
                })
              }
            } catch {
              return json({ sessionKey: 'new', sessionId: 'new', messages: [] })
            }
          }
          let messages: Awaited<ReturnType<typeof getMessages>> = []
          try {
            messages = await getMessages(sessionKey)
          } catch {
            messages = []
          }

          // Fallback to local session store for portable/local model sessions
          if (messages.length === 0) {
            const localSession = getLocalSession(sessionKey)
            if (localSession) {
              const localMessages = getLocalMessages(sessionKey)
              return json({
                sessionKey,
                sessionId: sessionKey,
                messages: localMessages.map((m, index) => ({
                  id: m.id,
                  role: m.role,
                  content: [{ type: 'text', text: m.content }],
                  timestamp: m.timestamp,
                  historyIndex: index,
                })),
              })
            }
          }

          const boundedMessages = limit > 0 ? messages.slice(-limit) : messages

          return json({
            sessionKey,
            sessionId: sessionKey,
            messages: boundedMessages.map((message, index) =>
              toChatMessage(message, { historyIndex: index }),
            ),
          })
        } catch (err) {
          return json(
            {
              error: err instanceof Error ? err.message : String(err),
            },
            { status: 500 },
          )
        }
      },
    },
  },
})
