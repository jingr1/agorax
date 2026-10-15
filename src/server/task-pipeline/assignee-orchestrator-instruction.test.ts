/**
 * @vitest-environment node
 */
import { describe, expect, it, afterEach } from 'vitest'
import {
  buildAssigneeTaskInstruction,
  workspaceDispatchBaseUrl,
} from './task-service'

describe('buildAssigneeTaskInstruction', () => {
  const prevPort = process.env.PORT

  afterEach(() => {
    if (prevPort === undefined) delete process.env.PORT
    else process.env.PORT = prevPort
  })

  it('includes swarm-dispatch contract for orchestrator assignee', () => {
    process.env.PORT = '6734'
    const text = buildAssigneeTaskInstruction({
      missionId: 'mission-abc',
      title: 'Ship feature',
      spec: 'Build the widget',
      acceptanceCriteria: ['tests pass'],
      assigneeId: 'orchestrator',
    })
    expect(text).toContain('mission_id: mission-abc')
    expect(text).toContain('Orchestrator dispatch contract')
    expect(text).toContain(
      `${workspaceDispatchBaseUrl()}/api/swarm-dispatch`,
    )
    expect(text).toContain('"missionId": "mission-abc"')
    expect(text).toContain('researcher')
    expect(text).toContain('Do **not** use `sessions_spawn`')
  })

  it('omits dispatch contract for non-orchestrator assignees', () => {
    const text = buildAssigneeTaskInstruction({
      missionId: 'mission-xyz',
      title: 'Quick fix',
      spec: 'Fix the bug',
      assigneeId: 'developer',
    })
    expect(text).toContain('mission_id: mission-xyz')
    expect(text).not.toContain('Orchestrator dispatch contract')
    expect(text).not.toContain('/api/swarm-dispatch')
  })
})
