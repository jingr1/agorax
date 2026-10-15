import { describe, expect, it } from 'vitest'
import {
  generateStageBrief,
  renderStrictTemplate,
} from './stage-brief'
import type { PipelineStage } from './pipeline-templates'

const stage = (partial: Partial<PipelineStage> & { key: string }): PipelineStage => ({
  key: partial.key,
  agent: partial.agent ?? 'researcher',
  kind: partial.kind ?? 'work',
  dependsOn: partial.dependsOn ?? [],
  reworkTarget: partial.reworkTarget ?? null,
  maxRework: partial.maxRework ?? 2,
  requires: partial.requires ?? [],
  prompt: partial.prompt ?? null,
  promptFile: partial.promptFile ?? null,
  skillRefs: partial.skillRefs ?? [],
  outcomes: partial.outcomes ?? [],
})

describe('stage-brief templates', () => {
  it('fails on unknown template variables', () => {
    expect(() =>
      renderStrictTemplate('Hello {{ mission.missing }}', {
        mission: { title: 'x' },
      }),
    ).toThrow(/unknown variable/)
  })

  it('renders mission title and spec from custom prompt', () => {
    const brief = generateStageBrief({
      stage: stage({
        key: 'research',
        prompt: '# {{ mission.title }}\n\n{{ mission.spec }}',
      }),
      taskTitle: 'Ship Mission UX',
      spec: 'Build the surface',
      acceptanceCriteria: ['tests pass'],
      specVersion: 1,
    })
    expect(brief.instruction).toContain('Ship Mission UX')
    expect(brief.instruction).toContain('Build the surface')
  })

  it('includes skill refs in default template', () => {
    const brief = generateStageBrief({
      stage: stage({
        key: 'research',
        skillRefs: ['researcher-core'],
      }),
      taskTitle: 'T',
      spec: 'S',
      acceptanceCriteria: [],
      specVersion: 2,
    })
    expect(brief.instruction).toContain('researcher-core')
    expect(brief.specVersion).toBe(2)
  })
})
