import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  SWARM_CANONICAL_REPO,
  SWARM_LEGACY_OUTPUT_ROOT,
  SWARM_MEMORY_HANDOFFS,
} from './swarm-environment'
import type { ParsedSwarmCheckpoint } from './swarm-checkpoints'

const MISSIONS_ROOT = join(SWARM_MEMORY_HANDOFFS, 'swarm', 'missions')

export function swarmMissionRoot(missionId: string): string {
  return join(MISSIONS_ROOT, missionId.trim())
}

export function swarmMissionWorkerDir(
  missionId: string,
  workerId: string,
): string {
  return join(swarmMissionRoot(missionId), workerId.trim())
}

export function swarmMissionEscalationDir(
  missionId: string,
  workerId: string,
): string {
  return join(swarmMissionWorkerDir(missionId, workerId), 'escalations')
}

export function swarmMissionManifestPath(missionId: string): string {
  return join(swarmMissionRoot(missionId), 'manifest.json')
}

export function ensureSwarmMissionArtifactDirs(
  missionId: string,
  workerId: string,
): string {
  const workerDir = swarmMissionWorkerDir(missionId, workerId)
  mkdirSync(workerDir, { recursive: true })
  return workerDir
}

export function isLegacyOutputArtifactPath(pathValue: string): boolean {
  const normalized = pathValue.trim().replace(/\\/g, '/')
  if (!normalized || normalized === 'none') return false
  const legacy = SWARM_LEGACY_OUTPUT_ROOT.replace(/\\/g, '/')
  const rel = `/${legacy}/`
  const abs = normalized.startsWith('/')
    ? normalized
    : resolve(SWARM_CANONICAL_REPO, normalized).replace(/\\/g, '/')
  return (
    abs === legacy ||
    abs.startsWith(`${legacy}/`) ||
    normalized.startsWith('output/')
  )
}

export function splitArtifactPaths(
  filesChanged: string | null | undefined,
): Array<string> {
  if (!filesChanged || filesChanged.trim().toLowerCase() === 'none') return []
  return filesChanged
    .split(/\n|,/)
    .map((part) =>
      part
        .trim()
        .replace(/^[-*]\s*`?|`$/g, '')
        .trim(),
    )
    .filter(Boolean)
}

export function checkpointUsesLegacyOutputPaths(
  filesChanged: string | null | undefined,
): boolean {
  return splitArtifactPaths(filesChanged).some(isLegacyOutputArtifactPath)
}

export function rewriteLegacyOutputPathsInText(
  text: string,
  missionId: string,
): string {
  if (!missionId.trim()) return text
  const missionRoot = swarmMissionRoot(missionId).replace(/\\/g, '/')
  const legacyRoot = SWARM_LEGACY_OUTPUT_ROOT.replace(/\\/g, '/')
  let next = text
  next = next.replaceAll(legacyRoot, `${missionRoot}`)
  next = next.replace(
    /(^|[\s`'"(])output\/([a-z0-9_-]+)\//gi,
    (_match, prefix: string, role: string) => {
      return `${prefix}memory/swarm/missions/${missionId}/${role}/`
    },
  )
  return next
}

export function buildMissionArtifactInstructions(
  missionId: string,
  workerId: string,
): string {
  const workerDir = swarmMissionWorkerDir(missionId, workerId)
  const manifest = swarmMissionManifestPath(missionId)
  return [
    '## Mission artifact directory (required)',
    `Write all deliverables for this assignment under:\n${workerDir}/`,
    `Mission manifest (update when you add files):\n${manifest}`,
    'Do not write new files under `output/` — that tree is legacy and ignored by the platform.',
    'FILES_CHANGED must list absolute paths under the mission directory above.',
  ].join('\n')
}

export function applyArtifactPathPolicy(
  checkpoint: ParsedSwarmCheckpoint,
  missionId: string | null | undefined,
  workerId: string,
): ParsedSwarmCheckpoint {
  if (!missionId || checkpoint.stateLabel !== 'DONE') return checkpoint
  if (!checkpointUsesLegacyOutputPaths(checkpoint.filesChanged))
    return checkpoint
  const expected = swarmMissionWorkerDir(missionId, workerId)
  const blocker = `FILES_CHANGED references legacy output/ paths. Rewrite deliverables under ${expected}/ and return a new checkpoint.`
  return {
    ...checkpoint,
    stateLabel: 'BLOCKED',
    runtimeState: 'blocked',
    checkpointStatus: 'blocked',
    blocker,
    nextAction: `Move or recreate artifacts under ${expected}/, update manifest.json, then return STATE: DONE with corrected FILES_CHANGED.`,
    raw: `${checkpoint.raw}\n\nPLATFORM_ARTIFACT_POLICY: ${blocker}`,
  }
}
