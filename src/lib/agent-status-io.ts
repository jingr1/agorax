/**
 * Server-only agent presence I/O (FS + SQLite).
 *
 * Never import this from client/Vite bundles — it pulls `node:os` via
 * hermes-paths. Browser code must use `@/lib/agent-status` only.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { existsSync } from 'node:fs'
import { getHermesRoot, getProfilesDir } from '../server/hermes-paths'
import { getCollabDbPath } from '../server/collab-db'
import { openSqliteDatabase } from '../server/sqlite-helper'
import {
  deriveAgentPresence,
  type AgentPresence,
  type GroupChatActivity,
  type UnifiedAgentStatus,
} from './agent-status'

/** Avoid re-opening collab.db on every /api/agents poll (group-chat tick contention). */
const GROUP_CHAT_ACTIVITY_TTL_MS = 2_000
let groupChatActivityCache: {
  at: number
  value: Map<string, GroupChatActivity>
} | null = null

export function clearGroupChatActivityCache(): void {
  groupChatActivityCache = null
}

export function loadGroupChatActivity(): Map<string, GroupChatActivity> {
  if (
    groupChatActivityCache &&
    Date.now() - groupChatActivityCache.at < GROUP_CHAT_ACTIVITY_TTL_MS
  ) {
    return groupChatActivityCache.value
  }

  const dbPath = getCollabDbPath()
  if (!existsSync(dbPath)) {
    const empty = new Map<string, GroupChatActivity>()
    groupChatActivityCache = { at: Date.now(), value: empty }
    return empty
  }

  let db: ReturnType<typeof openSqliteDatabase> | null = null
  try {
    db = openSqliteDatabase(dbPath, true)
    const onlineRows = db
      .prepare(
        `SELECT participant_id, MAX(online) as online
         FROM room_participants
         WHERE removed_at = 0
         GROUP BY participant_id`,
      )
      .all() as Array<{ participant_id: string; online: number }>

    const messageRows = db
      .prepare(
        `SELECT sender_participant_id as participant_id, MAX(created_at) as last_message_at
         FROM room_messages
         GROUP BY sender_participant_id`,
      )
      .all() as Array<{ participant_id: string; last_message_at: number }>

    const activity = new Map<string, GroupChatActivity>()
    for (const row of onlineRows) {
      activity.set(row.participant_id, {
        online: Boolean(row.online),
        lastMessageAt: 0,
      })
    }
    for (const row of messageRows) {
      const existing = activity.get(row.participant_id)
      if (existing) {
        existing.lastMessageAt = Number(row.last_message_at)
      } else {
        activity.set(row.participant_id, {
          online: false,
          lastMessageAt: Number(row.last_message_at),
        })
      }
    }
    groupChatActivityCache = { at: Date.now(), value: activity }
    return activity
  } catch {
    // Prefer last-known presence over failing the agents list on SQLITE_BUSY.
    if (groupChatActivityCache) return groupChatActivityCache.value
    const empty = new Map<string, GroupChatActivity>()
    groupChatActivityCache = { at: Date.now(), value: empty }
    return empty
  } finally {
    try {
      db?.close()
    } catch {
      // ignore
    }
  }
}

function extractModelFromConfigYaml(text: string): string | undefined {
  const flat = /^model:\s*(\S.*)$/m.exec(text)
  if (flat) {
    const value = flat[1].trim()
    if (value && !value.startsWith('default:')) return value
  }
  const defaultMatch = /^model:[\s\S]*?^\s+default:\s*(.*)$/m.exec(text)
  if (defaultMatch) {
    const value = defaultMatch[1].trim()
    if (value) return value
  }
  return undefined
}

export function readProfileModel(profileName: string): string | undefined {
  const profileConfigPath = path.join(
    getProfilesDir(),
    profileName,
    'config.yaml',
  )

  if (fs.existsSync(profileConfigPath)) {
    try {
      const text = fs.readFileSync(profileConfigPath, 'utf8')
      const model = extractModelFromConfigYaml(text)
      if (model) return model
    } catch {
      // fall through to global fallback
    }
  }

  const globalConfigPath = path.join(getHermesRoot(), 'config.yaml')
  if (fs.existsSync(globalConfigPath)) {
    try {
      const text = fs.readFileSync(globalConfigPath, 'utf8')
      return extractModelFromConfigYaml(text)
    } catch {
      return undefined
    }
  }

  return undefined
}

export function profileHasModel(profileName?: string): boolean {
  if (!profileName) return false
  const model = readProfileModel(profileName)
  return Boolean(model && model.length > 0)
}

export function deriveAgentPresenceForAgent(
  agentId: string,
  snapshot:
    | {
        state?: string | null
        updatedAt?: number | null
        needsHuman?: boolean
        currentTask?: string | null
        missionId?: string | null
      }
    | null
    | undefined,
  probeAvailable: boolean,
  _groupChatMap: Map<string, GroupChatActivity>,
  profileName?: string,
): AgentPresence {
  const hasModel = profileHasModel(profileName ?? agentId)
  return deriveAgentPresence(
    {
      runtimeState: snapshot?.state,
      runtimeLastOutputAt: snapshot?.updatedAt,
      runtimeNeedsHuman: snapshot?.needsHuman,
      currentTask: snapshot?.currentTask,
      missionId: snapshot?.missionId,
      probeAvailable,
      hasModel,
    },
    Date.now(),
  )
}

/** @deprecated Prefer {@link deriveAgentPresenceForAgent}. */
export function deriveUnifiedStatusForAgent(
  agentId: string,
  snapshot:
    | { state?: string | null; updatedAt?: number | null; needsHuman?: boolean }
    | null
    | undefined,
  probeAvailable: boolean,
  groupChatMap: Map<string, GroupChatActivity>,
  profileName?: string,
): UnifiedAgentStatus {
  return deriveAgentPresenceForAgent(
    agentId,
    snapshot,
    probeAvailable,
    groupChatMap,
    profileName,
  ).unifiedStatus
}
