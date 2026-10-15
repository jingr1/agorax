/**
 * Ensure a group-chat room exists for a mission (task-type entry).
 *
 * Idempotent: same missionId returns the same room and refreshes workspacePath.
 * When workspaceMode=worktree, ensures the mission worktree before storing path.
 */
import { getAgentRuntimeRouter } from '../agent-runtime/router'
import { ensureMissionWorktree } from '../git-ops'
import { getProject } from '../task-pipeline/projects'
import { getSwarmMission, updateMissionRoomId } from '../swarm-missions'
import type { Room, RoomRuntime } from './types'
import {
  addParticipant,
  createRoom,
  findRoomByMissionId,
  listParticipants,
  updateRoom,
} from './room-store'
import { deriveMissionWorkspacePath } from './resolve-room-cwd'

export type EnsureRoomForMissionResult = {
  room: Room
  created: boolean
}

async function resolveMissionWorkspacePath(
  missionId: string,
): Promise<string | null> {
  const mission = getSwarmMission(missionId)
  if (!mission) return null

  if (mission.workspaceMode === 'worktree' && mission.projectId) {
    try {
      const project = getProject(mission.projectId)
      if (project) {
        await ensureMissionWorktree(project, missionId)
      }
    } catch (error) {
      console.warn(
        `[ensure-room-for-mission] ensureMissionWorktree failed for ${missionId}:`,
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  return deriveMissionWorkspacePath(missionId)
}

function inviteMissionAgents(
  roomId: string,
  missionId: string,
  input?: { dbPath?: string },
): void {
  const mission = getSwarmMission(missionId)
  if (!mission) return

  const workerIds = [
    ...new Set(
      mission.assignments
        .map((a) => a.workerId?.trim())
        .filter((id): id is string => Boolean(id)),
    ),
  ]
  if (workerIds.length === 0) return

  let registryAgents: Array<{
    id: string
    runtime: string
    profile?: string
    displayName?: string
    mentionName?: string
  }> = []
  try {
    registryAgents = getAgentRuntimeRouter().registry.agents
  } catch {
    registryAgents = []
  }

  const existing = new Set(
    listParticipants(roomId, input).map((p) => p.participantId),
  )

  for (const workerId of workerIds) {
    if (existing.has(workerId)) continue
    const decl = registryAgents.find((a) => a.id === workerId)
    const runtime = (decl?.runtime ?? 'hermes') as RoomRuntime
    const profile =
      runtime === 'hermes' ? (decl?.profile ?? workerId) : null
    try {
      addParticipant({
        roomId,
        kind: 'agent',
        participantId: workerId,
        displayName: decl?.displayName ?? workerId,
        mentionName: decl?.mentionName ?? workerId,
        profile,
        runtime,
        dbPath: input?.dbPath,
      })
      existing.add(workerId)
    } catch (error) {
      console.warn(
        `[ensure-room-for-mission] failed to add ${workerId}:`,
        error instanceof Error ? error.message : String(error),
      )
    }
  }
}

export async function ensureRoomForMission(input: {
  missionId: string
  dbPath?: string
}): Promise<EnsureRoomForMissionResult> {
  const missionId = input.missionId.trim()
  if (!missionId) {
    throw new Error('missionId required')
  }
  const mission = getSwarmMission(missionId)
  if (!mission) {
    throw new Error(`Mission not found: ${missionId}`)
  }

  const workspacePath = await resolveMissionWorkspacePath(missionId)
  const existing = findRoomByMissionId(missionId, { dbPath: input.dbPath })
  if (existing) {
    const room =
      updateRoom(
        existing.id,
        {
          workspacePath,
          taskId: missionId,
          updatedAt: Date.now(),
        },
        { dbPath: input.dbPath },
      ) ?? existing
    inviteMissionAgents(room.id, missionId, { dbPath: input.dbPath })
  updateMissionRoomId({ missionId, roomId: room.id })
  return { room, created: false }
  }

  const title = mission.title?.trim() || `Mission ${missionId}`
  const room = createRoom({
    title,
    missionId,
    taskId: missionId,
    workspacePath,
    dbPath: input.dbPath,
  })
  inviteMissionAgents(room.id, missionId, { dbPath: input.dbPath })
  updateMissionRoomId({ missionId, roomId: room.id })
  return { room, created: true }
}
