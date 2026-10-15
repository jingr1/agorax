/**
 * Shared builder for GET /api/agents/status and /api/agents/snapshot.
 */
import { getAgentRuntimeRouter } from './agent-runtime/router'
import {
  getAgentStatusSnapshot,
  startAgentStatusWatcher,
} from './agent-status-watcher'
import type { AgentStatusEntry } from '../lib/mission-control-api'
import type { AgentPresence } from '../lib/agent-status'
import {
  deriveAgentPresenceForAgent,
  loadGroupChatActivity,
} from '../lib/agent-status-io'
import { probeHermesProfileGateway } from './agent-runtime/hermes-gateway-probe'

export type AgentsStatusPayload = {
  agents: Array<AgentStatusEntry>
  orphanProfiles: Array<string>
  checkedAt: number
}

export type AgentsHealthSummary = {
  online: number
  active: number
  blocked: number
  needsHuman: number
  offline: number
  needsSetup: number
  working: number
  unstable: number
  degraded: boolean
}

export type AgentsSnapshotPayload = AgentsStatusPayload & {
  health: AgentsHealthSummary
}

function emptyGroupChatMap() {
  return loadGroupChatActivity()
}

function attachPresenceFields(
  base: Omit<
    NonNullable<AgentStatusEntry['status']>,
    | 'availability'
    | 'workload'
    | 'blocked'
    | 'error'
    | 'unifiedStatus'
    | 'needsSetup'
  >,
  presence: AgentPresence,
): NonNullable<AgentStatusEntry['status']> {
  return {
    ...base,
    availability: presence.availability,
    workload: presence.workload,
    blocked: presence.blocked,
    error: presence.error,
    unifiedStatus: presence.unifiedStatus,
    needsSetup: presence.needsSetup,
  }
}

function summarizeHealth(
  agents: Array<AgentStatusEntry>,
): AgentsHealthSummary {
  let online = 0
  let active = 0
  let blocked = 0
  let needsHuman = 0
  let offline = 0
  let needsSetup = 0
  let working = 0
  let unstable = 0
  for (const agent of agents) {
    const status = agent.status
    if (!status) continue
    if (status.availability === 'online') online += 1
    if (status.availability === 'unstable') unstable += 1
    if (status.availability === 'offline') offline += 1
    if (status.workload === 'working') working += 1
    if (status.unifiedStatus === 'active') active += 1
    if (status.blocked || status.error || status.unifiedStatus === 'blocked') {
      blocked += 1
    }
    if (status.needsHuman || status.blocked) needsHuman += 1
    if (status.needsSetup) needsSetup += 1
  }
  return {
    online,
    active,
    blocked,
    needsHuman,
    offline,
    needsSetup,
    working,
    unstable,
    degraded: blocked > 0 || needsHuman > 0,
  }
}

export async function buildAgentsStatusPayload(): Promise<AgentsStatusPayload> {
  startAgentStatusWatcher()
  const router = getAgentRuntimeRouter()
  const agents = await router.probeAll()
  const groupChatMap = emptyGroupChatMap()

  const hermesAgentIds = new Set([
    ...router.registry.agents
      .filter((a) => a.runtime === 'hermes')
      .map((a) => a.id),
    ...router.registry.orphanProfiles,
  ])

  const statuses = new Map<
    string,
    ReturnType<typeof getAgentStatusSnapshot>
  >()
  for (const agentId of hermesAgentIds) {
    statuses.set(agentId, getAgentStatusSnapshot(agentId))
  }

  const entries: Array<AgentStatusEntry> = agents.map((agent) => {
    const isHermes = hermesAgentIds.has(agent.agentId)
    const snapshot = isHermes ? (statuses.get(agent.agentId) ?? null) : null
    const presence = deriveAgentPresenceForAgent(
      agent.agentId,
      snapshot,
      Boolean(agent.available),
      groupChatMap,
      router.registry.byId.get(agent.agentId)?.profile,
    )
    const runtime = agent.runtime as AgentStatusEntry['runtime']
    const status = attachPresenceFields(
      snapshot
        ? {
            agentId: snapshot.agentId,
            runtime,
            state: snapshot.state,
            currentTask: snapshot.currentTask,
            taskId: snapshot.taskId,
            missionId: snapshot.missionId,
            needsHuman: snapshot.needsHuman,
            checkpointStatus: snapshot.checkpointStatus,
            lastSummary: snapshot.lastSummary,
            updatedAt: snapshot.updatedAt,
          }
        : {
            agentId: agent.agentId,
            runtime,
            state: 'offline',
            currentTask: null,
            taskId: null,
            missionId: null,
            needsHuman: false,
            checkpointStatus: 'none',
            lastSummary: null,
            // 0 = never seen; do not use Date.now() (false unstable).
            updatedAt: 0,
          },
      presence,
    )
    return {
      agentId: agent.agentId,
      runtime,
      execution: agent.execution,
      probe: {
        available: agent.available,
        version: agent.version,
        detail: agent.detail,
      },
      status,
    }
  })

  const orphanEntries = await Promise.all(
    router.registry.orphanProfiles.map(async (profile) => {
      const probe = await probeHermesProfileGateway(profile)
      const snapshot = statuses.get(profile) ?? null
      const presence = deriveAgentPresenceForAgent(
        profile,
        snapshot,
        Boolean(probe.available),
        groupChatMap,
        profile,
      )
      return {
        agentId: profile,
        runtime: 'hermes' as const,
        execution: 'local' as const,
        probe: {
          available: probe.available,
          version: probe.version,
          detail:
            probe.detail ?? `hermes profile ${profile} (unmanaged path)`,
        },
        status: snapshot
          ? attachPresenceFields(
              {
                ...snapshot,
                runtime: 'hermes' as const,
              },
              presence,
            )
          : attachPresenceFields(
              {
                agentId: profile,
                runtime: 'hermes',
                state: 'offline',
                currentTask: null,
                taskId: null,
                missionId: null,
                needsHuman: false,
                checkpointStatus: 'none',
                lastSummary: null,
                updatedAt: 0,
              },
              presence,
            ),
      }
    }),
  )
  entries.push(...orphanEntries)

  return {
    agents: entries,
    orphanProfiles: router.registry.orphanProfiles,
    checkedAt: Date.now(),
  }
}

export async function buildAgentsSnapshotPayload(): Promise<AgentsSnapshotPayload> {
  const status = await buildAgentsStatusPayload()
  return {
    ...status,
    health: summarizeHealth(status.agents),
  }
}
