import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import { requireJsonContentType } from '../../server/rate-limit'
import { createSession, sendChat } from '../../server/hermes-api'
import { ensureChatGateway, enterChatGateway } from '../../server/chat-gateway'
import {
  getBackgroundTask,
  listBackgroundTasks,
  startBackgroundTask,
  type BackgroundTaskRecord,
} from '../../server/background-tasks'

export const Route = createFileRoute('/api/background')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        const url = new URL(request.url)
        const sessionId = (
          url.searchParams.get('session_id') ||
          url.searchParams.get('sessionId') ||
          ''
        ).trim()
        const taskId = (url.searchParams.get('task_id') || '').trim()
        if (taskId) {
          const task = getBackgroundTask(taskId)
          if (!task) {
            return json({ ok: false, error: 'Task not found' }, { status: 404 })
          }
          return json({ ok: true, task })
        }
        const tasks = listBackgroundTasks(sessionId || undefined)
        return json({ ok: true, tasks })
      },
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        const csrf = requireJsonContentType(request)
        if (csrf) return csrf

        const body = (await request.json().catch(() => ({}))) as Record<
          string,
          unknown
        >
        const parentSessionId = String(
          body.sessionId || body.session_id || '',
        ).trim()
        const prompt = String(body.prompt || body.text || '').trim()
        if (!parentSessionId || parentSessionId === 'new') {
          return json(
            { ok: false, error: 'sessionId required' },
            { status: 400 },
          )
        }
        if (!prompt) {
          return json({ ok: false, error: 'prompt required' }, { status: 400 })
        }

        try {
          const requestedProfile =
            typeof body.profileName === 'string' ? body.profileName.trim() : ''
          const gateway = await ensureChatGateway(requestedProfile)
          enterChatGateway(gateway)
          const bgSession = await createSession({
            title: `bg: ${prompt.slice(0, 60)}`,
          })
          const task = startBackgroundTask({
            parentSessionId,
            prompt,
            sessionId: bgSession.id,
            run: async () => {
              enterChatGateway(gateway)
              const result = await sendChat(bgSession.id, prompt)
              const answer =
                typeof result === 'object' && result
                  ? String(
                      (result as { reply?: string; content?: string }).reply ||
                        (result as { content?: string }).content ||
                        (result as { message?: { content?: string } }).message
                          ?.content ||
                        '',
                    ).trim()
                  : ''
              return {
                answer:
                  answer ||
                  'Background task finished (no text payload returned).',
                sessionId: bgSession.id,
              }
            },
          })
          return json({
            ok: true,
            taskId: task.taskId,
            sessionId: bgSession.id,
            parentSessionId,
            task: task as BackgroundTaskRecord,
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
    },
  },
})
