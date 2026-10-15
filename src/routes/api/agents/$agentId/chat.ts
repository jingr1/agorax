import { createFileRoute } from '@tanstack/react-router'
import { isAuthenticated } from '../../../../server/auth-middleware'
import { publishChatEvent } from '../../../../server/chat-event-bus'
import { startManagedChatRun } from '../../../../server/agent-runtime/run-managed-turn'
import {
  appendManagedChatMessage,
  ensureManagedChatSession,
  recordNativeSessionId,
  resolveNativeSessionForRun,
} from '../../../../server/agent-runtime/managed-chat-store'
import { resolveManagedChatWorkspaceCwd } from '../../../../server/agent-runtime/managed-chat-workspace'
import { getAgentRuntimeRouter } from '../../../../server/agent-runtime/router'
import { managedPromptContentFromAttachments } from '../../../../server/agent-runtime/agorax-managed-prompt-content'
import { loadWorkspaceCatalog } from '../../workspace'
import { buildWorkspaceScopedTextMessage } from '../../../../lib/workspace-message-scope'
import type { AgentStreamEvent } from '../../../../server/agent-runtime/types'

/**
 * POST /api/agents/:agentId/chat
 *
 * Managed non-Hermes chat (claude-code today). Persists UI transcript in
 * collab.db and resumes Claude via --session-id / --resume (studio-style).
 *
 * Body: {
 *   message: string,
 *   sessionId?: string,
 *   model?: string,
 *   effort?: string,
 * }
 *
 * SSE events:
 *   connected  { runId, agentId, sessionId }
 *   text_delta { runId, text }
 *   thinking   { runId, text }
 *   tool       { runId, phase, name, args }
 *   native_session { runId, sessionId }
 *   error      { runId, message }
 *   run_exited { runId, exitCode }
 */
export const Route = createFileRoute('/api/agents/$agentId/chat')({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return new Response(
            JSON.stringify({ ok: false, error: 'Unauthorized' }),
            { status: 401, headers: { 'Content-Type': 'application/json' } },
          )
        }

        const agentId =
          typeof params.agentId === 'string' ? params.agentId.trim() : ''
        if (!agentId) {
          return new Response(
            JSON.stringify({ ok: false, error: 'agentId is required' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          )
        }

        let body: Record<string, unknown> = {}
        try {
          const raw = await request.text()
          body = JSON.parse(raw) as Record<string, unknown>
        } catch {
          return new Response(
            JSON.stringify({ ok: false, error: 'invalid JSON body' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          )
        }

        const message = String(body.message ?? '').trim()
        if (!message) {
          return new Response(
            JSON.stringify({ ok: false, error: 'message is required' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          )
        }

        const requestedModel =
          typeof body.model === 'string' ? body.model.trim() : ''
        const requestedEffort =
          typeof body.effort === 'string' ? body.effort.trim() : ''
        const attachments = Array.isArray(body.attachments)
          ? body.attachments
          : []

        const sessionId =
          typeof body.sessionId === 'string' && body.sessionId.trim()
            ? body.sessionId.trim()
            : crypto.randomUUID()

        const router = getAgentRuntimeRouter()
        const decl = router.registry.byId.get(agentId)
        const runtime = decl?.runtime ?? 'claude-code'

        ensureManagedChatSession({
          id: sessionId,
          agentId,
          runtime: runtime === 'hermes' ? 'claude-code' : runtime,
          ...(requestedModel ? { model: requestedModel } : {}),
        })

        appendManagedChatMessage({
          sessionId,
          role: 'user',
          content: [{ type: 'text', text: message }],
          titleFromText: message,
        })

        const native = resolveNativeSessionForRun({ sessionId })

        // Same catalog as the UI folder picker for this managed agent.
        const workspace = await loadWorkspaceCatalog(agentId).catch(() => null)
        const workspaceCwd = resolveManagedChatWorkspaceCwd(workspace, agentId)

        // With --resume, Claude already has history — only send the new turn.
        // First turn (--session-id) also stays single-message; no prompt replay.
        const scopedUser = buildWorkspaceScopedTextMessage(message, workspace)
        const task = [
          `User: ${scopedUser}`,
          '直接回应用户，面向用户的叙述使用简体中文（代码、命令、技术标识保持英文）。如有需要可通过 MCP 使用 Hermes 工具。',
        ].join('\n')
        let content
        try {
          content = managedPromptContentFromAttachments({
            text: task,
            attachments,
          })
        } catch (error) {
          return new Response(
            JSON.stringify({
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          )
        }

        const started = await startManagedChatRun({
          agentId,
          task,
          content,
          ...(requestedModel ? { model: requestedModel } : {}),
          ...(requestedEffort ? { effort: requestedEffort } : {}),
          sessionId,
          nativeSessionId: native.nativeSessionId,
          nativeResume: native.resume,
          ...(workspaceCwd ? { cwd: workspaceCwd } : {}),
          probe: true,
        })
        if (!started.ok) {
          return new Response(
            JSON.stringify({ ok: false, error: started.error }),
            {
              status: started.status,
              headers: { 'Content-Type': 'application/json' },
            },
          )
        }

        if (workspaceCwd) {
          console.log(
            `[agents/chat] agent=${agentId} cwd=${workspaceCwd} session=${sessionId}`,
          )
        }

        const { runId, adapter, sessionId: chatSessionId } = started

        publishChatEvent('agent_chat_started', {
          runId,
          agentId,
          sessionId: chatSessionId,
        })

        const encoder = new TextEncoder()

        const stream = new ReadableStream({
          async start(controller) {
            let streamClosed = false
            let heartbeatTimer: ReturnType<typeof setInterval> | null = null
            let assistantText = ''
            let lastError: string | null = null
            let persistedAssistant = false

            const sendEvent = (
              event: string,
              data: Record<string, unknown>,
            ) => {
              if (streamClosed) return
              try {
                const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
                controller.enqueue(encoder.encode(payload))
              } catch {
                streamClosed = true
              }
            }

            const persistAssistant = () => {
              if (persistedAssistant) return
              const text = assistantText.trim()
              if (!text && !lastError) return
              persistedAssistant = true
              appendManagedChatMessage({
                sessionId: chatSessionId,
                role: 'assistant',
                content: [
                  {
                    type: 'text',
                    text: text || lastError || '',
                  },
                ],
                isError: Boolean(lastError && !text),
              })
            }

            const closeStream = () => {
              if (streamClosed) return
              streamClosed = true
              if (heartbeatTimer) {
                clearInterval(heartbeatTimer)
                heartbeatTimer = null
              }
              try {
                controller.close()
              } catch {
                /* ignore */
              }
            }

            // Client disconnect (session/agent switch, tab close) must NOT
            // SIGKILL the managed run — only detach the SSE. Explicit Stop
            // goes through POST .../runs/:runId/interrupt.
            request.signal.addEventListener(
              'abort',
              () => {
                console.log(
                  `[agents/chat] client detached runId=${runId} — run continues in background`,
                )
                closeStream()
              },
              { once: true },
            )

            sendEvent('connected', {
              type: 'connected',
              runId,
              agentId,
              sessionId: chatSessionId,
            })

            heartbeatTimer = setInterval(() => {
              sendEvent('heartbeat', {
                type: 'heartbeat',
                timestamp: Date.now(),
              })
            }, 10_000)

            try {
              for await (const event of adapter.streamEvents(runId)) {
                if (event.type === 'text_delta' && event.text) {
                  assistantText += event.text
                } else if (event.type === 'error' && event.message.trim()) {
                  lastError = event.message
                } else if (event.type === 'native_session') {
                  recordNativeSessionId({
                    sessionId: chatSessionId,
                    nativeSessionId: event.sessionId,
                  })
                }
                // Still drain + persist after detach; only skip wire writes.
                if (!streamClosed) {
                  relayEvent(sendEvent, event)
                }
                if (event.type === 'run_exited') {
                  persistAssistant()
                  if (!streamClosed) setTimeout(closeStream, 50)
                  break
                }
              }
            } catch (error) {
              const detail =
                error instanceof Error ? error.message : String(error)
              lastError = detail
              if (!streamClosed) {
                sendEvent('error', { runId, message: detail })
              }
              persistAssistant()
              if (!streamClosed) closeStream()
            } finally {
              if (heartbeatTimer) {
                clearInterval(heartbeatTimer)
                heartbeatTimer = null
              }
              persistAssistant()
              if (!streamClosed) setTimeout(closeStream, 100)
            }
          },
        })

        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
          },
        })
      },
    },
  },
})

function relayEvent(
  send: (event: string, data: Record<string, unknown>) => void,
  event: AgentStreamEvent,
): void {
  switch (event.type) {
    case 'run_started':
      send('run_started', {
        type: 'run_started',
        runId: event.runId,
        agentId: event.agentId,
        taskId: event.taskId,
        roomId: event.roomId,
      })
      break
    case 'text_delta':
      send('text_delta', {
        type: 'text_delta',
        runId: event.runId,
        text: event.text,
      })
      break
    case 'thinking':
      send('thinking', {
        type: 'thinking',
        runId: event.runId,
        text: event.text,
      })
      break
    case 'tool':
      send('tool', {
        type: 'tool',
        runId: event.runId,
        phase: event.phase,
        name: event.name,
        args: event.args,
      })
      break
    case 'native_session':
      send('native_session', {
        type: 'native_session',
        runId: event.runId,
        sessionId: event.sessionId,
      })
      break
    case 'run_exited':
      send('run_exited', {
        type: 'run_exited',
        runId: event.runId,
        exitCode: event.exitCode,
      })
      break
    case 'error':
      send('error', {
        type: 'error',
        runId: event.runId,
        message: event.message,
      })
      break
    case 'activity':
      send('activity', {
        type: 'activity',
        runId: event.runId,
        workspaceId: event.workspaceId,
        activity: event.activity,
      })
      break
  }
}
