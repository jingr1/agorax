/**
 * Checkpoint-driven room auto-handoff (P4).
 *
 * Posts visible `@nextWorker` system messages into the mission room when
 * advance marks follow-on stages ready. Spawn stays with advance →
 * dispatchNext — these messages are history/context only (`autoHandoff: true`
 * so the group-chat runner never treats them as @-driven turns).
 */
import { getSwarmMission } from '../swarm-missions'
import type { SwarmMissionAssignment } from '../swarm-missions'
import { ensureRoomForMission } from './ensure-room-for-mission'
import { insertMessage, listParticipants } from './room-store'
import type { MentionTarget, RoomMessage } from './types'

export type HandoffSummary = {
  result?: string | null
  nextAction?: string | null
  filesChanged?: string | null
  blocker?: string | null
}

function formatSummary(summary: HandoffSummary): string {
  const parts: Array<string> = []
  if (summary.result?.trim()) parts.push(summary.result.trim())
  if (summary.nextAction?.trim()) {
    parts.push(`Next: ${summary.nextAction.trim()}`)
  }
  if (summary.filesChanged?.trim()) {
    parts.push(`Files: ${summary.filesChanged.trim()}`)
  }
  if (summary.blocker?.trim()) {
    parts.push(`Blocker: ${summary.blocker.trim()}`)
  }
  return parts.length > 0 ? parts.join('\n') : '(no handoff summary)'
}

function mentionForWorker(
  roomId: string,
  workerId: string,
): { mentionName: string; mentions: Array<MentionTarget> } {
  const participants = listParticipants(roomId).filter((p) => !p.removedAt)
  const match = participants.find(
    (p) =>
      p.kind === 'agent' &&
      (p.participantId === workerId ||
        p.mentionName === workerId ||
        p.profile === workerId),
  )
  const mentionName = match?.mentionName || workerId
  return {
    mentionName,
    mentions: [{ type: 'agent', participantId: match?.participantId ?? workerId }],
  }
}

export async function postStageHandoff(input: {
  missionId: string
  fromWorkerId: string
  nextAssignments: Array<Pick<SwarmMissionAssignment, 'id' | 'workerId'>>
  handoffSummary?: HandoffSummary
}): Promise<Array<RoomMessage>> {
  if (input.nextAssignments.length === 0) return []

  const { room } = await ensureRoomForMission({ missionId: input.missionId })
  const body = formatSummary(input.handoffSummary ?? {})
  const posted: Array<RoomMessage> = []

  for (const next of input.nextAssignments) {
    const { mentionName, mentions } = mentionForWorker(room.id, next.workerId)
    const content = `@${mentionName} 上游已完成（来自 ${input.fromWorkerId}）：\n${body}`
    posted.push(
      insertMessage({
        roomId: room.id,
        senderKind: 'system',
        senderParticipantId: null,
        senderName: 'System',
        content,
        mentions,
        mentionDepth: 0,
        autoHandoff: true,
        taskId: input.missionId,
      }),
    )
  }

  return posted
}

export async function postPipelineComplete(input: {
  missionId: string
  summary?: string | null
}): Promise<RoomMessage | null> {
  const mission = getSwarmMission(input.missionId)
  if (!mission) return null

  const unfinished = mission.assignments.filter(
    (a) =>
      a.state !== 'done' &&
      a.state !== 'checkpointed' &&
      a.state !== 'cancelled',
  )
  if (unfinished.length > 0) return null

  const { room } = await ensureRoomForMission({ missionId: input.missionId })
  const detail = input.summary?.trim()
  const content = detail
    ? `流水线完成：${detail}`
    : '流水线完成：所有阶段已结束。'

  return insertMessage({
    roomId: room.id,
    senderKind: 'system',
    senderParticipantId: null,
    senderName: 'System',
    content,
    mentions: [],
    mentionDepth: 0,
    autoHandoff: true,
    taskId: input.missionId,
  })
}
