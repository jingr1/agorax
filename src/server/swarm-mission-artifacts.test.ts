import { describe, expect, it } from 'vitest'
import {
  applyArtifactPathPolicy,
  buildMissionArtifactInstructions,
  checkpointUsesLegacyOutputPaths,
  isLegacyOutputArtifactPath,
  rewriteLegacyOutputPathsInText,
  swarmMissionWorkerDir,
} from './swarm-mission-artifacts'
import { SWARM_LEGACY_OUTPUT_ROOT } from './swarm-environment'
import type { ParsedSwarmCheckpoint } from './swarm-checkpoints'

describe('swarm-mission-artifacts', () => {
  it('builds mission-scoped worker directories', () => {
    const dir = swarmMissionWorkerDir('lg-test', 'researcher')
    expect(dir).toContain('memory/swarm/missions/lg-test/researcher')
  })

  it('detects legacy output paths', () => {
    expect(isLegacyOutputArtifactPath('output/researcher/report.md')).toBe(true)
    expect(
      isLegacyOutputArtifactPath(
        'memory/swarm/missions/lg-test/researcher/report.md',
      ),
    ).toBe(false)
  })

  it('rewrites output paths in dispatch text', () => {
    const rewritten = rewriteLegacyOutputPathsInText(
      'Write to output/researcher/report.md and output/architect/spec.md',
      'lg-test',
    )
    expect(rewritten).toContain('memory/swarm/missions/lg-test/researcher/')
    expect(rewritten).toContain('memory/swarm/missions/lg-test/architect/')
    expect(rewritten).not.toContain('output/researcher')
  })

  it('builds artifact instructions without output/', () => {
    const text = buildMissionArtifactInstructions('lg-test', 'architect')
    expect(text).toContain('memory/swarm/missions/lg-test/architect')
    expect(text).toContain('Do not write new files under `output/`')
  })

  it('flags legacy paths in checkpoint filesChanged', () => {
    // Relative legacy path (machine-agnostic).
    expect(checkpointUsesLegacyOutputPaths('output/researcher/a.md')).toBe(true)
    // Absolute path under the current canonical repo's legacy root.
    expect(
      checkpointUsesLegacyOutputPaths(
        `${SWARM_LEGACY_OUTPUT_ROOT}/researcher/a.md`,
      ),
    ).toBe(true)
  })

  it('downgrades DONE checkpoints that reference legacy output paths', () => {
    const checkpoint: ParsedSwarmCheckpoint = {
      stateLabel: 'DONE',
      runtimeState: 'idle',
      checkpointStatus: 'done',
      filesChanged: 'output/researcher/report.md',
      commandsRun: 'none',
      result: 'done',
      blocker: 'none',
      nextAction: 'none',
      reviewOutcome: null,
      raw: 'STATE: DONE',
    }
    const adjusted = applyArtifactPathPolicy(
      checkpoint,
      'lg-test',
      'researcher',
    )
    expect(adjusted.stateLabel).toBe('BLOCKED')
    expect(adjusted.blocker).toContain('legacy output/')
  })
})
