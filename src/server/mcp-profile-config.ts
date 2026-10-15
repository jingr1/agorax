/**
 * Profile-backed MCP config CRUD.
 *
 * Used by /api/mcp fallback (local control plane) and platform-mcp materialize.
 * Reads/writes `mcp_servers` in `~/.hermes/profiles/<name>/config.yaml`
 * (or default hermes root) via profiles-browser — no dashboard required.
 */
import type { McpServerInput } from '../types/mcp-input'
import {
  getActiveProfileName,
  readProfile,
  updateProfileConfig,
} from './profiles-browser'
import {
  normalizeMcpListFromConfig,
  normalizeMcpServerFromConfig,
} from './mcp-normalize'
import type { McpServer } from '../types/mcp'

/** Marker written into materialized platform MCP entries. */
export const AGORAX_PLATFORM_MCP_MARKER = '_agorax_platform'

export function toConfigEntry(input: McpServerInput): Record<string, unknown> {
  const out: Record<string, unknown> = {
    transport: input.transportType,
  }
  if (typeof input.enabled === 'boolean') out.enabled = input.enabled
  if (input.url) out.url = input.url
  if (input.command) out.command = input.command
  if (input.args && input.args.length > 0) out.args = input.args
  if (input.env && Object.keys(input.env).length > 0) out.env = input.env
  if (input.headers && Object.keys(input.headers).length > 0)
    out.headers = input.headers
  if (input.toolMode && input.toolMode !== 'all') out.tool_mode = input.toolMode
  if (input.includeTools && input.includeTools.length > 0)
    out.include_tools = input.includeTools
  if (input.excludeTools && input.excludeTools.length > 0)
    out.exclude_tools = input.excludeTools
  if (input.authType && input.authType !== 'none') {
    const auth: Record<string, unknown> = { type: input.authType }
    if (input.bearerToken) auth.token = input.bearerToken
    if (input.oauth) auth.oauth = { ...input.oauth }
    out.auth = auth
  } else if (input.bearerToken || input.oauth) {
    const auth: Record<string, unknown> = {}
    if (input.bearerToken) auth.token = input.bearerToken
    if (input.oauth) auth.oauth = { ...input.oauth }
    out.auth = auth
  }
  return out
}

export function resolveMcpProfileName(requested?: string | null): string {
  const trimmed = (requested || '').trim()
  if (trimmed) return trimmed
  try {
    return getActiveProfileName()
  } catch {
    return 'default'
  }
}

export function readProfileMcpServersMap(
  profileName: string,
): Record<string, unknown> {
  const profile = readProfile(profileName)
  const raw = profile.config.mcp_servers
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return { ...(raw as Record<string, unknown>) }
  }
  return {}
}

/**
 * Replace the entire `mcp_servers` map (supports deletions).
 * Uses null-then-set because updateProfileConfig deep-merges nested objects.
 */
export function writeProfileMcpServersMap(
  profileName: string,
  servers: Record<string, unknown>,
): void {
  updateProfileConfig(profileName, { mcp_servers: null })
  updateProfileConfig(profileName, { mcp_servers: servers })
}

export function listProfileMcpServers(profileName: string): Array<McpServer> {
  const profile = readProfile(profileName)
  return normalizeMcpListFromConfig(profile.config)
}

export function upsertProfileMcpServer(
  profileName: string,
  input: McpServerInput,
): McpServer {
  const servers = readProfileMcpServersMap(profileName)
  servers[input.name] = toConfigEntry(input)
  writeProfileMcpServersMap(profileName, servers)
  const written = normalizeMcpServerFromConfig(input.name, servers[input.name])
  if (!written) {
    throw new Error('MCP upsert failed (config write)')
  }
  return written
}

export function patchProfileMcpServer(
  profileName: string,
  name: string,
  patch: {
    enabled?: boolean
    toolMode?: string
    includeTools?: Array<string>
    excludeTools?: Array<string>
  },
): McpServer {
  const servers = readProfileMcpServersMap(profileName)
  const existing = servers[name]
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
    throw new Error(`MCP server not found: ${name}`)
  }
  const next: Record<string, unknown> = {
    ...(existing as Record<string, unknown>),
  }
  if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled
  if (patch.toolMode) next.tool_mode = patch.toolMode
  if (Array.isArray(patch.includeTools)) next.include_tools = patch.includeTools
  if (Array.isArray(patch.excludeTools)) next.exclude_tools = patch.excludeTools
  servers[name] = next
  writeProfileMcpServersMap(profileName, servers)
  const written = normalizeMcpServerFromConfig(name, next)
  if (!written) {
    throw new Error('MCP configure failed (config write)')
  }
  return written
}

export function deleteProfileMcpServer(
  profileName: string,
  name: string,
): void {
  const servers = readProfileMcpServersMap(profileName)
  if (!(name in servers)) {
    throw new Error(`MCP server not found: ${name}`)
  }
  delete servers[name]
  writeProfileMcpServersMap(profileName, servers)
}

export function isPlatformMcpEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false
  return (entry as Record<string, unknown>)[AGORAX_PLATFORM_MCP_MARKER] === true
}
