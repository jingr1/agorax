/**
 * Canonical session manager for group-chat participants.
 *
 * Each bot participant in a room gets one persistent "Bot Chat" session on its
 * OWN profile gateway. We create it lazily, cache the session id by
 * (roomId, participantId), and resume it on subsequent turns.
 *
 * This module intentionally does NOT use the global hermes-api singleton,
 * because that singleton points at the workspace's current active gateway,
 * which may be a different profile than the participant's. Instead it builds a
 * per-profile client via hermes-api-profile and routes every session operation
 * through that client's gateway.
 */
import {
  getHermesApiClient,
  type HermesApiClient,
  type HermesMessage,
} from '../hermes-api-profile'
import {
  createSession as globalCreateSession,
  getMessages as globalGetMessages,
  sendChat as globalSendChat,
} from '../hermes-api'
import { getCollabDbPath } from '../collab-db'
import { ensureProfileGateway } from '../gateway-pool'
import { openSqliteDatabase } from '../sqlite-helper'
import type { GroupMember } from './types'

const SESSION_KEY_PREFIX = 'group-chat-session'

function sessionCacheKey(roomId: string, participantId: string): string {
  return `${SESSION_KEY_PREFIX}:${roomId}:${participantId}`
}

/** In-memory cache (HMR-safe via globalThis). */
function getCache(): Map<string, string> {
  const g = globalThis as Record<string, unknown>
  const key = '__group_chat_session_cache__'
  if (!g[key]) {
    g[key] = new Map<string, string>()
  }
  return g[key] as Map<string, string>
}

/** Persist the mapping to a tiny SQLite table for crash recovery. */
function ensureSessionTable(databasePath: string): void {
  const db = openSqliteDatabase(databasePath, false)
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS group_chat_sessions (
        room_id TEXT NOT NULL,
        participant_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        profile TEXT,
        updated_at INTEGER,
        PRIMARY KEY (room_id, participant_id)
      );
    `)
    // Migrate older tables that were created before the profile column existed.
    const columns = db
      .prepare('PRAGMA table_info(group_chat_sessions)')
      .all() as Array<{ name: string }>
    const hasProfile = columns.some((c) => c.name === 'profile')
    if (!hasProfile) {
      db.exec('ALTER TABLE group_chat_sessions ADD COLUMN profile TEXT')
    }
  } finally {
    db.close()
  }
}

function dbPath(input?: { dbPath?: string }): string {
  return input?.dbPath ?? getCollabDbPath()
}

/** Canonical deterministic title for a member's group session.
 *  Mirrors Desktop's `Group: ${roomId}` but scopes uniqueness per participant
 *  because workspace runs all agents on the same gateway, which rejects
 *  duplicate titles globally. */
export function groupSessionTitle(
  roomId: string,
  participantId: string,
): string {
  return `Group: ${roomId}:${participantId}`
}

/** Resolve the profile that owns a member's runtime session.
 *  - Non-Hermes runtimes never use a Hermes profile gateway (ignore any
 *    stale `profile` column — e.g. claude-code rows that stored agent id).
 *  - Hermes: prefer explicit profile metadata, else participantId.
 */
function resolveMemberProfile(member: GroupMember): string | null {
  if (member.runtime !== 'hermes') return null
  const explicit = member.profile?.trim()
  if (explicit) return explicit
  return member.participantId
}

/** Runtimes that must not open Hermes gateway sessions. */
function isHermesGatewayRuntime(runtime: GroupMember['runtime']): boolean {
  return runtime === 'hermes'
}

/** Pick the client surface for a member: per-profile when possible, global
 *  fallback for non-Hermes runtimes. */
function clientForMember(member: GroupMember): HermesApiClient | null {
  const profile = resolveMemberProfile(member)
  if (profile) return getHermesApiClient(profile)
  return null
}

export function rememberSession(
  roomId: string,
  participantId: string,
  sessionId: string,
  member: GroupMember,
  input?: { dbPath?: string },
): void {
  const path = dbPath(input)
  ensureSessionTable(path)
  getCache().set(sessionCacheKey(roomId, participantId), sessionId)
  const profile = resolveMemberProfile(member)
  const db = openSqliteDatabase(path, false)
  try {
    db.prepare(
      `INSERT INTO group_chat_sessions (room_id, participant_id, session_id, profile, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(room_id, participant_id) DO UPDATE SET
         session_id = excluded.session_id,
         profile = excluded.profile,
         updated_at = excluded.updated_at`,
    ).run(roomId, participantId, sessionId, profile, Date.now())
  } finally {
    db.close()
  }
}

export function forgetSession(roomId: string, participantId: string): void {
  getCache().delete(sessionCacheKey(roomId, participantId))
  const path = dbPath()
  ensureSessionTable(path)
  const db = openSqliteDatabase(path, false)
  try {
    db.prepare(
      'DELETE FROM group_chat_sessions WHERE room_id = ? AND participant_id = ?',
    ).run(roomId, participantId)
  } finally {
    db.close()
  }
}

/** Read a previously mapped session id without creating one. */
export function peekSession(
  roomId: string,
  participantId: string,
  input?: { dbPath?: string },
): string | null {
  const cacheKey = sessionCacheKey(roomId, participantId)
  const cached = getCache().get(cacheKey)
  if (cached) return cached
  const path = dbPath(input)
  ensureSessionTable(path)
  const db = openSqliteDatabase(path, true)
  try {
    const rows = db
      .prepare(
        'SELECT session_id FROM group_chat_sessions WHERE room_id = ? AND participant_id = ?',
      )
      .all(roomId, participantId)
    if (rows.length === 0) return null
    const sessionId = String(rows[0].session_id)
    getCache().set(cacheKey, sessionId)
    return sessionId
  } finally {
    db.close()
  }
}

/** Load transcript for a member's group session (empty if unmapped). */
export async function getMemberSessionMessages(
  roomId: string,
  member: GroupMember,
  input?: { dbPath?: string },
): Promise<{ sessionId: string | null; messages: Array<HermesMessage> }> {
  const sessionId = peekSession(roomId, member.participantId, input)
  if (!sessionId) return { sessionId: null, messages: [] }
  const client = clientForMember(member)
  try {
    const messages = client
      ? await client.getMessages(sessionId)
      : await globalGetMessages(sessionId)
    return { sessionId, messages }
  } catch (error) {
    console.warn(
      `[agent-session-manager] getMessages failed for ${member.displayName}:`,
      error instanceof Error ? error.message : String(error),
    )
    return { sessionId, messages: [] }
  }
}

/** Result of verifying a stored session id. */
type SessionCheckResult =
  | { kind: 'ok'; sessionId: string }
  | { kind: 'missing' }
  | { kind: 'error'; error: Error }

/** Verify a stored session id against the member's own gateway.
 *  Fail closed on transient errors: only a 404-style "not found" means the
 *  session is genuinely gone.
 *
 *  Retire sessions that carry any persisted model override. Hermes api_server
 *  then fails chat/stream with "No LLM provider configured" under
 *  route_source=global — even when has_model_config is false but session.model
 *  is set (observed on group sessions created while model was being pinned). */
async function checkStoredSession(
  member: GroupMember,
  sessionId: string,
): Promise<SessionCheckResult> {
  const client = clientForMember(member)
  if (!client) {
    // Non-Hermes runtime: use global client for verification.
    try {
      await globalGetMessages(sessionId)
      return { kind: 'ok', sessionId }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      if (
        /\b404\b|Not found|not found|invalid session|session not found/i.test(
          msg,
        )
      ) {
        return { kind: 'missing' }
      }
      return {
        kind: 'error',
        error: error instanceof Error ? error : new Error(String(error)),
      }
    }
  }

  try {
    if (client.getSession) {
      const session = await client.getSession(sessionId)
      const pinnedModel =
        typeof session.model === 'string' && session.model.trim().length > 0
      if (session.has_model_config || pinnedModel) {
        console.warn(
          `[agent-session-manager] retiring poisoned session ${sessionId} (has_model_config=${Boolean(session.has_model_config)} model=${session.model ?? 'n/a'}) for ${member.displayName}`,
        )
        await client.deleteSession(sessionId).catch(() => undefined)
        return { kind: 'missing' }
      }
    } else {
      await client.getMessages(sessionId)
    }
    return { kind: 'ok', sessionId }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    if (
      /\b404\b|Not found|not found|invalid session|session not found/i.test(msg)
    ) {
      return { kind: 'missing' }
    }
    return {
      kind: 'error',
      error: error instanceof Error ? error : new Error(String(error)),
    }
  }
}

export async function getOrCreateSession(
  roomId: string,
  member: GroupMember,
  input?: { dbPath?: string; title?: string },
): Promise<{ sessionId: string; existed: boolean; profile: string | null }> {
  // Managed adapters (claude-code / codex / …) never open Hermes gateway sessions.
  if (!isHermesGatewayRuntime(member.runtime)) {
    throw new Error(
      `Group chat Hermes sessions do not support runtime=${member.runtime} (member=${member.displayName}). Remove this participant or use a Hermes agent.`,
    )
  }

  const cacheKey = sessionCacheKey(roomId, member.participantId)
  const title = input?.title ?? groupSessionTitle(roomId, member.participantId)
  const profile = resolveMemberProfile(member)

  // Bring the member's gateway up BEFORE verifying a stored session. Otherwise
  // a temporarily-down profile port (e.g. developer:8644) fails closed with
  // "fetch failed" and the runner never gets a chance to spawn it.
  if (profile) {
    await ensureProfileGateway(profile).catch((error) => {
      console.warn(
        `[agent-session-manager] could not ensure gateway for ${profile}:`,
        error instanceof Error ? error.message : String(error),
      )
    })
  }

  // 1. Try in-memory cache first.
  let cached = getCache().get(cacheKey)

  // 2. Try persisted mapping.
  if (!cached) {
    const path = dbPath(input)
    ensureSessionTable(path)
    const db = openSqliteDatabase(path, true)
    try {
      const rows = db
        .prepare(
          'SELECT session_id, profile FROM group_chat_sessions WHERE room_id = ? AND participant_id = ?',
        )
        .all(roomId, member.participantId)
        if (rows.length > 0) {
        cached = String(rows[0].session_id)
        const storedProfile = rows[0].profile ? String(rows[0].profile) : null
        // Only hydrate Hermes profile onto hermes members — never promote a
        // stale profile string onto claude-code / codex participants.
        if (
          storedProfile &&
          !member.profile &&
          member.runtime === 'hermes'
        ) {
          ;(member as { profile: string | null }).profile = storedProfile
        }
      }
    } finally {
      db.close()
    }
  }

  // 3. If we have a stored session id, verify it still exists on the right gateway.
  if (cached) {
    const check = await checkStoredSession(member, cached)
    if (check.kind === 'ok') {
      getCache().set(cacheKey, check.sessionId)
      return { sessionId: check.sessionId, existed: true, profile }
    }
    if (check.kind === 'error') {
      throw new Error(
        `Could not verify ${member.name}'s group session (${check.error.message}) — not starting a new one`,
      )
    }
    // missing -> fall through to create
    getCache().delete(cacheKey)
  }

  // 4. Create a new session on the member's own gateway. The deterministic title
  //    already encodes room+member, so duplicate-title collisions should only
  //    happen if a previous session was orphaned. Retry once with a timestamp
  //    nonce on that specific error.
  const client = clientForMember(member)
  try {
    console.log(
      `[agent-session-manager] createSession member=${member.displayName} profile=${profile ?? 'n/a'} client=${client ? client.baseUrl : 'global'} model=(profile default)`,
    )
    // Do NOT pass model/provider here. Persisting a session model causes Hermes
    // api_server to prefer session_row_model on later turns and skip global
    // provider resolution — which currently mis-routes to DeepSeek when a
    // placeholder DEEPSEEK_API_KEY is present. Create a bare session and let
    // each turn use profile config.yaml defaults (route_source=global).
    const session = client
      ? await client.createSession({ title })
      : await globalCreateSession({ title })
    console.log(
      `[agent-session-manager] created sessionId=${session.id} model=${session.model ?? 'n/a'} for member=${member.displayName} profile=${profile ?? 'n/a'}`,
    )
    const sessionId = session.id
    rememberSession(roomId, member.participantId, sessionId, member, input)
    return { sessionId, existed: false, profile }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    if (msg.includes('Title already in use')) {
      const fallbackTitle = `${title} ${Date.now()}`
      const session = client
        ? await client.createSession({ title: fallbackTitle })
        : await globalCreateSession({ title: fallbackTitle })
      const sessionId = session.id
      rememberSession(roomId, member.participantId, sessionId, member, input)
      return { sessionId, existed: false, profile }
    }
    throw error
  }
}

export async function submitPrompt(
  roomId: string,
  member: GroupMember,
  prompt: string,
  input?: {
    dbPath?: string
    title?: string
    model?: string
    provider?: string
  },
): Promise<{
  sessionId: string
  message?: HermesMessage
  profile: string | null
}> {
  const { sessionId, profile } = await getOrCreateSession(roomId, member, input)
  const client = clientForMember(member)
  // Only forward an explicit caller override. Otherwise omit model/provider so
  // the gateway uses profile config defaults.
  const model = input?.model
  const provider = input?.provider
  const result = client
    ? await client.sendChat(sessionId, {
        message: prompt,
        ...(model ? { model } : {}),
        ...(provider ? { provider } : {}),
      })
    : await globalSendChat(sessionId, {
        message: prompt,
        ...(model ? { model } : {}),
      })
  const message = extractAssistantMessage(result, sessionId)
  return { sessionId, message, profile }
}

function extractAssistantMessage(
  result: Record<string, unknown>,
  sessionId: string,
): HermesMessage | undefined {
  const messages = Array.isArray(result.messages)
    ? (result.messages as Array<Record<string, unknown>>)
    : []
  const lastAssistant = [...messages]
    .reverse()
    .find((m) => String(m.role) === 'assistant')
  if (!lastAssistant) return undefined
  return {
    id: Number(lastAssistant.id) || 0,
    session_id: sessionId,
    role: 'assistant',
    content: String(lastAssistant.content ?? ''),
    timestamp: Number(lastAssistant.timestamp) || Date.now(),
  }
}

export function clearSessionCache(): void {
  getCache().clear()
}
