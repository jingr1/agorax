import type { ChatAttachment, ChatMessage } from './types'

export type PendingSendPayload = {
  sessionKey: string
  friendlyId: string
  message: string
  attachments: Array<ChatAttachment>
  optimisticMessage: ChatMessage
}

let pendingSend: PendingSendPayload | null = null
/** Session-scoped: keys are `s:<sessionKey>` and/or `f:<friendlyId>`. */
const pendingGenerationKeys = new Set<string>()
let recentSession: { friendlyId: string; at: number } | null = null

export type PendingSessionIdentity = {
  sessionKey?: string | null
  friendlyId?: string | null
}

function pendingGenerationKeyList(
  identity: PendingSessionIdentity | null | undefined,
): Array<string> {
  if (!identity) return []
  const keys: Array<string> = []
  const sessionKey = identity.sessionKey?.trim()
  const friendlyId = identity.friendlyId?.trim()
  if (sessionKey) keys.push(`s:${sessionKey}`)
  if (friendlyId) keys.push(`f:${friendlyId}`)
  return keys
}

const PENDING_MESSAGE_STORAGE_PREFIX = 'claude_pending_msg_'
const PENDING_MESSAGE_MAX_AGE_MS = 5 * 60 * 1000

type PersistedPendingSendPayload = PendingSendPayload & {
  storedAt: number
}

function canUseLocalStorage() {
  return (
    typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'
  )
}

function getPendingStorageKey(sessionKey: string) {
  return `${PENDING_MESSAGE_STORAGE_PREFIX}${sessionKey || 'main'}`
}

function isExpiredPendingPayload(payload: { storedAt?: unknown }) {
  if (
    typeof payload.storedAt !== 'number' ||
    !Number.isFinite(payload.storedAt)
  ) {
    return true
  }
  return Date.now() - payload.storedAt > PENDING_MESSAGE_MAX_AGE_MS
}

function toPendingSendPayload(
  parsed: Record<string, unknown>,
): PendingSendPayload | null {
  const optimisticMessage = parsed.optimisticMessage
  if (
    typeof parsed.sessionKey !== 'string' ||
    typeof parsed.friendlyId !== 'string' ||
    typeof parsed.message !== 'string' ||
    !optimisticMessage ||
    typeof optimisticMessage !== 'object'
  ) {
    return null
  }

  return {
    sessionKey: parsed.sessionKey,
    friendlyId: parsed.friendlyId,
    message: parsed.message,
    attachments: Array.isArray(parsed.attachments) ? parsed.attachments : [],
    optimisticMessage: optimisticMessage as ChatMessage,
  }
}

function writePendingSendToStorage(payload: PendingSendPayload) {
  if (!canUseLocalStorage()) return

  cleanupExpiredPendingSends()

  const record: PersistedPendingSendPayload = {
    ...payload,
    storedAt: Date.now(),
  }

  try {
    window.localStorage.setItem(
      getPendingStorageKey(payload.sessionKey),
      JSON.stringify(record),
    )
  } catch {
    // Ignore storage write failures.
  }
}

function readPendingSendFromStorageByFriendlyId(
  friendlyId: string,
): PendingSendPayload | null {
  if (!canUseLocalStorage() || !friendlyId) return null

  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index)
      if (!key?.startsWith(PENDING_MESSAGE_STORAGE_PREFIX)) continue
      const raw = window.localStorage.getItem(key)
      if (!raw) continue
      try {
        const parsed = JSON.parse(raw) as PersistedPendingSendPayload
        if (isExpiredPendingPayload(parsed)) {
          window.localStorage.removeItem(key)
          continue
        }
        if (parsed.friendlyId !== friendlyId) continue
        return toPendingSendPayload(parsed)
      } catch {
        window.localStorage.removeItem(key)
      }
    }
  } catch {
    // Ignore storage read failures.
  }

  return null
}

function removePendingSendFromStorageByFriendlyId(friendlyId: string) {
  if (!canUseLocalStorage() || !friendlyId) return

  try {
    const keysToDelete: Array<string> = []
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index)
      if (!key?.startsWith(PENDING_MESSAGE_STORAGE_PREFIX)) continue
      const raw = window.localStorage.getItem(key)
      if (!raw) continue
      try {
        const parsed = JSON.parse(raw) as PersistedPendingSendPayload
        if (parsed.friendlyId === friendlyId) {
          keysToDelete.push(key)
        }
      } catch {
        keysToDelete.push(key)
      }
    }
    for (const key of keysToDelete) {
      window.localStorage.removeItem(key)
    }
  } catch {
    // Ignore storage cleanup failures.
  }
}

export function cleanupExpiredPendingSends() {
  if (!canUseLocalStorage()) return

  try {
    const keysToDelete: Array<string> = []
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index)
      if (!key?.startsWith(PENDING_MESSAGE_STORAGE_PREFIX)) continue
      const raw = window.localStorage.getItem(key)
      if (!raw) {
        keysToDelete.push(key)
        continue
      }
      try {
        const parsed = JSON.parse(raw) as PersistedPendingSendPayload
        if (isExpiredPendingPayload(parsed)) {
          keysToDelete.push(key)
        }
      } catch {
        keysToDelete.push(key)
      }
    }
    for (const key of keysToDelete) {
      window.localStorage.removeItem(key)
    }
  } catch {
    // Ignore storage cleanup failures.
  }
}

export function persistPendingMessage(payload: PendingSendPayload) {
  writePendingSendToStorage(payload)
}

export function readPendingMessage(
  sessionKey: string,
  friendlyId?: string,
): PendingSendPayload | null {
  if (!canUseLocalStorage() || !sessionKey) return null

  cleanupExpiredPendingSends()

  try {
    const raw = window.localStorage.getItem(getPendingStorageKey(sessionKey))
    if (!raw) {
      return friendlyId
        ? readPendingSendFromStorageByFriendlyId(friendlyId)
        : null
    }
    const parsed = JSON.parse(raw) as PersistedPendingSendPayload
    if (isExpiredPendingPayload(parsed)) {
      window.localStorage.removeItem(getPendingStorageKey(sessionKey))
      return null
    }
    if (friendlyId && parsed.friendlyId !== friendlyId) {
      return readPendingSendFromStorageByFriendlyId(friendlyId)
    }
    return toPendingSendPayload(parsed)
  } catch {
    try {
      window.localStorage.removeItem(getPendingStorageKey(sessionKey))
    } catch {
      // Ignore storage cleanup failures.
    }
    return null
  }
}

export function clearPendingMessage(sessionKey: string) {
  if (!canUseLocalStorage() || !sessionKey) return
  try {
    window.localStorage.removeItem(getPendingStorageKey(sessionKey))
  } catch {
    // Ignore storage cleanup failures.
  }
}

export function stashPendingSend(payload: PendingSendPayload) {
  pendingSend = payload
  writePendingSendToStorage(payload)
}

export function hasPendingSend() {
  return pendingSend !== null
}

export function hasPendingSendForSession(
  identity: PendingSessionIdentity,
): boolean {
  if (!pendingSend) return false
  const sessionKey = identity.sessionKey?.trim()
  const friendlyId = identity.friendlyId?.trim()
  if (sessionKey && pendingSend.sessionKey === sessionKey) return true
  if (friendlyId && pendingSend.friendlyId === friendlyId) return true
  return false
}

/**
 * Mark (or clear) in-flight generation for a specific session identity.
 * Never global — a dirty prior session must not light busy UI on another.
 */
export function setPendingGeneration(
  value: boolean,
  identity: PendingSessionIdentity | null | undefined,
) {
  const keys = pendingGenerationKeyList(identity)
  // No identity → no-op (never throw; never write a process-global flag).
  if (keys.length === 0) return
  if (value) {
    for (const key of keys) pendingGenerationKeys.add(key)
    return
  }
  for (const key of keys) pendingGenerationKeys.delete(key)
}

/** True when this session (or any, if identity omitted for list synthesis) is pending. */
export function hasPendingGeneration(
  identity?: PendingSessionIdentity | null,
): boolean {
  if (identity == null) return pendingGenerationKeys.size > 0
  const keys = pendingGenerationKeyList(identity)
  if (keys.length === 0) return false
  return keys.some((key) => pendingGenerationKeys.has(key))
}

export function resetPendingSend() {
  if (pendingSend?.sessionKey) {
    clearPendingMessage(pendingSend.sessionKey)
  }
  pendingSend = null
  pendingGenerationKeys.clear()
}

export function clearPendingSendForSession(
  sessionKey: string,
  friendlyId: string,
) {
  if (sessionKey) {
    clearPendingMessage(sessionKey)
  } else if (friendlyId) {
    removePendingSendFromStorageByFriendlyId(friendlyId)
  }

  setPendingGeneration(false, { sessionKey, friendlyId })

  if (!pendingSend) return
  if (sessionKey && pendingSend.sessionKey === sessionKey) {
    pendingSend = null
    return
  }
  if (friendlyId && pendingSend.friendlyId === friendlyId) {
    pendingSend = null
  }
}

export function setRecentSession(friendlyId: string) {
  const trimmed = friendlyId.trim()
  if (!trimmed) {
    recentSession = null
    return
  }
  recentSession = { friendlyId: trimmed, at: Date.now() }
}

export function isRecentSession(friendlyId: string, maxAgeMs = 60_000) {
  if (!recentSession) return false
  if (recentSession.friendlyId !== friendlyId) return false
  if (Date.now() - recentSession.at >= maxAgeMs) return false
  return true
}

export function consumePendingSend(
  sessionKey: string,
  friendlyId?: string,
): PendingSendPayload | null {
  if (!pendingSend) return null
  if (sessionKey && pendingSend.sessionKey === sessionKey) {
    const payload = pendingSend
    pendingSend = null
    return payload
  }
  if (friendlyId && pendingSend.friendlyId === friendlyId) {
    const payload = pendingSend
    pendingSend = null
    return payload
  }
  return null
}
