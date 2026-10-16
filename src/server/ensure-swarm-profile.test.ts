import { describe, expect, it } from 'vitest'
import {
  isSwarmSeedProfileId,
  listSwarmSeedProfileIds,
} from './ensure-swarm-profile'
import {
  isBuiltinAgentId,
  listEnsureProfileAgentIds,
} from './swarm-roster'

describe('ensureProfile from agents.yaml', () => {
  it('lists the six Swarm workers marked ensureProfile: true', () => {
    const ids = listEnsureProfileAgentIds()
    expect(ids).toEqual([
      'orchestrator',
      'researcher',
      'architect',
      'developer',
      'writer',
      'learning',
    ])
    expect(listSwarmSeedProfileIds()).toEqual(ids)
    expect(isSwarmSeedProfileId('orchestrator')).toBe(true)
    expect(isSwarmSeedProfileId('learning')).toBe(true)
    expect(isSwarmSeedProfileId('gpuserver')).toBe(false)
    expect(isSwarmSeedProfileId('default')).toBe(false)
  })
})

describe('builtin from agents.yaml.example', () => {
  it('treats template ids as builtin', () => {
    expect(isBuiltinAgentId('orchestrator')).toBe(true)
    expect(isBuiltinAgentId('default')).toBe(true)
    expect(isBuiltinAgentId('definitely-not-a-seed-agent-xyz')).toBe(false)
  })
})
