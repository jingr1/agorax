/**
 * Per-profile MCP server management.
 *
 *   GET /api/profiles/mcp?name=<profile>
 *   POST /api/profiles/mcp
 *     body: { name, action: 'toggle'|'remove'|'upsert', ... }
 */
import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import { readProfile } from '../../../server/profiles-browser'
import {
  maskSecretsInPlace,
  normalizeMcpListFromConfig,
} from '../../../server/mcp-normalize'
import { requireJsonContentType } from '../../../server/rate-limit'
import { parseMcpServerInput } from '../../../server/mcp-input-validate'
import {
  deleteProfileMcpServer,
  patchProfileMcpServer,
  upsertProfileMcpServer,
} from '../../../server/mcp-profile-config'

const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

export const Route = createFileRoute('/api/profiles/mcp')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        try {
          const url = new URL(request.url)
          const name = (url.searchParams.get('name') || '').trim()
          if (!name || !PROFILE_NAME_RE.test(name)) {
            return json(
              { error: 'A valid profile name is required' },
              { status: 400 },
            )
          }
          const profile = readProfile(name)
          const servers = normalizeMcpListFromConfig(profile.config)
          for (const s of servers) maskSecretsInPlace(s)
          return json({ profile: name, servers })
        } catch (error) {
          return json(
            {
              error:
                error instanceof Error
                  ? error.message
                  : 'Failed to read profile MCP config',
            },
            { status: 500 },
          )
        }
      },
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        const csrfCheck = requireJsonContentType(request)
        if (csrfCheck) return csrfCheck

        try {
          const body = (await request.json()) as Record<string, unknown>
          const profileName =
            typeof body.name === 'string' ? body.name.trim() : ''
          const action =
            typeof body.action === 'string' ? body.action.trim() : ''
          if (!profileName || !PROFILE_NAME_RE.test(profileName)) {
            return json(
              { ok: false, error: 'A valid profile name is required' },
              { status: 400 },
            )
          }
          if (
            action !== 'toggle' &&
            action !== 'remove' &&
            action !== 'upsert'
          ) {
            return json(
              {
                ok: false,
                error: 'action must be "toggle", "remove", or "upsert"',
              },
              { status: 400 },
            )
          }

          if (action === 'upsert') {
            // Prefer nested `server` object (full McpServerInput); else top-level fields.
            const payload =
              body.server && typeof body.server === 'object'
                ? body.server
                : {
                    name:
                      typeof body.serverName === 'string'
                        ? body.serverName
                        : body.server,
                    transportType: body.transportType ?? body.transport,
                    url: body.url,
                    command: body.command,
                    args: body.args,
                    env: body.env,
                    headers: body.headers,
                    enabled: body.enabled,
                    authType: body.authType,
                    bearerToken: body.bearerToken,
                    oauth: body.oauth,
                    toolMode: body.toolMode,
                    includeTools: body.includeTools,
                    excludeTools: body.excludeTools,
                  }
            const parsed = parseMcpServerInput(payload)
            if (!parsed.ok) {
              return json(
                {
                  ok: false,
                  error: 'Invalid MCP server payload',
                  errors: parsed.errors,
                },
                { status: 400 },
              )
            }
            const written = upsertProfileMcpServer(profileName, parsed.value)
            return json({
              ok: true,
              profile: profileName,
              server: maskSecretsInPlace(written),
            })
          }

          const serverName =
            typeof body.server === 'string'
              ? body.server.trim()
              : typeof body.serverName === 'string'
                ? body.serverName.trim()
                : ''
          if (!serverName) {
            return json(
              { ok: false, error: 'Server name is required' },
              { status: 400 },
            )
          }

          if (action === 'remove') {
            deleteProfileMcpServer(profileName, serverName)
            return json({ ok: true, profile: profileName, server: serverName })
          }

          const nextEnabled =
            typeof body.enabled === 'boolean' ? body.enabled : undefined
          const current = readProfile(profileName)
          const mcpServers = (current.config.mcp_servers ?? {}) as Record<
            string,
            unknown
          >
          const serverEntry = mcpServers[serverName]
          if (!serverEntry) {
            return json(
              { ok: false, error: `MCP server "${serverName}" not found` },
              { status: 404 },
            )
          }
          const currentEnabled =
            typeof serverEntry === 'object' && serverEntry !== null
              ? !((serverEntry as Record<string, unknown>).enabled === false)
              : true
          const written = patchProfileMcpServer(profileName, serverName, {
            enabled: nextEnabled ?? !currentEnabled,
          })
          return json({
            ok: true,
            profile: profileName,
            server: serverName,
            enabled: written.enabled,
          })
        } catch (error) {
          return json(
            {
              ok: false,
              error:
                error instanceof Error
                  ? error.message
                  : 'Failed to update profile MCP config',
            },
            { status: 500 },
          )
        }
      },
    },
  },
})
