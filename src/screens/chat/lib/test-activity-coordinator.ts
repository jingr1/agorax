/**
 * Test helper: real Tutti workspace event coordinator + snapshot projector.
 * Product paths create these in runtime factories; tests reuse this shape.
 */

import {
  createAgentActivitySnapshotProjector,
  createAgentActivityWorkspaceEventCoordinator,
  type AgentActivityWorkspaceEventCoordinator,
  type AgentSessionEngine,
} from '@agorax/agent-activity-core'

export function createTestActivityCoordinator(input: {
  engine: AgentSessionEngine
  workspaceId: string
}): {
  coordinator: AgentActivityWorkspaceEventCoordinator
  project: ReturnType<typeof createAgentActivitySnapshotProjector>
} {
  const project = createAgentActivitySnapshotProjector(input.workspaceId)
  const coordinator = createAgentActivityWorkspaceEventCoordinator({
    engine: input.engine,
    notificationScheduler: {
      schedule(delayMs, task) {
        const timer = setTimeout(task, delayMs)
        return { cancel: () => clearTimeout(timer) }
      },
    },
    readCanonicalSnapshot: () => project(input.engine.getSnapshot()),
    workspaceId: input.workspaceId,
  })
  return { coordinator, project }
}
