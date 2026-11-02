import { timingSafeEqual } from 'node:crypto'
import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import { loadAgentsRegistry } from '../../server/agent-runtime/agents-config'
import { resetAgentRuntimeRouter } from '../../server/agent-runtime/router'
import {
  deleteExecutionNode,
  heartbeatExecutionNode,
  listExecutionNodes,
  markStaleExecutionNodesOffline,
  upsertExecutionNode,
} from '../../server/execution-nodes'

const DEFAULT_STALE_MS = 45_000

function bearerToken(request: Request): string {
  const authorization = request.headers.get('authorization') ?? ''
  return authorization.startsWith('Bearer ')
    ? authorization.slice(7).trim()
    : ''
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  )
}

function canManageNodes(request: Request): boolean {
  const expected = process.env.AGORAX_EXECUTION_NODE_REGISTRATION_TOKEN?.trim()
  const actual = bearerToken(request)
  if (expected) return Boolean(actual && safeEqual(actual, expected))
  return isAuthenticated(request)
}

function errorResponse(error: unknown, status = 400) {
  return json(
    {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    },
    { status },
  )
}

export const Route = createFileRoute('/api/execution-nodes')({
  server: {
    handlers: {
      GET: ({ request }) => {
        if (!isAuthenticated(request))
          return json({ ok: false }, { status: 401 })
        const staleMs =
          Number(process.env.AGORAX_EXECUTION_NODE_STALE_MS) || DEFAULT_STALE_MS
        markStaleExecutionNodesOffline(Date.now() - staleMs)
        return json({ ok: true, nodes: listExecutionNodes() })
      },
      POST: async ({ request }) => {
        if (!canManageNodes(request))
          return json({ ok: false }, { status: 401 })
        try {
          const body = (await request.json()) as {
            id?: string
            name?: string
            baseUrl?: string
            workspaceId?: string
            capabilities?: Array<string>
          }
          if (!body.id || !body.name || !body.baseUrl) {
            throw new Error('id, name, and baseUrl are required')
          }
          const node = upsertExecutionNode({
            id: body.id,
            name: body.name,
            baseUrl: body.baseUrl,
            workspaceId: body.workspaceId,
            capabilities: body.capabilities,
          })
          resetAgentRuntimeRouter()
          return json({ ok: true, node })
        } catch (error) {
          return errorResponse(error)
        }
      },
      PATCH: async ({ request }) => {
        if (!canManageNodes(request))
          return json({ ok: false }, { status: 401 })
        try {
          const body = (await request.json()) as {
            id?: string
            capabilities?: Array<string>
          }
          if (!body.id) throw new Error('id is required')
          const node = heartbeatExecutionNode(body.id, body.capabilities)
          if (!node)
            return errorResponse(`Execution node ${body.id} not found`, 404)
          return json({ ok: true, node })
        } catch (error) {
          return errorResponse(error)
        }
      },
      DELETE: async ({ request }) => {
        if (!isAuthenticated(request))
          return json({ ok: false }, { status: 401 })
        try {
          const body = (await request.json()) as { id?: string }
          if (!body.id) throw new Error('id is required')
          const bound = loadAgentsRegistry().agents.filter(
            (agent) => agent.nodeId === body.id,
          )
          if (bound.length > 0) {
            throw new Error(
              `Execution node ${body.id} is bound to agents: ${bound.map((agent) => agent.id).join(', ')}`,
            )
          }
          const deleted = deleteExecutionNode(body.id)
          resetAgentRuntimeRouter()
          return json({ ok: true, deleted })
        } catch (error) {
          return errorResponse(error)
        }
      },
    },
  },
})
