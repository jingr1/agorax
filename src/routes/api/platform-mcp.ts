import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import { requireJsonContentType } from '../../server/rate-limit'
import {
  createPlatformMcpServer,
  listPlatformMcpServers,
  type CreatePlatformMcpInput,
  type PlatformMcpTransport,
} from '../../server/platform-mcp'
import { toConfigEntry } from '../../server/mcp-profile-config'
import { parseMcpServerInput } from '../../server/mcp-input-validate'

function readTransport(value: unknown): PlatformMcpTransport | undefined {
  if (value === 'http' || value === 'stdio') return value
  return undefined
}

export const Route = createFileRoute('/api/platform-mcp')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        return json({ servers: listPlatformMcpServers() })
      },
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        const ct = requireJsonContentType(request)
        if (ct) return ct
        const body = (await request.json().catch(() => ({}))) as Record<
          string,
          unknown
        >

        // Accept either { name, transport, config } or full McpServerInput shape
        let input: CreatePlatformMcpInput
        if (
          body.config &&
          typeof body.config === 'object' &&
          !Array.isArray(body.config)
        ) {
          const name = typeof body.name === 'string' ? body.name : ''
          if (!name.trim()) {
            return json({ error: 'name is required' }, { status: 400 })
          }
          input = {
            name,
            transport: readTransport(body.transport),
            config: body.config as Record<string, unknown>,
          }
        } else {
          const parsed = parseMcpServerInput(body)
          if (!parsed.ok) {
            return json(
              {
                error: 'Invalid MCP server payload',
                errors: parsed.errors,
              },
              { status: 400 },
            )
          }
          input = {
            name: parsed.value.name,
            transport:
              parsed.value.transportType === 'http' ? 'http' : 'stdio',
            config: toConfigEntry(parsed.value),
          }
        }

        try {
          const server = createPlatformMcpServer(input)
          // Library GET is write-only for secrets — return summary + id only
          return json(
            {
              server: {
                id: server.id,
                name: server.name,
                transport: server.transport,
                createdAt: server.createdAt,
                updatedAt: server.updatedAt,
                boundAgentCount: 0,
              },
            },
            { status: 201 },
          )
        } catch (error) {
          const message =
            error instanceof Error ? error.message : 'Failed to create MCP server'
          const status = message.includes('already exists') ? 409 : 400
          return json({ error: message }, { status })
        }
      },
    },
  },
})
