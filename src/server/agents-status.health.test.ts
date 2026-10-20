import { describe, expect, it } from 'vitest'

import { summarizeHealth } from './agents-status'
import type { AgentStatusEntry } from '../lib/mission-control-api'

function entry(
  agentId: string,
  status: Partial<NonNullable<AgentStatusEntry['status']>>,
): AgentStatusEntry {
  return {
    agentId,
    runtime: 'hermes',
    execution: 'local',
    probe: { available: true },
    status: {
      agentId,
      runtime: 'hermes',
      state: 'idle',
      currentTask: null,
      taskId: null,
      missionId: null,
      needsHuman: false,
      checkpointStatus: 'none',
      lastSummary: null,
      updatedAt: Date.now(),
      availability: 'online',
      workload: 'idle',
      blocked: false,
      error: false,
      unifiedStatus: 'idle',
      needsSetup: false,
      ...status,
    },
  }
}

describe('summarizeHealth', () => {
  it('counts blocked and needsHuman separately', () => {
    const health = summarizeHealth([
      entry('a', {
        blocked: true,
        unifiedStatus: 'blocked',
        state: 'blocked',
      }),
      entry('b', { needsHuman: true, unifiedStatus: 'blocked', blocked: true }),
    ])
    expect(health.blocked).toBe(2)
    expect(health.needsHuman).toBe(1)
    expect(health.degraded).toBe(true)
  })

  it('counts online availability without requiring active workload', () => {
    const health = summarizeHealth([
      entry('a', { availability: 'online', unifiedStatus: 'idle' }),
      entry('b', {
        availability: 'offline',
        unifiedStatus: 'offline',
      }),
    ])
    expect(health.online).toBe(1)
    expect(health.offline).toBe(1)
    expect(health.active).toBe(0)
  })
})
