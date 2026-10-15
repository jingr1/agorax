/**
 * Resolve the working directory for a group-chat room.
 *
 * Priority: explicit room.workspacePath → mission-derived path → null.
 * Mission paths come from per-mission worktree (workspaceMode=worktree) or
 * the project's canonical repo.
 */
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { localGitContext } from '../git-ops'
import { getProject } from '../task-pipeline/projects'
import { getSwarmMission } from '../swarm-missions'
import {
  assertWorkspaceAllowed,
  normalizeCandidate,
} from '../workspace-path-policy'
import type { Room } from './types'

/**
 * Normalize + validate a user-supplied workspace path for create/PATCH.
 * Empty / null → null. Throws on invalid input.
 */
export function validateWorkspacePathInput(
  raw: string | null | undefined,
): string | null {
  if (raw == null) return null
  const trimmed = String(raw).trim()
  if (!trimmed) return null
  const normalized = normalizeCandidate(trimmed)
  if (!path.isAbsolute(normalized)) {
    throw new Error('workspacePath must be an absolute path')
  }
  if (!existsSync(normalized) || !statSync(normalized).isDirectory()) {
    throw new Error(
      `workspacePath does not exist or is not a directory: ${normalized}`,
    )
  }
  assertWorkspaceAllowed(normalized)
  return normalized
}

/**
 * Derive cwd from a mission without ensuring the worktree exists.
 * Returns null when the mission has no project / projects.yaml is missing.
 */
export function deriveMissionWorkspacePath(
  missionId: string,
): string | null {
  const mission = getSwarmMission(missionId)
  if (!mission?.projectId) return null
  let project
  try {
    project = getProject(mission.projectId)
  } catch {
    return null
  }
  if (!project) return null
  if (mission.workspaceMode === 'worktree') {
    return localGitContext(project, missionId).cwd
  }
  return project.repo
}

/**
 * Effective cwd for turns. Prefer the sticky room path; fall back to mission.
 */
export function resolveRoomCwd(room: Room): string | null {
  const explicit = room.workspacePath?.trim()
  if (explicit) {
    try {
      return normalizeCandidate(explicit)
    } catch {
      return explicit
    }
  }
  if (room.missionId) {
    return deriveMissionWorkspacePath(room.missionId)
  }
  return null
}
