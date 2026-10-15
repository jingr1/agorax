import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import { requireJsonContentType } from '../../../server/rate-limit'
import { respondRunApproval } from '../../../server/hermes-api'
import {
  ensureChatGateway,
  enterChatGateway,
} from '../../../server/chat-gateway'
import {
  HERMES_APPROVAL_CHOICES,
  type HermesApprovalChoice,
} from '../../../lib/hermes-approval'

/**
 * POST /api/runs/:runId/approval
 *
 * Relay a Hermes gateway run approval decision (once|session|always|deny).
 * Mirrors hermes-webui RunnerClient.respond_approval.
 */
export const Route = createFileRoute('/api/runs/$runId/approval')({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        const csrf = requireJsonContentType(request)
        if (csrf) return csrf

        const runId = params.runId?.trim()
        if (!runId) {
          return json({ ok: false, error: 'runId required' }, { status: 400 })
        }

        const body = (await request.json().catch(() => ({}))) as Record<
          string,
          unknown
        >
        const choiceRaw = String(body.choice ?? '').trim().toLowerCase()
        if (
          !(HERMES_APPROVAL_CHOICES as readonly string[]).includes(choiceRaw)
        ) {
          return json(
            {
              ok: false,
              error: `choice must be one of ${HERMES_APPROVAL_CHOICES.join('|')}`,
            },
            { status: 400 },
          )
        }
        const choice = choiceRaw as HermesApprovalChoice
        const approvalIdRaw = body.approval_id ?? body.approvalId ?? body.id
        const approvalId =
          typeof approvalIdRaw === 'string' ? approvalIdRaw.trim() : ''

        try {
          const requestedProfile =
            typeof body.profileName === 'string' ? body.profileName.trim() : ''
          enterChatGateway(await ensureChatGateway(requestedProfile))
          const result = await respondRunApproval(runId, {
            choice,
            approvalId: approvalId || null,
          })
          return json({
            ok: true,
            runId,
            choice,
            approvalId: approvalId || null,
            result,
          })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          const status =
            message.includes('404') || message.includes('not found')
              ? 404
              : message.includes('409')
                ? 409
                : 502
          return json({ ok: false, error: message, runId, choice }, { status })
        }
      },
    },
  },
})
