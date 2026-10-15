/**
 * Thin HTTP surface for browser-side Hermes Engine commandPort mapping I/O.
 * Persistence lives in collab.db via src/server/agorax-run-mapping.ts.
 */
import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import { requireJsonContentType } from '../../server/rate-limit'
import type { AgoraxRunMapping } from '../../server/agent-runtime/hermes-native-bridge'
import {
  getAgoraxRunMappingByAgentSessionId,
  getAgoraxRunMappingByGatewaySessionId,
  upsertAgoraxRunMapping,
} from '../../server/agorax-run-mapping'

export const Route = createFileRoute('/api/agorax-run-mapping')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        const url = new URL(request.url)
        const agentSessionId = url.searchParams.get('agentSessionId')?.trim()
        const gatewaySessionId = url.searchParams
          .get('gatewaySessionId')
          ?.trim()
        if (agentSessionId) {
          const mapping = getAgoraxRunMappingByAgentSessionId(agentSessionId)
          return json({ mapping })
        }
        if (gatewaySessionId) {
          const mapping =
            getAgoraxRunMappingByGatewaySessionId(gatewaySessionId)
          return json({ mapping })
        }
        return json(
          { error: 'agentSessionId or gatewaySessionId required' },
          { status: 400 },
        )
      },
      PUT: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        const csrf = requireJsonContentType(request)
        if (csrf) return csrf
        const body = (await request.json().catch(() => null)) as
          | Partial<AgoraxRunMapping>
          | null
        const agentSessionId =
          typeof body?.agentSessionId === 'string'
            ? body.agentSessionId.trim()
            : ''
        if (!agentSessionId) {
          return json({ error: 'agentSessionId required' }, { status: 400 })
        }
        const mapping = upsertAgoraxRunMapping({
          agentSessionId,
          turnId:
            typeof body?.turnId === 'string' ? body.turnId.trim() || null : null,
          gatewaySessionId:
            typeof body?.gatewaySessionId === 'string'
              ? body.gatewaySessionId.trim() || null
              : null,
          assignmentId: null,
          hermesRunId:
            typeof body?.hermesRunId === 'string'
              ? body.hermesRunId.trim() || null
              : null,
          bridgeKind: 'hermes-native',
          updatedAtUnixMs: Date.now(),
        })
        return json({ mapping })
      },
    },
  },
})
