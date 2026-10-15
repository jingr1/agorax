import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import { handleMcpRequest } from '../../server/mcp/mcp-handler'
import type { McpRequest } from '../../server/mcp/mcp-handler'

/**
 * Agent-facing MCP JSON-RPC endpoint (plan P1.1 «先通电»).
 *
 * NOTE on path: the plan called this `/api/mcp`, but that route was already
 * taken by the MCP server-management UI API (see ./mcp.ts and ./mcp/*).
 * ESCALATED to architect — using /api/mcp-rpc until the plan is amended.
 */
export const Route = createFileRoute('/api/mcp-rpc')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }

        let body: McpRequest
        try {
          body = (await request.json()) as McpRequest
        } catch {
          return json({ error: 'Invalid JSON body' }, { status: 400 })
        }

        if (typeof body.method !== 'string' || body.method.length === 0) {
          return json({ error: 'Missing or invalid method' }, { status: 400 })
        }

        try {
          const response = await handleMcpRequest(body)
          // JSON-RPC errors travel in the body with HTTP 200 by convention,
          // EXCEPT auth-class failures which we map to real HTTP statuses so
          // proxies/monitors see them. Token responses are never cacheable.
          const rpcError = response.error
          const httpStatus =
            rpcError?.code === -32001
              ? 401
              : rpcError?.code === -32003 ||
                  rpcError?.code === -32004 ||
                  rpcError?.code === -32005
                ? 403
                : 200
          if (
            rpcError &&
            (rpcError.code === -32001 || rpcError.code === -32003)
          ) {
            // Audit trail for token-probe / unauthorized attempts.
            console.warn('[api/mcp-rpc] auth-class failure', {
              code: rpcError.code,
              method: body.method,
              message: rpcError.message,
            })
          }
          return json(response, {
            status: httpStatus,
            headers: { 'Cache-Control': 'no-store' },
          })
        } catch (error) {
          return json(
            {
              jsonrpc: '2.0',
              id:
                typeof body.id === 'string' || typeof body.id === 'number'
                  ? body.id
                  : 'internal-error',
              error: {
                code: -32603,
                message: error instanceof Error ? error.message : String(error),
              },
            },
            { status: 500, headers: { 'Cache-Control': 'no-store' } },
          )
        }
      },
    },
  },
})
