/**
 * Shared send-time user + empty assistant host (Hermes + managed).
 *
 * Seeds `user:<clientSubmitId>` and `assistant:pending:<session>:<turn>` so the
 * list can mount one MessageItem (avatar glow) before the first runtime delta.
 * Later daemon/SSE rows fold onto this host via turnId / foldOpenTurnIntoLiveHost.
 */

import {
  selectEngineSession,
  type AgentActivityDurableMessage,
  type AgentSessionEngine,
} from '@agorax/agent-activity-core'
import { assistantMessageIdForRun } from '@/lib/chat-turn-identity'

export function ingestEngineUserPromptMessage(input: {
  engine: AgentSessionEngine
  workspaceId: string
  agentSessionId: string
  clientSubmitId: string
  text: string
  occurredAtUnixMs?: number
  /** When the Engine has no session row yet (first paint / new chat). */
  ensureSession?: (args: {
    workspaceId: string
    agentSessionId: string
  }) => void
}): void {
  const agentSessionId = input.agentSessionId.trim()
  const clientSubmitId = input.clientSubmitId.trim()
  const text = input.text.trim()
  if (!agentSessionId || !clientSubmitId || !text) return
  const workspaceId = input.workspaceId.trim() || 'default'
  if (!selectEngineSession(input.engine.getSnapshot(), agentSessionId)) {
    input.ensureSession?.({ workspaceId, agentSessionId })
  }
  const occurredAtUnixMs = input.occurredAtUnixMs ?? Date.now()
  const turnId = `turn-${clientSubmitId}`
  const userMessage: AgentActivityDurableMessage = {
    workspaceId,
    agentSessionId,
    messageId: `user:${clientSubmitId}`,
    version: occurredAtUnixMs,
    sequence: occurredAtUnixMs,
    turnId,
    role: 'user',
    kind: 'text',
    status: null,
    payload: { text, content: text, clientSubmitId, displayPrompt: text },
    occurredAtUnixMs,
  }
  const assistantMessageId = assistantMessageIdForRun(
    null,
    agentSessionId,
    clientSubmitId,
  )
  const assistantShell: AgentActivityDurableMessage = {
    workspaceId,
    agentSessionId,
    messageId: assistantMessageId,
    version: occurredAtUnixMs + 1,
    sequence: occurredAtUnixMs + 1,
    turnId,
    role: 'assistant',
    kind: 'text',
    status: 'streaming',
    payload: { text: '', content: '', clientSubmitId },
    occurredAtUnixMs: occurredAtUnixMs + 1,
  }
  input.engine.dispatch({
    type: 'message/snapshotReceived',
    messages: [userMessage, assistantShell],
  })
}
