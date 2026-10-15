import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../../../server/auth-middleware'
import {
  deleteSessionForAgent,
  listSessionsForAgent,
  renameSessionForAgent,
} from '../../../../../server/agent-sessions-service'
import {
  clearManagedChatMessages,
  getManagedChatSession,
  listManagedChatMessages,
  messagesToChatPayload,
} from '../../../../../server/agent-runtime/managed-chat-store'
import { getAgentRuntimeRouter } from '../../../../../server/agent-runtime/router'

export const Route = createFileRoute(
  '/api/agents/$agentId/sessions/$sessionId',
)({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        const agentId = typeof params.agentId === 'string' ? params.agentId : ''
        const sessionId =
          typeof params.sessionId === 'string' ? params.sessionId : ''
        if (!agentId || !sessionId) {
          return json(
            { error: 'agentId and sessionId are required' },
            { status: 400 },
          )
        }

        const router = getAgentRuntimeRouter()
        const decl = router.registry.byId.get(agentId)
        if (decl && decl.runtime !== 'hermes') {
          const row = getManagedChatSession(sessionId)
          if (!row || row.agentId !== agentId) {
            return json({ error: 'Session not found' }, { status: 404 })
          }
          const messages = messagesToChatPayload(
            listManagedChatMessages(sessionId),
          )
          return json({
            session: {
              sessionId: row.id,
              agentId: row.agentId,
              title: row.title?.trim() || 'Chat',
              state: messages.length > 0 ? 'completed' : 'idle',
              lastMessageAt: new Date(row.updatedAt).toISOString(),
              summary:
                messages.length > 0
                  ? `Messages: ${messages.length}`
                  : undefined,
            },
            messages,
          })
        }

        const sessions = await listSessionsForAgent(agentId)
        const session = sessions.find((s) => s.sessionId === sessionId)
        if (!session) {
          return json({ error: 'Session not found' }, { status: 404 })
        }
        return json({ session, messages: [] })
      },
      PATCH: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        const agentId = typeof params.agentId === 'string' ? params.agentId : ''
        const sessionId =
          typeof params.sessionId === 'string' ? params.sessionId : ''
        if (!agentId || !sessionId) {
          return json(
            { error: 'agentId and sessionId are required' },
            { status: 400 },
          )
        }
        const body = (await request.json().catch(() => ({}))) as Record<
          string,
          unknown
        >
        if (body.clearMessages === true) {
          clearManagedChatMessages({ sessionId })
          return json({ cleared: true, sessionId })
        }
        const title = typeof body.title === 'string' ? body.title : ''
        try {
          const updated = await renameSessionForAgent(agentId, sessionId, title)
          if (!updated) {
            return json({ error: 'Session not found' }, { status: 404 })
          }
          return json({ session: updated })
        } catch (error) {
          return json(
            { error: error instanceof Error ? error.message : String(error) },
            { status: 502 },
          )
        }
      },
      DELETE: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        const agentId = typeof params.agentId === 'string' ? params.agentId : ''
        const sessionId =
          typeof params.sessionId === 'string' ? params.sessionId : ''
        if (!agentId || !sessionId) {
          return json(
            { error: 'agentId and sessionId are required' },
            { status: 400 },
          )
        }
        try {
          const deleted = await deleteSessionForAgent(agentId, sessionId)
          if (!deleted) {
            return json({
              deleted: false,
              reason: 'not implemented for this runtime',
            })
          }
          return json({ deleted: true, sessionId })
        } catch (error) {
          return json(
            { error: error instanceof Error ? error.message : String(error) },
            { status: 502 },
          )
        }
      },
    },
  },
})
