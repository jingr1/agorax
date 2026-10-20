import { describe, expect, it } from 'vitest'
import { normalizeAgentId, planHermesAgentCreate } from './create-agent'

describe('normalizeAgentId', () => {
  it('slugs names', () => {
    expect(normalizeAgentId('GPU Server')).toBe('gpu-server')
  })
})

describe('planHermesAgentCreate', () => {
  it('plans a new profile by default', () => {
    expect(
      planHermesAgentCreate({ name: 'Sage', runtime: 'hermes' }),
    ).toMatchObject({
      hermesSetup: 'new',
      id: 'sage',
      profile: 'sage',
      shouldCreateProfile: true,
    })
  })

  it('plans claiming an existing profile without create', () => {
    expect(
      planHermesAgentCreate({
        name: 'dev-1',
        runtime: 'hermes',
        hermesSetup: 'existing',
        existingProfile: 'dev-1',
      }),
    ).toMatchObject({
      hermesSetup: 'existing',
      id: 'dev-1',
      profile: 'dev-1',
      shouldCreateProfile: false,
    })
  })

  it('allows agent id to differ from claimed profile', () => {
    expect(
      planHermesAgentCreate({
        name: 'Worker A',
        runtime: 'hermes',
        hermesSetup: 'existing',
        existingProfile: 'gpuserver',
      }),
    ).toMatchObject({
      id: 'worker-a',
      profile: 'gpuserver',
      shouldCreateProfile: false,
    })
  })

  it('plans clone-agent with a distinct source id', () => {
    expect(
      planHermesAgentCreate({
        name: 'developer-2',
        runtime: 'hermes',
        hermesSetup: 'clone-agent',
        cloneAgentId: 'developer',
      }),
    ).toMatchObject({
      hermesSetup: 'clone-agent',
      id: 'developer-2',
      profile: 'developer-2',
      shouldCreateProfile: true,
      cloneAgentId: 'developer',
    })
  })

  it('rejects cloning onto the same agent id', () => {
    expect(() =>
      planHermesAgentCreate({
        name: 'developer',
        runtime: 'hermes',
        hermesSetup: 'clone-agent',
        cloneAgentId: 'developer',
      }),
    ).toThrow(/differ/)
  })

  it('requires a clone source', () => {
    expect(() =>
      planHermesAgentCreate({
        name: 'copy',
        runtime: 'hermes',
        hermesSetup: 'clone-agent',
      }),
    ).toThrow(/Select an agent/)
  })
})
