/**
 * Room store — CRUD for rooms, participants, messages, summaries, and
 * per-participant watermarks on top of collab.db.
 *
 * The schema is defined in src/server/collab-db.ts. This module adds typed
 * helpers and JSON parsing/serialization for the group-chat runner.
 */
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { ensureCollabDb, getCollabDbPath, createCollabId } from '../collab-db'
import { openSqliteDatabase } from '../sqlite-helper'
import { loadAgentsRegistry } from '../agent-runtime/agents-config'
import { coerceRoomRuntime, isManagedRoomRuntime } from './room-runtime'
import type {
  GroupMember,
  MentionTarget,
  PendingTurn,
  PendingTurnKind,
  PendingTurnStatus,
  Room,
  RoomMessage,
  RoomParticipant,
  RoomRuntime,
  RoomState,
  RoomSummary,
  RoomWatermark,
} from './types'

function now(): number {
  return Date.now()
}

/** Resolve the active collab.db path lazily so that runtime HERMES_HOME changes
 *  (e.g. profile directory set by the active gateway) are picked up. */
function defaultDbPath(): string {
  return getCollabDbPath()
}

function dbPath(input?: { dbPath?: string }): string {
  return input?.dbPath ?? defaultDbPath()
}

/** Create a fresh collab.db for tests and return its path. */
export function resetCollabDbForTests(): string {
  const path = `${tmpdir()}/collab-test-${randomUUID()}.db`
  ensureCollabDb(path)
  return path
}

function ensureDb(input?: { dbPath?: string }): void {
  ensureCollabDb(dbPath(input))
}

// ── JSON helpers ─────────────────────────────────────────────────────────

function parseMentions(value: unknown): Array<MentionTarget> {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as Array<MentionTarget>
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }
  if (Array.isArray(value)) return value as Array<MentionTarget>
  return []
}

function parseStringArray(value: unknown): Array<string> {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as Array<string>
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }
  if (Array.isArray(value)) return value as Array<string>
  return []
}

function toDbJson(value: unknown): string {
  return JSON.stringify(value)
}

// ── Rooms ────────────────────────────────────────────────────────────────

export function createRoom(input: {
  title: string
  ownerParticipantId?: string | null
  missionId?: string | null
  taskId?: string | null
  workspacePath?: string | null
  dbPath?: string
}): Room {
  ensureDb(input)
  const id = createCollabId('room')
  const ts = now()
  const room: Room = {
    id,
    title: input.title,
    state: 'active',
    taskId: input.taskId ?? null,
    missionId: input.missionId ?? null,
    workspacePath: input.workspacePath ?? null,
    ownerParticipantId: input.ownerParticipantId ?? null,
    createdAt: ts,
    updatedAt: ts,
  }
  const d = openSqliteDatabase(dbPath(input), false)
  try {
    d.prepare(
      `INSERT INTO rooms
       (id, title, state, task_id, mission_id, workspace_path, owner_participant_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      room.id,
      room.title,
      room.state,
      room.taskId,
      room.missionId,
      room.workspacePath,
      room.ownerParticipantId,
      room.createdAt,
      room.updatedAt,
    )
  } finally {
    d.close()
  }
  return room
}

export function getRoom(
  roomId: string,
  input?: { dbPath?: string },
): Room | null {
  ensureDb(input)
  const d = openSqliteDatabase(dbPath(input), true)
  try {
    const rows = d
      .prepare(
        `SELECT id, title, state, task_id, mission_id, workspace_path, owner_participant_id, created_at, updated_at
         FROM rooms WHERE id = ?`,
      )
      .all(roomId)
    if (rows.length === 0) return null
    return rowToRoom(rows[0])
  } finally {
    d.close()
  }
}

export function listRooms(input?: { dbPath?: string }): Array<Room> {
  ensureDb(input)
  const d = openSqliteDatabase(dbPath(input), true)
  try {
    const rows = d
      .prepare(
        `SELECT id, title, state, task_id, mission_id, workspace_path, owner_participant_id, created_at, updated_at
         FROM rooms ORDER BY updated_at DESC`,
      )
      .all()
    return rows.map((r) => rowToRoom(r))
  } finally {
    d.close()
  }
}

/** Most recently updated room bound to this mission, if any. */
export function findRoomByMissionId(
  missionId: string,
  input?: { dbPath?: string },
): Room | null {
  ensureDb(input)
  const d = openSqliteDatabase(dbPath(input), true)
  try {
    const rows = d
      .prepare(
        `SELECT id, title, state, task_id, mission_id, workspace_path, owner_participant_id, created_at, updated_at
         FROM rooms WHERE mission_id = ? ORDER BY updated_at DESC LIMIT 1`,
      )
      .all(missionId)
    if (rows.length === 0) return null
    return rowToRoom(rows[0])
  } finally {
    d.close()
  }
}

export function updateRoom(
  roomId: string,
  patch: Partial<Omit<Room, 'id' | 'createdAt'>>,
  input?: { dbPath?: string },
): Room | null {
  ensureDb(input)
  const allowed: Array<keyof Omit<Room, 'id' | 'createdAt'>> = [
    'title',
    'state',
    'taskId',
    'missionId',
    'workspacePath',
    'ownerParticipantId',
    'updatedAt',
  ]
  const sets: Array<string> = []
  const values: Array<unknown> = []
  for (const key of allowed) {
    if (key in patch) {
      sets.push(`${snakeCase(key)} = ?`)
      values.push(patch[key] ?? null)
    }
  }
  if (sets.length === 0) return getRoom(roomId, input)
  values.push(roomId)
  const d = openSqliteDatabase(dbPath(input), false)
  try {
    d.prepare(`UPDATE rooms SET ${sets.join(', ')} WHERE id = ?`).run(...values)
  } finally {
    d.close()
  }
  return getRoom(roomId, input)
}

export function deleteRoom(roomId: string, input?: { dbPath?: string }): void {
  ensureDb(input)
  const d = openSqliteDatabase(dbPath(input), false)
  try {
    d.prepare('DELETE FROM room_participants WHERE room_id = ?').run(roomId)
    d.prepare('DELETE FROM room_messages WHERE room_id = ?').run(roomId)
    d.prepare('DELETE FROM room_summaries WHERE room_id = ?').run(roomId)
    d.prepare('DELETE FROM room_watermarks WHERE room_id = ?').run(roomId)
    d.prepare('DELETE FROM pending_turns WHERE room_id = ?').run(roomId)
    try {
      d.prepare('DELETE FROM group_chat_sessions WHERE room_id = ?').run(roomId)
    } catch {
      // table may not exist yet in older DBs
    }
    d.prepare('DELETE FROM rooms WHERE id = ?').run(roomId)
  } finally {
    d.close()
  }
}

function rowToRoom(r: Record<string, unknown>): Room {
  return {
    id: String(r.id),
    title: String(r.title),
    state: String(r.state ?? 'active') as RoomState,
    taskId: r.task_id ? String(r.task_id) : null,
    missionId: r.mission_id ? String(r.mission_id) : null,
    workspacePath: r.workspace_path ? String(r.workspace_path) : null,
    ownerParticipantId: r.owner_participant_id
      ? String(r.owner_participant_id)
      : null,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  }
}

function snakeCase(value: string): string {
  return value.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
}

// ── Participants ─────────────────────────────────────────────────────────

export function addParticipant(input: {
  roomId: string
  kind: 'human' | 'agent'
  participantId: string
  displayName?: string
  mentionName?: string
  description?: string | null
  profile?: string | null
  runtime?: RoomRuntime
  isOwner?: boolean
  online?: boolean
  dbPath?: string
}): RoomParticipant {
  ensureDb(input)
  const displayName = input.displayName ?? input.participantId
  const mentionName =
    input.mentionName ?? displayName.toLowerCase().replace(/[^a-z0-9_-]+/g, '')
  const profile = input.profile ?? null

  // Revive a soft-removed row instead of inserting — UNIQUE(room_id, mention_name)
  // still covers removed rows, so a fresh INSERT would 500.
  const prior = getParticipantBySlug(input.roomId, input.participantId, {
    dbPath: input.dbPath,
    includeRemoved: true,
  })
  if (prior) {
    const ts = now()
    const d = openSqliteDatabase(dbPath(input), false)
    try {
      d.prepare(
        `UPDATE room_participants
         SET removed_at = 0, online = ?, display_name = ?, mention_name = ?,
             description = ?, profile = ?, runtime = ?, is_owner = ?, joined_at = ?
         WHERE id = ?`,
      ).run(
        (input.online ?? true) ? 1 : 0,
        displayName,
        mentionName,
        input.description ?? prior.description,
        profile ?? prior.profile,
        input.runtime ?? prior.runtime,
        (input.isOwner ?? prior.isOwner) ? 1 : 0,
        ts,
        prior.id,
      )
    } finally {
      d.close()
    }
    return {
      ...prior,
      displayName,
      mentionName,
      description: input.description ?? prior.description,
      profile: profile ?? prior.profile,
      runtime: input.runtime ?? prior.runtime,
      isOwner: input.isOwner ?? prior.isOwner,
      online: input.online ?? true,
      joinedAt: ts,
      removedAt: null,
    }
  }

  const id = createCollabId('part')
  const ts = now()
  const participant: RoomParticipant = {
    id,
    roomId: input.roomId,
    kind: input.kind,
    participantId: input.participantId,
    displayName,
    mentionName,
    description: input.description ?? null,
    profile,
    runtime: input.runtime ?? 'hermes',
    isOwner: input.isOwner ?? false,
    online: input.online ?? true,
    joinedAt: ts,
    removedAt: null,
  }
  const d = openSqliteDatabase(dbPath(input), false)
  try {
    d.prepare(
      `INSERT INTO room_participants
       (id, room_id, kind, participant_id, display_name, mention_name, description, profile, runtime, is_owner, online, joined_at, removed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      participant.id,
      participant.roomId,
      participant.kind,
      participant.participantId,
      participant.displayName,
      participant.mentionName,
      participant.description,
      participant.profile,
      participant.runtime,
      participant.isOwner ? 1 : 0,
      participant.online ? 1 : 0,
      participant.joinedAt,
      0,
    )
  } finally {
    d.close()
  }
  return participant
}

export function listParticipants(
  roomId: string,
  input?: { dbPath?: string; includeRemoved?: boolean },
): Array<RoomParticipant> {
  ensureDb(input)
  const d = openSqliteDatabase(dbPath(input), true)
  try {
    const sql = input?.includeRemoved
      ? `SELECT id, room_id, kind, participant_id, display_name, mention_name, description, profile, runtime, is_owner, online, joined_at, removed_at
         FROM room_participants WHERE room_id = ? ORDER BY joined_at`
      : `SELECT id, room_id, kind, participant_id, display_name, mention_name, description, profile, runtime, is_owner, online, joined_at, removed_at
         FROM room_participants WHERE room_id = ? AND (removed_at = 0 OR removed_at IS NULL) ORDER BY joined_at`
    const rows = d.prepare(sql).all(roomId)
    return rows.map((r) => rowToParticipant(r))
  } finally {
    d.close()
  }
}

export function getParticipant(
  participantRowId: string,
  input?: { dbPath?: string },
): RoomParticipant | null {
  ensureDb(input)
  const d = openSqliteDatabase(dbPath(input), true)
  try {
    const rows = d
      .prepare(
        `SELECT id, room_id, kind, participant_id, display_name, mention_name, description, profile, runtime, is_owner, online, joined_at, removed_at
         FROM room_participants WHERE id = ?`,
      )
      .all(participantRowId)
    if (rows.length === 0) return null
    return rowToParticipant(rows[0])
  } finally {
    d.close()
  }
}

/** Look up an active-or-removed participant by room + agent/human slug. */
export function getParticipantBySlug(
  roomId: string,
  participantId: string,
  input?: { dbPath?: string; includeRemoved?: boolean },
): RoomParticipant | null {
  ensureDb(input)
  const d = openSqliteDatabase(dbPath(input), true)
  try {
    const sql = input?.includeRemoved
      ? `SELECT id, room_id, kind, participant_id, display_name, mention_name, description, profile, runtime, is_owner, online, joined_at, removed_at
         FROM room_participants WHERE room_id = ? AND participant_id = ?
         ORDER BY joined_at DESC LIMIT 1`
      : `SELECT id, room_id, kind, participant_id, display_name, mention_name, description, profile, runtime, is_owner, online, joined_at, removed_at
         FROM room_participants WHERE room_id = ? AND participant_id = ?
         AND (removed_at = 0 OR removed_at IS NULL)
         ORDER BY joined_at DESC LIMIT 1`
    const rows = d.prepare(sql).all(roomId, participantId)
    if (rows.length === 0) return null
    return rowToParticipant(rows[0])
  } finally {
    d.close()
  }
}

export function findParticipantByMention(
  roomId: string,
  mentionName: string,
  input?: { dbPath?: string },
): RoomParticipant | null {
  ensureDb(input)
  const d = openSqliteDatabase(dbPath(input), true)
  try {
    const rows = d
      .prepare(
        `SELECT id, room_id, kind, participant_id, display_name, mention_name, description, profile, runtime, is_owner, online, joined_at, removed_at
         FROM room_participants WHERE room_id = ? AND mention_name = ? AND (removed_at = 0 OR removed_at IS NULL)`,
      )
      .all(roomId, mentionName.toLowerCase())
    if (rows.length === 0) return null
    return rowToParticipant(rows[0])
  } finally {
    d.close()
  }
}

/**
 * Soft-remove a participant. `participantId` is the agent/human slug
 * (room_participants.participant_id), NOT the row primary key.
 */
export function removeParticipant(
  roomId: string,
  participantId: string,
  input?: { dbPath?: string },
): RoomParticipant | null {
  ensureDb(input)
  const existing = getParticipantBySlug(roomId, participantId, {
    ...input,
    includeRemoved: false,
  })
  if (!existing) return null
  const d = openSqliteDatabase(dbPath(input), false)
  try {
    d.prepare(
      'UPDATE room_participants SET removed_at = ?, online = 0 WHERE room_id = ? AND participant_id = ? AND (removed_at = 0 OR removed_at IS NULL)',
    ).run(now(), roomId, participantId)
  } finally {
    d.close()
  }
  return { ...existing, removedAt: now(), online: false }
}

export function setParticipantOnline(
  participantId: string,
  online: boolean,
  input?: { dbPath?: string },
): void {
  ensureDb(input)
  const d = openSqliteDatabase(dbPath(input), false)
  try {
    d.prepare('UPDATE room_participants SET online = ? WHERE id = ?').run(
      online ? 1 : 0,
      participantId,
    )
  } finally {
    d.close()
  }
}

export function healParticipantFromRegistry(
  p: RoomParticipant,
  input?: { dbPath?: string },
): RoomParticipant {
  if (p.kind !== 'agent') return p
  // Read agents.yaml directly — avoid AgentRuntimeRouter (heavy adapters) and
  // Vite-SSR createRequire pitfalls that previously broke the group runner.
  const decl = loadAgentsRegistry().agents.find((a) => a.id === p.participantId)
  if (!decl) return p

  const fromDecl = coerceRoomRuntime(decl.runtime)
  if (!fromDecl || fromDecl === 'human') return p
  const runtime = fromDecl
  const profile = isManagedRoomRuntime(runtime)
    ? null
    : decl.profile?.trim() || p.profile || null

  if (runtime === p.runtime && profile === (p.profile ?? null)) {
    return p
  }

  ensureDb(input)
  const d = openSqliteDatabase(dbPath(input), false)
  try {
    d.prepare(
      `UPDATE room_participants SET runtime = ?, profile = ? WHERE id = ?`,
    ).run(runtime, profile, p.id)
  } finally {
    d.close()
  }
  console.log(
    `[room-store] healed participant ${p.participantId}: runtime ${p.runtime}→${runtime} profile ${p.profile ?? 'null'}→${profile ?? 'null'}`,
  )
  return { ...p, runtime, profile }
}

export function toGroupMember(p: RoomParticipant): GroupMember {
  return {
    id: p.id,
    participantId: p.participantId,
    displayName: p.displayName,
    mentionName: p.mentionName,
    name: p.displayName,
    runtime: p.runtime,
    kind: p.kind,
    isBot: p.kind === 'agent',
    profile: p.profile ?? null,
  }
}

/** Heal from agents.yaml then project to GroupMember (runner entry). */
export function toHealedGroupMember(
  p: RoomParticipant,
  input?: { dbPath?: string },
): GroupMember {
  return toGroupMember(healParticipantFromRegistry(p, input))
}

function rowToParticipant(r: Record<string, unknown>): RoomParticipant {
  return {
    id: String(r.id),
    roomId: String(r.room_id),
    kind: String(r.kind) as 'human' | 'agent',
    participantId: String(r.participant_id),
    displayName: String(r.display_name),
    mentionName: String(r.mention_name),
    description: r.description ? String(r.description) : null,
    profile: r.profile ? String(r.profile) : null,
    runtime: String(r.runtime) as RoomRuntime,
    isOwner: Number(r.is_owner) === 1,
    online: Number(r.online) === 1,
    joinedAt: Number(r.joined_at),
    removedAt: Number(r.removed_at) || null,
  }
}

// ── Messages ─────────────────────────────────────────────────────────────

export function insertMessage(input: {
  roomId: string
  senderKind: 'human' | 'agent' | 'system'
  senderParticipantId: string | null
  senderName: string
  content: string
  mentions?: Array<MentionTarget>
  mentionDepth?: number
  autoHandoff?: boolean
  taskRefs?: Array<string>
  answersPendingTurnId?: string | null
  runId?: string | null
  taskId?: string | null
  dbPath?: string
}): RoomMessage {
  ensureDb(input)
  const id = createCollabId('msg')
  const ts = now()
  const message: RoomMessage = {
    id,
    roomId: input.roomId,
    senderKind: input.senderKind,
    senderParticipantId: input.senderParticipantId ?? null,
    senderName: input.senderName,
    content: input.content,
    mentions: input.mentions ?? [],
    mentionDepth: input.mentionDepth ?? 0,
    autoHandoff: input.autoHandoff ?? false,
    taskRefs: input.taskRefs ?? [],
    answersPendingTurnId: input.answersPendingTurnId ?? null,
    runId: input.runId ?? null,
    taskId: input.taskId ?? null,
    createdAt: ts,
  }
  const d = openSqliteDatabase(dbPath(input), false)
  try {
    d.prepare(
      `INSERT INTO room_messages
       (id, room_id, sender_kind, sender_participant_id, sender_name, content, mentions, mention_depth, auto_handoff, task_refs, answers_pending_turn_id, run_id, task_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      message.id,
      message.roomId,
      message.senderKind,
      message.senderParticipantId,
      message.senderName,
      message.content,
      toDbJson(message.mentions),
      message.mentionDepth,
      message.autoHandoff ? 1 : 0,
      toDbJson(message.taskRefs),
      message.answersPendingTurnId,
      message.runId,
      message.taskId,
      message.createdAt,
    )
  } finally {
    d.close()
  }
  // Bump room updated_at so listRooms ordering stays fresh.
  touchRoom(input.roomId, input)
  return message
}

export function listMessages(
  roomId: string,
  input?: { dbPath?: string; limit?: number; before?: number },
): Array<RoomMessage> {
  ensureDb(input)
  const d = openSqliteDatabase(dbPath(input), true)
  try {
    let sql = `SELECT id, room_id, sender_kind, sender_participant_id, sender_name, content, mentions, mention_depth, auto_handoff, task_refs, answers_pending_turn_id, run_id, task_id, created_at
               FROM room_messages WHERE room_id = ?`
    const params: Array<unknown> = [roomId]
    if (input?.before) {
      sql += ' AND created_at < ?'
      params.push(input.before)
    }
    sql += ' ORDER BY created_at ASC'
    if (input?.limit) {
      sql += ' LIMIT ?'
      params.push(input.limit)
    }
    const rows = d.prepare(sql).all(...params)
    return rows.map((r) => rowToMessage(r))
  } finally {
    d.close()
  }
}

export function getLatestMessages(
  roomId: string,
  input?: { dbPath?: string; limit?: number },
): Array<RoomMessage> {
  ensureDb(input)
  const d = openSqliteDatabase(dbPath(input), true)
  try {
    const limit = input?.limit ?? 50
    const rows = d
      .prepare(
        `SELECT id, room_id, sender_kind, sender_participant_id, sender_name, content, mentions, mention_depth, auto_handoff, task_refs, answers_pending_turn_id, run_id, task_id, created_at
         FROM room_messages WHERE room_id = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(roomId, limit)
    return rows.reverse().map((r) => rowToMessage(r))
  } finally {
    d.close()
  }
}

export function getMessage(
  messageId: string,
  input?: { dbPath?: string },
): RoomMessage | null {
  ensureDb(input)
  const d = openSqliteDatabase(dbPath(input), true)
  try {
    const rows = d
      .prepare(
        `SELECT id, room_id, sender_kind, sender_participant_id, sender_name, content, mentions, mention_depth, auto_handoff, task_refs, answers_pending_turn_id, run_id, task_id, created_at
         FROM room_messages WHERE id = ?`,
      )
      .all(messageId)
    return rows.length > 0 ? rowToMessage(rows[0]) : null
  } finally {
    d.close()
  }
}

/** Content-only update for system-maintained card messages (e.g. managed
 *  interaction cards whose status is refreshed from canonical daemon reads). */
export function updateMessageContent(
  messageId: string,
  content: string,
  input?: { dbPath?: string },
): RoomMessage | null {
  ensureDb(input)
  const d = openSqliteDatabase(dbPath(input), false)
  try {
    d.prepare('UPDATE room_messages SET content = ? WHERE id = ?').run(
      content,
      messageId,
    )
  } finally {
    d.close()
  }
  return getMessage(messageId, input)
}

function rowToMessage(r: Record<string, unknown>): RoomMessage {
  return {
    id: String(r.id),
    roomId: String(r.room_id),
    senderKind: String(r.sender_kind) as 'human' | 'agent' | 'system',
    senderParticipantId: r.sender_participant_id
      ? String(r.sender_participant_id)
      : null,
    senderName: String(r.sender_name),
    content: String(r.content),
    mentions: parseMentions(r.mentions),
    mentionDepth: Number(r.mention_depth) || 0,
    autoHandoff: Number(r.auto_handoff) === 1,
    taskRefs: parseStringArray(r.task_refs),
    answersPendingTurnId: r.answers_pending_turn_id
      ? String(r.answers_pending_turn_id)
      : null,
    runId: r.run_id ? String(r.run_id) : null,
    taskId: r.task_id ? String(r.task_id) : null,
    createdAt: Number(r.created_at),
  }
}

function touchRoom(roomId: string, input?: { dbPath?: string }): void {
  const d = openSqliteDatabase(dbPath(input), false)
  try {
    d.prepare('UPDATE rooms SET updated_at = ? WHERE id = ?').run(now(), roomId)
  } finally {
    d.close()
  }
}

// ── Watermarks ───────────────────────────────────────────────────────────

export function getWatermark(
  roomId: string,
  participantId: string,
  input?: { dbPath?: string },
): number {
  ensureDb(input)
  const d = openSqliteDatabase(dbPath(input), true)
  try {
    const rows = d
      .prepare(
        'SELECT message_count FROM room_watermarks WHERE room_id = ? AND participant_id = ?',
      )
      .all(roomId, participantId)
    return rows.length > 0 ? Number(rows[0].message_count) : 0
  } finally {
    d.close()
  }
}

export function setWatermark(
  roomId: string,
  participantId: string,
  messageCount: number,
  input?: { dbPath?: string },
): void {
  ensureDb(input)
  const d = openSqliteDatabase(dbPath(input), false)
  try {
    const existing = d
      .prepare(
        'SELECT 1 FROM room_watermarks WHERE room_id = ? AND participant_id = ?',
      )
      .all(roomId, participantId)
    if (existing.length > 0) {
      d.prepare(
        'UPDATE room_watermarks SET message_count = ?, updated_at = ? WHERE room_id = ? AND participant_id = ?',
      ).run(messageCount, now(), roomId, participantId)
    } else {
      d.prepare(
        'INSERT INTO room_watermarks (room_id, participant_id, message_count, updated_at) VALUES (?, ?, ?, ?)',
      ).run(roomId, participantId, messageCount, now())
    }
  } finally {
    d.close()
  }
}

export function getAllWatermarks(
  roomId: string,
  input?: { dbPath?: string },
): Array<RoomWatermark> {
  ensureDb(input)
  const d = openSqliteDatabase(dbPath(input), true)
  try {
    const rows = d
      .prepare(
        'SELECT room_id, participant_id, message_count, updated_at FROM room_watermarks WHERE room_id = ?',
      )
      .all(roomId)
    return rows.map((r) => ({
      roomId: String(r.room_id),
      participantId: String(r.participant_id),
      messageCount: Number(r.message_count),
      updatedAt: Number(r.updated_at),
    }))
  } finally {
    d.close()
  }
}

// ── Summaries ────────────────────────────────────────────────────────────

export function getLatestSummary(
  roomId: string,
  input?: { dbPath?: string },
): RoomSummary | null {
  ensureDb(input)
  const d = openSqliteDatabase(dbPath(input), true)
  try {
    const rows = d
      .prepare(
        `SELECT room_id, summary, through_message_id, through_at, turn_count, version, updated_at
         FROM room_summaries WHERE room_id = ? ORDER BY updated_at DESC LIMIT 1`,
      )
      .all(roomId)
    if (rows.length === 0) return null
    const r = rows[0]
    return {
      roomId: String(r.room_id),
      content: String(r.summary ?? ''),
      throughMessageId: r.through_message_id
        ? String(r.through_message_id)
        : null,
      throughAt: Number(r.through_at),
      turnCount: Number(r.turn_count),
      version: Number(r.version),
      generatedAt: Number(r.updated_at),
    }
  } finally {
    d.close()
  }
}

export function saveSummary(
  roomId: string,
  content: string,
  throughMessageId: string | null,
  turnCount: number,
  input?: { dbPath?: string },
): RoomSummary {
  ensureDb(input)
  const ts = now()
  const latest = getLatestSummary(roomId, input)
  const version = (latest?.version ?? 0) + 1
  const summary: RoomSummary = {
    roomId,
    content,
    throughMessageId,
    throughAt: ts,
    turnCount,
    version,
    generatedAt: ts,
  }
  const d = openSqliteDatabase(dbPath(input), false)
  try {
    d.prepare(
      `INSERT INTO room_summaries
       (room_id, summary, through_message_id, through_at, turn_count, version, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(room_id) DO UPDATE SET
         summary = excluded.summary,
         through_message_id = excluded.through_message_id,
         through_at = excluded.through_at,
         turn_count = excluded.turn_count,
         version = excluded.version,
         updated_at = excluded.updated_at`,
    ).run(
      summary.roomId,
      summary.content,
      summary.throughMessageId,
      summary.throughAt,
      summary.turnCount,
      summary.version,
      summary.generatedAt,
    )
  } finally {
    d.close()
  }
  return summary
}

// ── Pending turns ────────────────────────────────────────────────────────

export function createPendingTurn(input: {
  roomId: string
  taskId?: string | null
  assignmentId?: string | null
  requestedBy: string
  targetParticipantId?: string | null
  messageId?: string | null
  kind: PendingTurnKind
  reason?: string | null
  options?: Array<{ id: string; label: string; replyText: string }> | null
  dbPath?: string
}): PendingTurn {
  ensureDb(input)
  const id = createCollabId('pt')
  const ts = now()
  const turn: PendingTurn = {
    id,
    roomId: input.roomId,
    taskId: input.taskId ?? null,
    assignmentId: input.assignmentId ?? null,
    requestedBy: input.requestedBy,
    targetParticipantId: input.targetParticipantId ?? null,
    messageId: input.messageId ?? null,
    kind: input.kind,
    reason: input.reason ?? null,
    options: input.options ?? null,
    status: 'pending',
    createdAt: ts,
    answeredAt: null,
    answeredMessageId: null,
  }
  const d = openSqliteDatabase(dbPath(input), false)
  try {
    d.prepare(
      `INSERT INTO pending_turns
       (id, room_id, task_id, assignment_id, requested_by, target_participant_id, message_id, kind, reason, options, status, created_at, answered_at, answered_message_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      turn.id,
      turn.roomId,
      turn.taskId,
      turn.assignmentId,
      turn.requestedBy,
      turn.targetParticipantId,
      turn.messageId,
      turn.kind,
      turn.reason,
      toDbJson(turn.options),
      turn.status,
      turn.createdAt,
      turn.answeredAt,
      turn.answeredMessageId,
    )
  } finally {
    d.close()
  }
  return turn
}

export function listPendingTurns(
  roomId: string,
  input?: { dbPath?: string; status?: PendingTurnStatus },
): Array<PendingTurn> {
  ensureDb(input)
  const d = openSqliteDatabase(dbPath(input), true)
  try {
    const sql = input?.status
      ? `SELECT id, room_id, task_id, assignment_id, requested_by, target_participant_id, message_id, kind, reason, options, status, created_at, answered_at, answered_message_id
         FROM pending_turns WHERE room_id = ? AND status = ? ORDER BY created_at DESC`
      : `SELECT id, room_id, task_id, assignment_id, requested_by, target_participant_id, message_id, kind, reason, options, status, created_at, answered_at, answered_message_id
         FROM pending_turns WHERE room_id = ? ORDER BY created_at DESC`
    const params = input?.status ? [roomId, input.status] : [roomId]
    const rows = d.prepare(sql).all(...params)
    return rows.map((r) => rowToPendingTurn(r))
  } finally {
    d.close()
  }
}

export function listAllPendingTurns(input?: {
  dbPath?: string
  status?: PendingTurnStatus
}): Array<PendingTurn> {
  ensureDb(input)
  const d = openSqliteDatabase(dbPath(input), true)
  try {
    const sql = input?.status
      ? `SELECT id, room_id, task_id, assignment_id, requested_by, target_participant_id, message_id, kind, reason, options, status, created_at, answered_at, answered_message_id
         FROM pending_turns WHERE status = ? ORDER BY created_at ASC`
      : `SELECT id, room_id, task_id, assignment_id, requested_by, target_participant_id, message_id, kind, reason, options, status, created_at, answered_at, answered_message_id
         FROM pending_turns ORDER BY created_at ASC`
    const rows = input?.status
      ? d.prepare(sql).all(input.status)
      : d.prepare(sql).all()
    return rows.map((r) => rowToPendingTurn(r))
  } finally {
    d.close()
  }
}

export function getPendingTurn(
  turnId: string,
  input?: { dbPath?: string },
): PendingTurn | null {
  ensureDb(input)
  const d = openSqliteDatabase(dbPath(input), true)
  try {
    const rows = d
      .prepare(
        `SELECT id, room_id, task_id, assignment_id, requested_by, target_participant_id, message_id, kind, reason, options, status, created_at, answered_at, answered_message_id
         FROM pending_turns WHERE id = ?`,
      )
      .all(turnId)
    if (rows.length === 0) return null
    return rowToPendingTurn(rows[0])
  } finally {
    d.close()
  }
}

export function answerPendingTurn(
  turnId: string,
  answer: { messageId: string },
  input?: { dbPath?: string },
): PendingTurn | null {
  ensureDb(input)
  const d = openSqliteDatabase(dbPath(input), false)
  try {
    d.prepare(
      `UPDATE pending_turns SET status = ?, answered_at = ?, answered_message_id = ? WHERE id = ?`,
    ).run('answered', now(), answer.messageId, turnId)
  } finally {
    d.close()
  }
  return getPendingTurn(turnId, input)
}

export function dismissPendingTurn(
  turnId: string,
  input?: { dbPath?: string },
): PendingTurn | null {
  ensureDb(input)
  const d = openSqliteDatabase(dbPath(input), false)
  try {
    d.prepare(
      `UPDATE pending_turns SET status = ?, answered_at = ? WHERE id = ?`,
    ).run('dismissed', now(), turnId)
  } finally {
    d.close()
  }
  return getPendingTurn(turnId, input)
}

export function expirePendingTurns(
  before: number,
  input?: { dbPath?: string },
): Array<PendingTurn> {
  ensureDb(input)
  const d = openSqliteDatabase(dbPath(input), false)
  try {
    const rows = d
      .prepare(
        `SELECT id, room_id, task_id, assignment_id, requested_by, target_participant_id, message_id, kind, reason, options, status, created_at, answered_at, answered_message_id
         FROM pending_turns WHERE status = 'pending' AND created_at < ?`,
      )
      .all(before)
    if (rows.length > 0) {
      d.prepare(
        `UPDATE pending_turns SET status = 'expired' WHERE status = 'pending' AND created_at < ?`,
      ).run(before)
    }
    return rows.map((r) => rowToPendingTurn(r))
  } finally {
    d.close()
  }
}

function rowToPendingTurn(r: Record<string, unknown>): PendingTurn {
  return {
    id: String(r.id),
    roomId: String(r.room_id),
    taskId: r.task_id ? String(r.task_id) : null,
    assignmentId: r.assignment_id ? String(r.assignment_id) : null,
    requestedBy: String(r.requested_by),
    targetParticipantId: r.target_participant_id
      ? String(r.target_participant_id)
      : null,
    messageId: r.message_id ? String(r.message_id) : null,
    kind: String(r.kind) as PendingTurnKind,
    reason: r.reason ? String(r.reason) : null,
    options: (() => {
      try {
        const parsed = JSON.parse(String(r.options))
        return Array.isArray(parsed) ? parsed : null
      } catch {
        return null
      }
    })(),
    status: String(r.status) as PendingTurnStatus,
    createdAt: Number(r.created_at),
    answeredAt: Number(r.answered_at) || null,
    answeredMessageId: r.answered_message_id
      ? String(r.answered_message_id)
      : null,
  }
}
