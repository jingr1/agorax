/**
 * lane-sync — thin board helpers over MissionStatus (Multica: column = status).
 */
import type { SwarmMission } from '../swarm-missions'
import {
  deriveMissionStatus,
  effectiveMissionStatus,
  normalizeMissionStatus,
  type KanbanLane,
  type MissionStatus,
} from './mission-status'

export type { KanbanLane, MissionStatus }
export {
  deriveMissionStatus,
  effectiveMissionStatus,
  normalizeMissionStatus,
  MISSION_STATUSES,
  isMissionStatus,
} from './mission-status'

/** Derived status from assignments (ignores human board pin). */
export function laneFromMission(mission: SwarmMission): MissionStatus {
  return deriveMissionStatus(mission.assignments ?? [])
}

/** Effective board/list column: human pin when set, else derived. */
export function effectiveBoardLane(mission: SwarmMission): MissionStatus {
  return effectiveMissionStatus({
    state: mission.state,
    boardLane: mission.boardLane,
    assignments: mission.assignments,
  })
}

/**
 * @deprecated Cards removed from Mission domain. Returns derived status only.
 */
export async function syncLaneFromMission(input: {
  missionId: string
}): Promise<MissionStatus | null> {
  const { getSwarmMission } = await import('../swarm-missions')
  const mission = getSwarmMission(input.missionId)
  if (!mission) return null
  return laneFromMission(mission)
}

export function normalizeBoardLane(value: unknown): MissionStatus {
  return normalizeMissionStatus(value)
}
