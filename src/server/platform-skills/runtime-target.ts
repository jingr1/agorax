import * as path from 'node:path'
import { getCollabDbPath } from '../collab-db'
import { getAgentRuntimeRouter } from '../agent-runtime/router'
import { resolveProfileHermesHome } from '../profiles-browser'

export function platformSkillTarget(agentId: string): {
  runtime: string
  root?: string
  remote?: boolean
} {
  const registry = getAgentRuntimeRouter().registry
  const agent = registry.byId.get(agentId)
  const runtime =
    agent?.runtime ??
    (registry.orphanProfiles.includes(agentId) ? 'hermes' : 'unknown')
  if (agent?.execution === 'ssh') return { runtime, remote: true }
  if (runtime === 'hermes')
    return {
      runtime,
      root: path.join(
        resolveProfileHermesHome(agent?.profile ?? agentId),
        'skills',
      ),
    }
  if (runtime === 'unknown') return { runtime }
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(agentId))
    throw new Error('Invalid agent identifier')
  return {
    runtime,
    root: path.join(
      path.dirname(getCollabDbPath()),
      'platform-skills',
      'managed',
      agentId,
    ),
  }
}
