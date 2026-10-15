/**
 * Group chat API client for the UI.
 */
import type {
  MentionTarget,
  PendingTurn,
  Room,
  RoomMessage,
  RoomParticipant,
} from '@/server/group-chat/types'

export type CreateRoomRequest = {
  title: string
  missionId?: string | null
  taskId?: string | null
  workspacePath?: string | null
}

export type AddParticipantRequest = {
  participantId: string
  displayName?: string
  mentionName?: string
  profile?: string | null
  runtime?: string
  kind?: 'human' | 'agent'
}

export type SendMessageRequest = {
  content: string
  mentions?: Array<MentionTarget>
}

export type AnswerPendingTurnRequest = {
  answerText: string
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Group chat API ${path}: ${res.status} ${text}`)
  }
  return res.json() as Promise<T>
}

export function listRooms(): Promise<{ ok: boolean; rooms: Array<Room> }> {
  return apiFetch('/api/rooms')
}

export function createRoom(
  req: CreateRoomRequest,
): Promise<{ ok: boolean; room: Room }> {
  return apiFetch('/api/rooms', {
    method: 'POST',
    body: JSON.stringify(req),
  })
}

export function createRoomFromMission(
  missionId: string,
): Promise<{ ok: boolean; room: Room; created: boolean }> {
  return apiFetch('/api/rooms/from-mission', {
    method: 'POST',
    body: JSON.stringify({ missionId }),
  })
}

export function getRoom(roomId: string): Promise<{ ok: boolean; room: Room }> {
  return apiFetch(`/api/rooms/${roomId}`)
}

export function deleteRoom(roomId: string): Promise<{ ok: boolean }> {
  return apiFetch(`/api/rooms/${roomId}`, { method: 'DELETE' })
}

export function updateRoom(
  roomId: string,
  patch: Record<string, unknown>,
): Promise<{ ok: boolean; room: Room }> {
  return apiFetch(`/api/rooms/${roomId}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

export function listMessages(
  roomId: string,
): Promise<{ ok: boolean; room: Room; messages: Array<RoomMessage> }> {
  return apiFetch(`/api/rooms/${roomId}/messages`)
}

export function sendMessage(
  roomId: string,
  req: SendMessageRequest,
): Promise<{ ok: boolean; room: Room; message: RoomMessage }> {
  return apiFetch(`/api/rooms/${roomId}/messages`, {
    method: 'POST',
    body: JSON.stringify(req),
  })
}

export function listParticipants(
  roomId: string,
): Promise<{ ok: boolean; room: Room; participants: Array<RoomParticipant> }> {
  return apiFetch(`/api/rooms/${roomId}/participants`)
}

export function addParticipant(
  roomId: string,
  req: AddParticipantRequest,
): Promise<{ ok: boolean; room: Room; participant: RoomParticipant }> {
  return apiFetch(`/api/rooms/${roomId}/participants`, {
    method: 'POST',
    body: JSON.stringify(req),
  })
}

export function removeParticipant(
  roomId: string,
  participantId: string,
): Promise<{ ok: boolean }> {
  return apiFetch(`/api/rooms/${roomId}/participants/${participantId}`, {
    method: 'DELETE',
  })
}

export function listPendingTurns(
  roomId: string,
): Promise<{ ok: boolean; room: Room; pendingTurns: Array<PendingTurn> }> {
  return apiFetch(`/api/rooms/${roomId}/pending-turns`)
}

export function listGlobalPendingTurns(
  status: 'pending' | 'answered' | 'dismissed' | 'expired' = 'pending',
): Promise<{
  ok: boolean
  pendingTurns: Array<PendingTurn & { missionId?: string | null }>
}> {
  return apiFetch(`/api/pending-turns?status=${status}`)
}

export function answerGlobalPendingTurn(
  turnId: string,
  req: AnswerPendingTurnRequest & { optionId?: string },
): Promise<{ ok: boolean; turn: PendingTurn; message: RoomMessage }> {
  return apiFetch(`/api/pending-turns/${turnId}/answer`, {
    method: 'POST',
    body: JSON.stringify(req),
  })
}

export function dismissGlobalPendingTurn(
  turnId: string,
): Promise<{ ok: boolean; turn: PendingTurn }> {
  return apiFetch(`/api/pending-turns/${turnId}/dismiss`, {
    method: 'POST',
  })
}

export function answerPendingTurn(
  roomId: string,
  turnId: string,
  req: AnswerPendingTurnRequest,
): Promise<{ ok: boolean; turn: PendingTurn; message: RoomMessage }> {
  return apiFetch(`/api/rooms/${roomId}/pending-turns/${turnId}/answer`, {
    method: 'POST',
    body: JSON.stringify(req),
  })
}

export function dismissPendingTurn(
  roomId: string,
  turnId: string,
): Promise<{ ok: boolean; turn: PendingTurn }> {
  return apiFetch(`/api/rooms/${roomId}/pending-turns/${turnId}/dismiss`, {
    method: 'POST',
  })
}

export type RespondToManagedInteractionRequest = {
  action?: string
  optionId?: string
  payload?: Record<string, unknown>
}

/** Writeback for a managed-agent interaction card posted in a room. */
export function respondToManagedInteraction(
  roomId: string,
  messageId: string,
  req: RespondToManagedInteractionRequest,
): Promise<{ ok: boolean; status?: string; error?: string }> {
  return apiFetch(
    `/api/rooms/${roomId}/messages/${messageId}/interaction-response`,
    {
      method: 'POST',
      body: JSON.stringify(req),
    },
  )
}

export function listAvailableAgents(): Promise<{
  ok: boolean
  agents: Array<{
    id: string
    runtime: string
    displayName: string
    mentionName: string
    capabilities: Array<string>
  }>
}> {
  return apiFetch('/api/available-agents')
}
