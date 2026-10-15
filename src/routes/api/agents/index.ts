import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import { getAgentRuntimeRouter } from '../../../server/agent-runtime/router'
import {
  getAgentStatusSnapshot,
  startAgentStatusWatcher,
} from '../../../server/agent-status-watcher'
import type { AgentRuntime, AgentWithStatus } from '../../../lib/agent-types'
import type { AgentProbeResult } from '../../../server/agent-runtime/types'
import type { AgentDeclaration } from '../../../server/agent-runtime/agents-config'
import { toAgentStatus } from '../../../lib/agent-status'
import {
  loadGroupChatActivity,
  deriveAgentPresenceForAgent,
} from '../../../lib/agent-status-io'
import { probeHermesProfileGateway } from '../../../server/agent-runtime/hermes-gateway-probe'

function buildStatusSnapshot(
  snapshot: NonNullable<ReturnType<typeof getAgentStatusSnapshot>>,
): NonNullable<AgentWithStatus['statusSnapshot']> {
  return {
    state: snapshot.state,
    currentTask: snapshot.currentTask,
    taskId: snapshot.taskId,
    missionId: snapshot.missionId,
    needsHuman: snapshot.needsHuman,
    checkpointStatus: snapshot.checkpointStatus,
    lastSummary: snapshot.lastSummary,
    updatedAt: snapshot.updatedAt,
  }
}

function buildAgentPayload(
  decl: AgentDeclaration,
  probe: AgentProbeResult,
  groupChatMap: Map<
    string,
    import('../../../lib/agent-status').GroupChatActivity
  >,
): AgentWithStatus {
  const snapshot =
    decl.runtime === 'hermes' ? getAgentStatusSnapshot(decl.id) : undefined
  const presence = deriveAgentPresenceForAgent(
    decl.id,
    snapshot,
    Boolean(probe.available),
    groupChatMap,
    decl.profile,
  )
  return {
    agentId: decl.id,
    name: decl.name ?? decl.displayName ?? decl.mentionName ?? decl.id,
    runtime: decl.runtime as AgentRuntime,
    status: toAgentStatus(presence.unifiedStatus),
    execution: decl.execution,
    currentTaskId: snapshot?.taskId ?? undefined,
    currentMissionId: snapshot?.missionId ?? undefined,
    role: decl.role,
    specialty: decl.specialty,
    runtimeConfig: {
      profile: decl.profile,
      command: decl.command,
      args: decl.args,
      capabilities: decl.capabilities,
      maxConcurrentTasks: decl.maxConcurrentTasks,
    },
    probe: {
      available: probe.available,
      version: probe.version,
      detail: probe.detail,
    },
    statusSnapshot: snapshot ? buildStatusSnapshot(snapshot) : undefined,
  }
}

export const Route = createFileRoute('/api/agents/')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        const t0 = Date.now()
        startAgentStatusWatcher()
        const router = getAgentRuntimeRouter()
        const probes = await router.probeAll()
        const tProbe = Date.now()
        const probeById = new Map(probes.map((p) => [p.agentId, p]))
        const groupChatMap = loadGroupChatActivity()
        const tActivity = Date.now()

        const agents: Array<AgentWithStatus> = []
        for (const decl of router.registry.agents) {
          const probe = probeById.get(decl.id) ?? {
            available: false,
            detail: 'probe missing',
          }
          agents.push(buildAgentPayload(decl, probe, groupChatMap))
        }

        if (!agents.some((agent) => agent.agentId === 'default')) {
          const probe = await probeHermesProfileGateway('default')
          agents.unshift(
            buildAgentPayload(
              {
                id: 'default',
                name: 'Default',
                runtime: 'hermes',
                profile: 'default',
                modes: [],
                tools: [],
                skills: [],
                plugins: [],
                pluginToolsets: [],
                mcpServers: [],
                preferredTaskTypes: [],
                greenlightRequiredFor: [],
                acceptsBroadcast: true,
                reviewRequired: false,
                dispatchable: false,
                execution: 'local',
                capabilities: [],
              },
              probe,
              groupChatMap,
            ),
          )
        }

        const totalMs = Date.now() - t0
        return json(
          { agents, checkedAt: Date.now() },
          {
            headers: {
              'Server-Timing': [
                `probe;dur=${tProbe - t0}`,
                `activity;dur=${tActivity - tProbe}`,
                `total;dur=${totalMs}`,
              ].join(', '),
            },
          },
        )
      },
    },
  },
})
