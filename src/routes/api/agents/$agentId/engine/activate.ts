import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../../../server/auth-middleware'
import { AgoraxManagedAgentHttpClient } from '../../../../../server/agent-runtime/agorax-managed-agent-http-client'
import { isAgoraxManagedAgentBackend } from '../../../../../server/agent-runtime/agorax-managed-agent-bridge'
import { AgoraxManagedRunStore } from '../../../../../server/agent-runtime/agorax-managed-run-store'
import { startManagedChatRun } from '../../../../../server/agent-runtime/run-managed-turn'
import { getAgentRuntimeRouter } from '../../../../../server/agent-runtime/router'
import { resolveManagedChatWorkspaceCwd } from '../../../../../server/agent-runtime/managed-chat-workspace'
import { buildWorkspaceScopedTextMessage } from '../../../../../lib/workspace-message-scope'
import { loadWorkspaceCatalog } from '../../../workspace'
import type { ManagedAgentActivateResponseDto } from '@/lib/managed-agent-runtime/command-dtos'
import type { AgoraxManagedPromptContentBlock } from '@/lib/managed-agent-runtime/prompt-content'
import { managedPromptContentBlocksFromUnknown } from '@/lib/managed-agent-runtime/prompt-content'
import {
  buildManagedActivatePrompt,
  rewritePromptContentText,
} from '../../../../../server/platform-skills'

export const Route = createFileRoute('/api/agents/$agentId/engine/activate')({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        if (!isAuthenticated(request))
          return json({ error: 'Unauthorized' }, { status: 401 })
        const agentId = params.agentId.trim()
        const body = (await request.json().catch(() => null)) as Record<
          string,
          unknown
        > | null
        const displaySessionId =
          typeof body?.displaySessionId === 'string'
            ? body.displaySessionId.trim()
            : ''
        const agentSessionId =
          typeof body?.agentSessionId === 'string'
            ? body.agentSessionId.trim()
            : ''
        const message =
          typeof body?.message === 'string' ? body.message.trim() : ''
        if (!agentId || !displaySessionId || !agentSessionId || !message) {
          return json(
            {
              error:
                'agentId, displaySessionId, agentSessionId, and message are required',
            },
            { status: 400 },
          )
        }
        const declaration = getAgentRuntimeRouter().registry.byId.get(agentId)
        if (!declaration || !isAgoraxManagedAgentBackend(declaration.runtime)) {
          return json(
            { error: 'Managed Agent is unavailable' },
            { status: 404 },
          )
        }
        const model = typeof body?.model === 'string' ? body.model.trim() : ''
        const reasoningEffort =
          typeof body?.reasoningEffort === 'string'
            ? body.reasoningEffort.trim()
            : typeof body?.effort === 'string'
              ? body.effort.trim()
              : ''
        let promptContent: Array<AgoraxManagedPromptContentBlock>
        try {
          promptContent = managedPromptContentBlocksFromUnknown(
            body?.promptContent,
          )
        } catch (error) {
          return json(
            { error: error instanceof Error ? error.message : String(error) },
            { status: 400 },
          )
        }
        const workspace = await loadWorkspaceCatalog(agentId).catch(() => null)
        const cwd = resolveManagedChatWorkspaceCwd(workspace, agentId)
        const { runtimeText, displayPrompt } = buildManagedActivatePrompt(
          agentId,
          message,
        )
        // Mirror Hermes / chat.ts: stamp the composer workspace into the first
        // turn so the agent sees the selected path even before tool cwd binds.
        const scopedRuntimeText = buildWorkspaceScopedTextMessage(
          runtimeText,
          workspace,
        )
        // Rewrite text blocks in promptContent when present so attachments stay.
        if (promptContent.length > 0 && scopedRuntimeText !== message) {
          promptContent = rewritePromptContentText(
            promptContent,
            scopedRuntimeText,
          ) as Array<AgoraxManagedPromptContentBlock>
        }
        const started = await startManagedChatRun({
          agentId,
          runId: agentSessionId,
          sessionId: displaySessionId,
          task: scopedRuntimeText,
          ...(promptContent.length ? { content: promptContent } : {}),
          ...(scopedRuntimeText !== displayPrompt
            ? { displayPrompt }
            : {}),
          ...(model ? { model } : {}),
          ...(reasoningEffort ? { effort: reasoningEffort } : {}),
          ...(cwd ? { cwd } : {}),
        })
        if (!started.ok)
          return json({ error: started.error }, { status: started.status })
        // Session list/title/delete are owned by the daemon Host. Do not write
        // collab.db managed_chat_* projection rows for 1:1 activate.
        const runStore = new AgoraxManagedRunStore()
        const binding = await runStore.get(agentSessionId)
        const baseUrl = process.env.AGORAX_MANAGED_AGENT_URL?.trim()
        const workspaceId = process.env.AGORAX_WORKSPACE_ID?.trim()
        if (!binding || !baseUrl || !workspaceId) {
          return json(
            { error: 'Managed Agent canonical binding is unavailable' },
            { status: 503 },
          )
        }
        await runStore.bind({
          runId: binding.runId,
          backend: binding.backend,
          agentSessionId: binding.agentSessionId,
          displaySessionId,
          ...(binding.turnId ? { turnId: binding.turnId } : {}),
        })
        try {
          const activity = await new AgoraxManagedAgentHttpClient({
            baseUrl,
            workspaceId,
          }).getActivitySnapshot(binding.agentSessionId)
          const response: ManagedAgentActivateResponseDto = {
            runId: started.runId,
            activity,
          }
          return json(response)
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
