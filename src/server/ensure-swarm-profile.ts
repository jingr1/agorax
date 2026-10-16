/**
 * Ensure Hermes Swarm seed profiles exist (clone-from default + sync).
 * Reuses createProfile — does not reimplement profile FS creation.
 *
 * Which ids to ensure is declared in agents.yaml (`ensureProfile: true`).
 * Install (scripts/ensure-swarm-profiles.mjs) is the primary path;
 * agent chat calls ensureAgentProfile as a per-id fallback.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'
import {
  createProfile,
  isLiveNamedProfile,
} from './profiles-browser'
import { SWARM_CANONICAL_REPO } from './swarm-environment'
import { listEnsureProfileAgentIds } from './swarm-roster'

const inflight = new Map<string, Promise<EnsureAgentProfileResult>>()

export type EnsureAgentProfileResult = {
  agentId: string
  status: 'skipped' | 'created' | 'exists' | 'no_default'
  detail?: string
}

function hermesRoot(): string {
  return process.env.HERMES_HOME?.trim() || join(homedir(), '.hermes')
}

export function hasDefaultHermesProfile(): boolean {
  return existsSync(join(hermesRoot(), 'config.yaml'))
}

/** @deprecated Prefer listEnsureProfileAgentIds() — ids come from agents.yaml. */
export function listSwarmSeedProfileIds(
  repoRoot: string = SWARM_CANONICAL_REPO,
): Array<string> {
  return listEnsureProfileAgentIds(repoRoot)
}

export function isSwarmSeedProfileId(
  id: string,
  repoRoot: string = SWARM_CANONICAL_REPO,
): boolean {
  return listEnsureProfileAgentIds(repoRoot).includes(id)
}

function runSyncSwarmProfiles(repoRoot = SWARM_CANONICAL_REPO): void {
  const script = join(repoRoot, 'scripts', 'sync-swarm-profiles.mjs')
  if (!existsSync(script)) {
    throw new Error(`sync-swarm-profiles.mjs not found at ${script}`)
  }
  execFileSync(process.execPath, [script], {
    cwd: repoRoot,
    stdio: 'pipe',
    timeout: 120_000,
  })
}

/**
 * Ensure one agents.yaml ensureProfile Hermes profile. No-op for other ids,
 * default, or when the profile already exists. Missing default → no_default.
 */
export async function ensureAgentProfile(
  agentId: string,
  options?: { repoRoot?: string; sync?: boolean },
): Promise<EnsureAgentProfileResult> {
  const id = agentId.trim()
  const repoRoot = options?.repoRoot ?? SWARM_CANONICAL_REPO
  if (!id || id === 'default' || !isSwarmSeedProfileId(id, repoRoot)) {
    return {
      agentId: id,
      status: 'skipped',
      detail: 'not an ensureProfile Hermes seed agent',
    }
  }

  const existing = inflight.get(id)
  if (existing) return existing

  const run = (async (): Promise<EnsureAgentProfileResult> => {
    if (isLiveNamedProfile(id)) {
      return { agentId: id, status: 'exists' }
    }
    if (!hasDefaultHermesProfile()) {
      return {
        agentId: id,
        status: 'no_default',
        detail: 'Hermes default profile (~/.hermes/config.yaml) is missing',
      }
    }
    try {
      createProfile(id, { cloneFrom: 'default' })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/already exists/i.test(message) && isLiveNamedProfile(id)) {
        return { agentId: id, status: 'exists' }
      }
      throw error
    }
    if (options?.sync !== false) {
      runSyncSwarmProfiles(repoRoot)
    }
    return { agentId: id, status: 'created' }
  })()

  inflight.set(id, run)
  try {
    return await run
  } finally {
    inflight.delete(id)
  }
}

export type EnsureSwarmSeedProfilesResult = {
  results: Array<EnsureAgentProfileResult>
  synced: boolean
}

/** Batch ensure all agents.yaml ensureProfile: true Hermes agents, then sync. */
export async function ensureSwarmSeedProfiles(options?: {
  repoRoot?: string
}): Promise<EnsureSwarmSeedProfilesResult> {
  const repoRoot = options?.repoRoot ?? SWARM_CANONICAL_REPO
  const ids = listEnsureProfileAgentIds(repoRoot)

  if (!hasDefaultHermesProfile()) {
    return {
      results: ids.map((agentId) => ({
        agentId,
        status: 'no_default' as const,
        detail: 'Hermes default profile (~/.hermes/config.yaml) is missing',
      })),
      synced: false,
    }
  }

  const results: Array<EnsureAgentProfileResult> = []
  let anyCreated = false
  for (const id of ids) {
    const result = await ensureAgentProfile(id, {
      repoRoot,
      sync: false,
    })
    results.push(result)
    if (result.status === 'created') anyCreated = true
  }

  const needsSync =
    ids.length > 0 &&
    (anyCreated ||
      results.some((r) => r.status === 'exists' || r.status === 'created'))
  if (needsSync) {
    runSyncSwarmProfiles(repoRoot)
  }
  return { results, synced: needsSync }
}
