/**
 * Materialize enabled platform MCP bindings for an agent.
 *
 * - Hermes: merge into profile config.yaml `mcp_servers` (platform-marked only).
 * - Managed: bindings in collab.db are the source of truth; no profile FS write.
 *   Runtime adapters (e.g. Claude Code) inject via resolveEnabledPlatformMcpEntries
 *   at startRun.
 */
import { getAgentRuntimeRouter } from '../agent-runtime/router'
import {
  AGORAX_PLATFORM_MCP_MARKER,
  isPlatformMcpEntry,
  readProfileMcpServersMap,
  writeProfileMcpServersMap,
} from '../mcp-profile-config'
import { listAgentIdsBoundToMcp } from './store'
import { resolveEnabledPlatformMcpEntries } from './resolve'

export function materializeHermesAgentMcp(agentId: string): {
  runtime: string
  profile?: string
  written: Array<string>
  skippedPrivate: Array<string>
} {
  return materializeAgentMcp(agentId)
}

export function materializeAgentMcp(agentId: string): {
  runtime: string
  profile?: string
  written: Array<string>
  skippedPrivate: Array<string>
} {
  const router = getAgentRuntimeRouter()
  const decl = router.registry.byId.get(agentId)
  const isHermes =
    decl?.runtime === 'hermes' ||
    (!decl && router.registry.orphanProfiles.includes(agentId))
  const enabled = resolveEnabledPlatformMcpEntries(agentId)
  const writtenNames = enabled.map((e) => e.name)

  if (!isHermes) {
    // Managed: persist nothing on disk here — adapters inject at startRun.
    return {
      runtime: decl?.runtime ?? 'unknown',
      written: writtenNames,
      skippedPrivate: [],
    }
  }

  const profileName = decl?.profile ?? agentId
  const enabledByName = new Map(
    enabled.map((e) => [e.name, e.config] as const),
  )

  let current: Record<string, unknown>
  try {
    current = readProfileMcpServersMap(profileName)
  } catch {
    return {
      runtime: 'hermes',
      profile: profileName,
      written: [],
      skippedPrivate: [],
    }
  }

  const next: Record<string, unknown> = {}
  const skippedPrivate: Array<string> = []
  const written: Array<string> = []

  for (const [name, entry] of Object.entries(current)) {
    if (!isPlatformMcpEntry(entry)) {
      next[name] = entry
    }
  }

  for (const [name, entry] of enabledByName) {
    if (name in next && !isPlatformMcpEntry(next[name])) {
      skippedPrivate.push(name)
      continue
    }
    next[name] = {
      ...entry,
      [AGORAX_PLATFORM_MCP_MARKER]: true,
    }
    written.push(name)
  }

  writeProfileMcpServersMap(profileName, next)
  return {
    runtime: 'hermes',
    profile: profileName,
    written,
    skippedPrivate,
  }
}

/** Rematerialize every agent currently bound to a library server. */
export function rematerializeAgentsForMcpServer(serverId: string): Array<string> {
  const agents = listAgentIdsBoundToMcp(serverId)
  for (const agentId of agents) {
    materializeAgentMcp(agentId)
  }
  return agents
}
