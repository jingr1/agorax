import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../../../../../server/auth-middleware'
import {
  AgoraxManagedAgentHttpClient,
  AgoraxManagedAgentHttpError,
} from '../../../../../../../server/agent-runtime/agorax-managed-agent-http-client'
import { resolveAgoraxManagedSessionIdentity } from '../../../../../../../server/agent-runtime/agorax-managed-agent-session-identity'
import { resolveManagedChatWorkspaceCwd } from '../../../../../../../server/agent-runtime/managed-chat-workspace'
import { buildWorkspaceScopedTextMessage } from '../../../../../../../lib/workspace-message-scope'
import { loadWorkspaceCatalog } from '../../../../../workspace'
import type { ManagedAgentInputResponseDto } from '@/lib/managed-agent-runtime/command-dtos'
import type { AgoraxManagedPromptContentBlock } from '@/lib/managed-agent-runtime/prompt-content'
import { managedPromptContentBlocksFromUnknown } from '@/lib/managed-agent-runtime/prompt-content'
import {
  buildTurnSkillInjection,
  rewritePromptContentText,
} from '../../../../../../../server/platform-skills'

export const Route = createFileRoute(
  '/api/agents/$agentId/engine/session/$sessionId/input',
)({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        const body = (await request.json()) as {
          clientSubmitId?: string
          content?: string
          promptContent?: unknown
        }
        const baseUrl = process.env.AGORAX_MANAGED_AGENT_URL?.trim()
        const workspaceId = process.env.AGORAX_WORKSPACE_ID?.trim()
        if (
          !baseUrl ||
          !workspaceId ||
          !body.clientSubmitId ||
          !body.content
        ) {
          return json({ error: 'Invalid managed input' }, { status: 400 })
        }
        const identity = await resolveAgoraxManagedSessionIdentity({
          agentId: params.agentId,
          sessionId: params.sessionId,
        })
        if (!identity.ok) {
          return json({ error: identity.error }, { status: identity.status })
        }
        const displayPrompt = body.content
        const injected = buildTurnSkillInjection(params.agentId, displayPrompt)
        // Same active workspace as the composer folder picker / Hermes
        // send-stream. Engine sendInput previously omitted this, so mid-session
        // workspace switches never reached the managed agent prompt.
        const workspace = await loadWorkspaceCatalog(params.agentId).catch(
          () => null,
        )
        const workspaceCwd = resolveManagedChatWorkspaceCwd(
          workspace,
          params.agentId,
        )
        const scopedRuntimeText = buildWorkspaceScopedTextMessage(
          injected.text,
          workspace,
        )
        let promptContent: Array<AgoraxManagedPromptContentBlock> | undefined
        try {
          const parsed = managedPromptContentBlocksFromUnknown(
            body.promptContent,
          )
          if (parsed.length > 0) {
            promptContent =
              scopedRuntimeText !== displayPrompt
                ? (rewritePromptContentText(
                    parsed,
                    scopedRuntimeText,
                  ) as Array<AgoraxManagedPromptContentBlock>)
                : parsed
          }
        } catch (error) {
          return json(
            { error: error instanceof Error ? error.message : String(error) },
            { status: 400 },
          )
        }
        try {
          const client = new AgoraxManagedAgentHttpClient({
            baseUrl,
            workspaceId,
          })
          if (workspaceCwd) {
            // ACP pins tool cwd at session/new. When the composer folder changes
            // mid-chat, remount before send so pwd/tools follow the UI path.
            try {
              const activity = (await client.getActivitySnapshot(
                identity.agentSessionId,
              )) as {
                session?: { Cwd?: string; cwd?: string }
              }
              const sessionCwd = (
                activity.session?.Cwd ??
                activity.session?.cwd ??
                ''
              ).trim()
              if (sessionCwd && sessionCwd !== workspaceCwd) {
                console.log(
                  `[agents/input] remount cwd ${sessionCwd} → ${workspaceCwd} session=${params.sessionId}`,
                )
                await client.remountSessionCwd(
                  identity.agentSessionId,
                  workspaceCwd,
                )
              }
            } catch (remountError) {
              console.warn(
                `[agents/input] cwd remount skipped: ${
                  remountError instanceof Error
                    ? remountError.message
                    : String(remountError)
                }`,
              )
            }
            console.log(
              `[agents/input] agent=${params.agentId} cwd=${workspaceCwd} session=${params.sessionId}`,
            )
          }
          const result = await client.sendInput(identity.agentSessionId, {
            clientSubmitId: body.clientSubmitId,
            content: scopedRuntimeText,
            ...(promptContent ? { promptContent } : {}),
            ...(scopedRuntimeText !== displayPrompt
              ? { displayPrompt }
              : {}),
          })
          const response: ManagedAgentInputResponseDto = {
            result,
            activity: await client.getActivitySnapshot(identity.agentSessionId),
          }
          return json(response)
        } catch (error) {
          const status =
            error instanceof AgoraxManagedAgentHttpError && error.status === 404
              ? 404
              : 502
          return json(
            {
              error: error instanceof Error ? error.message : String(error),
            },
            { status },
          )
        }
      },
    },
  },
})
