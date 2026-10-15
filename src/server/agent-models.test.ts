import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildHermesProfileModels,
  buildAgentModels,
} from './agent-models'

describe('agent-models', () => {
  let tempRoot: string
  let prevHermesHome: string | undefined

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agorax-agent-models-'))
    prevHermesHome = process.env.HERMES_HOME
    process.env.HERMES_HOME = tempRoot

    const orchestratorHome = path.join(tempRoot, 'profiles', 'orchestrator')
    const developerHome = path.join(tempRoot, 'profiles', 'developer')
    fs.mkdirSync(orchestratorHome, { recursive: true })
    fs.mkdirSync(developerHome, { recursive: true })

    fs.writeFileSync(
      path.join(orchestratorHome, 'config.yaml'),
      [
        'model:',
        '  default: Kimi-K2.7-Code',
        '  provider: tokenx',
        'providers:',
        '  tokenx:',
        '    models:',
        '      - Kimi-K2.7-Code',
        '      - GLM-5.2',
        '',
      ].join('\n'),
      'utf-8',
    )

    fs.writeFileSync(
      path.join(developerHome, 'config.yaml'),
      [
        'model:',
        '  default: gpt-5.6-terra',
        '  provider: openai-codex',
        'providers:',
        '  tokenx:',
        '    models:',
        '      - Kimi-K2.7-Code',
        '  openai-codex:',
        '    default_model: gpt-5.6-terra',
        '    models:',
        '      - gpt-5.6-terra',
        '      - gpt-5.6-sol',
        '',
      ].join('\n'),
      'utf-8',
    )
  })

  afterEach(() => {
    if (prevHermesHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = prevHermesHome
    fs.rmSync(tempRoot, { recursive: true, force: true })
  })

  it('returns different catalogs for different Hermes profiles', () => {
    const orch = buildHermesProfileModels('orchestrator')
    const dev = buildHermesProfileModels('developer')

    expect(orch.currentModel).toBe('Kimi-K2.7-Code')
    expect(orch.currentProvider).toBe('tokenx')
    expect(orch.models.map((m) => m.id)).toEqual(
      expect.arrayContaining(['Kimi-K2.7-Code', 'GLM-5.2']),
    )
    expect(orch.models.map((m) => m.id)).not.toContain('gpt-5.6-terra')

    expect(dev.currentModel).toBe('gpt-5.6-terra')
    expect(dev.currentProvider).toBe('openai-codex')
    expect(dev.models.map((m) => m.id)).toEqual(
      expect.arrayContaining(['gpt-5.6-terra', 'gpt-5.6-sol', 'Kimi-K2.7-Code']),
    )
    expect(dev.source).toContain('developer')
    expect(orch.source).toContain('orchestrator')
  })

  it('buildAgentModels resolves registry hermes agents by profile', async () => {
    // agents.yaml is loaded from the real workspace; orchestrator/developer exist.
    const orch = await buildAgentModels('orchestrator')
    expect(orch.ok).toBe(true)
    expect(orch.runtime).toBe('hermes')
    // Uses real profile when HERMES_HOME is our temp with matching names.
    expect(orch.currentModel).toBe('Kimi-K2.7-Code')
  })
})
