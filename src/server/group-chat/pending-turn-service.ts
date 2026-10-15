/**
 * Pending turn service — human gate for group chat.
 *
 * When an agent turn results in a blocking question or approval request, we
 * insert a pending_turn and pause the room. The user (or another authorized
 * human) can answer or dismiss it; the answer is recorded as a room message.
 *
 * This replaces upstream's clarify prompt mirroring with a workspace-native
 * pending_turn table.
 */
import { publishChatEvent } from '../chat-event-bus'
import { ensureRoomForMission } from './ensure-room-for-mission'
import {
  answerPendingTurn,
  createPendingTurn,
  dismissPendingTurn,
  getPendingTurn,
  getRoom,
  insertMessage,
  listAllPendingTurns,
  listParticipants,
  listPendingTurns,
  updateRoom,
} from './room-store'
import type {
  PendingTurn,
  PendingTurnKind,
  Room,
  RoomMessage,
} from './types'

export type HumanAnswerInput = {
  roomId: string
  turnId: string
  answerText: string
  answeredByParticipantId?: string
}

export type AttentionOption = {
  id: string
  label: string
  replyText: string
}

function attentionOptionsFromNextAction(
  nextAction?: string | null,
): Array<AttentionOption> | null {
  const trimmed = nextAction?.trim()
  if (!trimmed) {
    return [
      { id: 'continue', label: '继续', replyText: '继续' },
      { id: 'ack', label: '已知悉', replyText: '已知悉，请按当前方案继续。' },
    ]
  }
  return [
    { id: 'next', label: '按建议执行', replyText: trimmed },
    { id: 'continue', label: '继续', replyText: '继续' },
  ]
}

export async function requestHumanAttention(input: {
  room: Room
  requestedBy: string
  kind: PendingTurnKind
  reason: string
  messageId?: string | null
  options?: Array<AttentionOption> | null
  assignmentId?: string | null
  taskId?: string | null
  targetParticipantId?: string | null
}): Promise<PendingTurn> {
  // Dedup: same assignment (or same room+reason) already pending.
  const open = listPendingTurns(input.room.id, { status: 'pending' })
  const existing = open.find((turn) => {
    if (
      input.assignmentId &&
      turn.assignmentId &&
      turn.assignmentId === input.assignmentId
    ) {
      return true
    }
    return (
      !input.assignmentId &&
      turn.requestedBy === input.requestedBy &&
      turn.reason === input.reason
    )
  })
  if (existing) return existing

  const turn = createPendingTurn({
    roomId: input.room.id,
    requestedBy: input.requestedBy,
    kind: input.kind,
    reason: input.reason,
    messageId: input.messageId ?? null,
    options: input.options ?? null,
    assignmentId: input.assignmentId ?? null,
    taskId: input.taskId ?? null,
    targetParticipantId: input.targetParticipantId ?? null,
  })

  updateRoom(input.room.id, { state: 'needs_human' })

  publishChatEvent('group_chat_human_attention', {
    scope: 'global',
    roomId: input.room.id,
    pendingTurnId: turn.id,
    kind: turn.kind,
    reason: turn.reason,
    assignmentId: turn.assignmentId,
    taskId: turn.taskId,
    missionId: input.room.missionId,
  })

  return turn
}

/**
 * Ensure a mission room exists, post an @human notice, and open a pending turn.
 */
export async function openAttentionForMission(input: {
  missionId: string
  assignmentId?: string | null
  requestedBy: string
  kind: PendingTurnKind
  reason: string
  nextAction?: string | null
  options?: Array<AttentionOption> | null
}): Promise<PendingTurn> {
  const { room } = await ensureRoomForMission({ missionId: input.missionId })

  if (input.assignmentId) {
    const open = listPendingTurns(room.id, { status: 'pending' })
    const existing = open.find((t) => t.assignmentId === input.assignmentId)
    if (existing) return existing
  }

  const humans = listParticipants(room.id).filter(
    (p) => p.kind === 'human' && !p.removedAt,
  )
  const humanMention = humans[0]?.mentionName || 'human'
  const content = `@${humanMention} 需要人工介入（${input.kind}，来自 ${input.requestedBy}）：\n${input.reason}`

  const message = insertMessage({
    roomId: room.id,
    senderKind: 'system',
    senderParticipantId: null,
    senderName: 'System',
    content,
    mentions: humans.map((h) => ({
      type: 'human' as const,
      participantId: h.participantId,
    })),
    mentionDepth: 0,
    autoHandoff: false,
    taskId: input.missionId,
  })

  return requestHumanAttention({
    room,
    requestedBy: input.requestedBy,
    kind: input.kind,
    reason: input.reason,
    messageId: message.id,
    options:
      input.options ?? attentionOptionsFromNextAction(input.nextAction),
    assignmentId: input.assignmentId ?? null,
    taskId: input.missionId,
    targetParticipantId: humans[0]?.participantId ?? room.ownerParticipantId,
  })
}

/** Open attention for an existing room (e.g. agent @human in chat). */
export async function openAttentionForRoom(input: {
  roomId: string
  requestedBy: string
  kind: PendingTurnKind
  reason: string
  messageId?: string | null
  options?: Array<AttentionOption> | null
}): Promise<PendingTurn | null> {
  const room = getRoom(input.roomId)
  if (!room) return null
  return requestHumanAttention({
    room,
    requestedBy: input.requestedBy,
    kind: input.kind,
    reason: input.reason,
    messageId: input.messageId ?? null,
    options: input.options ?? attentionOptionsFromNextAction(null),
  })
}

export async function answerPendingTurnWithMessage(
  input: HumanAnswerInput,
): Promise<{ turn: PendingTurn; message: RoomMessage } | null> {
  const { roomId, turnId, answerText } = input
  const turn = getPendingTurn(turnId)
  if (!turn || turn.roomId !== roomId) return null

  const message = insertMessage({
    roomId,
    senderKind: 'human',
    senderParticipantId: input.answeredByParticipantId ?? null,
    senderName: 'User',
    content: answerText,
    answersPendingTurnId: turnId,
  })

  const updated = answerPendingTurn(turnId, { messageId: message.id })
  if (!updated) return null

  // Resume the room so the runner will pick up the human answer.
  updateRoom(roomId, { state: 'active' })

  publishChatEvent('group_chat_human_answered', {
    scope: 'global',
    roomId,
    turnId,
    messageId: message.id,
  })

  return { turn: updated, message }
}

export function dismissPendingTurnForRoom(
  roomId: string,
  turnId: string,
): PendingTurn | null {
  const turn = getPendingTurn(turnId)
  if (!turn || turn.roomId !== roomId) return null
  const updated = dismissPendingTurn(turnId)
  if (!updated) return null

  // If no more open pending turns, resume the room.
  const open = listPendingTurns(roomId, { status: 'pending' })
  if (open.length === 0) {
    updateRoom(roomId, { state: 'active' })
  }

  publishChatEvent('group_chat_human_dismissed', {
    scope: 'global',
    roomId,
    turnId,
  })

  return updated
}

export function listGlobalPendingTurns(input?: {
  status?: 'pending' | 'answered' | 'dismissed' | 'expired'
}): Array<PendingTurn & { missionId?: string | null }> {
  const turns = listAllPendingTurns({ status: input?.status ?? 'pending' })
  return turns.map((turn) => {
    const room = getRoom(turn.roomId)
    return { ...turn, missionId: room?.missionId ?? null }
  })
}
