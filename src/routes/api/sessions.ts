import { randomUUID } from 'node:crypto'
import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import { requireJsonContentType } from '../../server/rate-limit'
import {
  createSession,
  deleteSession,
  ensureGatewayCoreProbed,
  ensureSessionsCapability,
  getGatewayCapabilities,
  toSessionSummary,
  updateSession,
} from '../../server/hermes-api'
import { createCapabilityUnavailablePayload } from '@/lib/feature-gates'
import {
  deleteLocalSession,
  getLocalSession,
  listLocalSessions,
  updateLocalSessionTitle,
} from '../../server/local-session-store'
import {
  getActiveProfileName,
  listSessionsForProfile,
} from '../../server/profiles-browser'
import {
  ensureChatGateway,
  enterChatGateway,
} from '../../server/chat-gateway'

export const Route = createFileRoute('/api/sessions')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        // Auth check
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }

        // ?profile=<name> — return sessions from that profile's filesystem directory
        // without touching the global active profile
        const url = new URL(request.url)
        const profileParam = url.searchParams.get('profile')

        if (profileParam) {
          // Profile-aware listing: read directly from that profile's
          // state.db SQLite database (not the request dump files).
          const fsSessions = listSessionsForProfile(profileParam)
          return json({
            sessions: fsSessions.map((s) => ({
              key: s.key,
              id: s.key,
              friendlyId: s.friendlyId,
              title: s.title || s.friendlyId,
              label: s.title || null,
              derivedTitle: s.title || s.friendlyId,
              updatedAt: s.updatedAt,
              startedAt: s.updatedAt,
              source: s.source,
              model: s.model || undefined,
              message_count: s.messageCount ?? 0,
            })),
          })
        }

        // Control-plane refactor: default listing reads active profile
        // state.db (same codepath as ?profile=), merging local portable
        // sessions. Gateway/dashboard are not required for listing.
        try {
          const activeProfile = getActiveProfileName() || 'default'
          const fsSessions = listSessionsForProfile(activeProfile)
          const result: Array<any> = fsSessions.map((s) => ({
            key: s.key,
            id: s.key,
            friendlyId: s.friendlyId,
            title: s.title || s.friendlyId,
            label: s.title || null,
            derivedTitle: s.title || s.friendlyId,
            updatedAt: s.updatedAt,
            startedAt: s.updatedAt,
            source: s.source,
            model: s.model || undefined,
            message_count: s.messageCount ?? 0,
          }))

          // Merge local portable sessions (Ollama, Atomic Chat, etc.)
          const localSessions = listLocalSessions()
          const dbIds = new Set(result.map((s: any) => s.key || s.id))
          for (const ls of localSessions) {
            if (!dbIds.has(ls.id)) {
              result.push({
                key: ls.id,
                id: ls.id,
                friendlyId: ls.id,
                title: ls.title || 'Local Chat',
                label: ls.title || 'Local Chat',
                derivedTitle: ls.title || 'Local Chat',
                startedAt: ls.createdAt,
                updatedAt: ls.updatedAt,
                message_count: ls.messageCount,
                model: ls.model,
                source: 'local',
              })
            }
          }

          return json({ sessions: result })
        } catch (err) {
          return json(
            {
              error: err instanceof Error ? err.message : String(err),
            },
            { status: 500 },
          )
        }
      },
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        const csrfCheckPost = requireJsonContentType(request)
        if (csrfCheckPost) return csrfCheckPost
        const body = (await request.json().catch(() => ({}))) as Record<
          string,
          unknown
        >
        const requestedProfile =
          typeof body.profileName === 'string' ? body.profileName.trim() : ''
        try {
          enterChatGateway(await ensureChatGateway(requestedProfile))
        } catch (error) {
          return json(
            {
              ok: false,
              error:
                error instanceof Error ? error.message : 'gateway unavailable',
            },
            { status: 503 },
          )
        }
        const capabilities = await ensureSessionsCapability()
        if (!capabilities.sessions) {
          const friendlyId = randomUUID()
          return json({
            ...createCapabilityUnavailablePayload('sessions'),
            ok: true,
            sessionKey: friendlyId,
            friendlyId,
            persisted: false,
          })
        }
        try {
          const requestedLabel =
            typeof body.label === 'string' ? body.label.trim() : ''
          const label = requestedLabel || undefined

          const requestedFriendlyId =
            typeof body.friendlyId === 'string' ? body.friendlyId.trim() : ''
          const friendlyId = requestedFriendlyId || randomUUID()

          const requestedModel =
            typeof body.model === 'string' ? body.model.trim() : ''
          const model = requestedModel || undefined

          const session = await createSession({
            id: friendlyId || randomUUID(),
            title: label,
            model,
          })

          const createdId = session?.id || friendlyId
          return json({
            ok: true,
            sessionKey: createdId,
            friendlyId: createdId,
            entry: toSessionSummary({
              ...(session ?? { id: createdId }),
              id: createdId,
            }),
            modelApplied: true,
          })
        } catch (err) {
          return json(
            {
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            },
            { status: 500 },
          )
        }
      },
      PATCH: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        const csrfCheckPatch = requireJsonContentType(request)
        if (csrfCheckPatch) return csrfCheckPatch
        const capabilities = await ensureGatewayCoreProbed()
        if (!capabilities.sessions) {
          const body = (await request.json().catch(() => ({}))) as Record<
            string,
            unknown
          >
          const rawSessionKey =
            typeof body.sessionKey === 'string' ? body.sessionKey.trim() : ''
          const rawFriendlyId =
            typeof body.friendlyId === 'string' ? body.friendlyId.trim() : ''
          const sessionKey = rawSessionKey || rawFriendlyId || randomUUID()

          return json({
            ...createCapabilityUnavailablePayload('sessions'),
            ok: true,
            sessionKey,
            friendlyId: rawFriendlyId || sessionKey,
            updated: false,
          })
        }
        try {
          const body = (await request.json().catch(() => ({}))) as Record<
            string,
            unknown
          >

          const rawSessionKey =
            typeof body.sessionKey === 'string' ? body.sessionKey.trim() : ''
          const rawFriendlyId =
            typeof body.friendlyId === 'string' ? body.friendlyId.trim() : ''
          const label =
            typeof body.label === 'string' ? body.label.trim() : undefined
          const sessionKey = rawSessionKey || rawFriendlyId

          if (!sessionKey) {
            return json(
              { ok: false, error: 'sessionKey required' },
              { status: 400 },
            )
          }

          const localSession = getLocalSession(sessionKey)
          if (localSession) {
            if (label) updateLocalSessionTitle(sessionKey, label)
            return json({
              ok: true,
              sessionKey,
              friendlyId: rawFriendlyId || sessionKey,
              entry: {
                key: sessionKey,
                id: sessionKey,
                title: label || sessionKey,
                label: label || sessionKey,
                derivedTitle: label || sessionKey,
                startedAt: localSession.createdAt,
                updatedAt: Date.now(),
                message_count: localSession.messageCount,
                model: localSession.model,
                source: 'local',
              },
              updated: true,
              source: 'local',
            })
          }

          const session = await updateSession(sessionKey, {
            title: label,
          })

          return json({
            ok: true,
            sessionKey,
            entry: toSessionSummary(session),
          })
        } catch (err) {
          return json(
            {
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            },
            { status: 500 },
          )
        }
      },
      DELETE: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        const url = new URL(request.url)
        const rawSessionKey = url.searchParams.get('sessionKey') ?? ''
        const rawFriendlyId = url.searchParams.get('friendlyId') ?? ''
        const sessionKey = rawSessionKey.trim() || rawFriendlyId.trim()

        if (!sessionKey) {
          return json(
            { ok: false, error: 'sessionKey required' },
            { status: 400 },
          )
        }

        // Local sessions live in the workspace portable store, not the
        // gateway. Delete them locally without hitting the gateway.
        if (getLocalSession(sessionKey)) {
          deleteLocalSession(sessionKey)
          return json({ ok: true, sessionKey, source: 'local' })
        }

        const capabilities = await ensureGatewayCoreProbed()
        if (!capabilities.sessions) {
          return json({
            ...createCapabilityUnavailablePayload('sessions'),
            ok: true,
            sessionKey,
            deleted: false,
          })
        }
        try {
          await deleteSession(sessionKey)

          return json({ ok: true, sessionKey })
        } catch (err) {
          return json(
            {
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            },
            { status: 500 },
          )
        }
      },
    },
  },
})
