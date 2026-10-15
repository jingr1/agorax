const GLOBAL_LAST_SESSION_KEY = 'claude-last-session'
const GLOBAL_LAST_AGENT_KEY = 'hermes-last-agent'
const memoryStore = new Map<string, string>()

function profileLastSessionKey(profileName: string): string {
  return `${GLOBAL_LAST_SESSION_KEY}:${profileName}`
}

function canUseLocalStorage(): boolean {
  return (
    typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'
  )
}

function readStorage(key: string): string | null {
  try {
    const value = canUseLocalStorage()
      ? window.localStorage.getItem(key)
      : (memoryStore.get(key) ?? null)
    const trimmed = typeof value === 'string' ? value.trim() : ''
    if (!trimmed || trimmed === 'main') return null
    return trimmed
  } catch {
    return null
  }
}

function writeStorage(key: string, value: string): void {
  try {
    if (canUseLocalStorage()) {
      window.localStorage.setItem(key, value)
      return
    }
    memoryStore.set(key, value)
  } catch {
    // Ignore quota / private-mode failures.
  }
}

export function resetLastSessionStorage(): void {
  memoryStore.clear()
  if (!canUseLocalStorage()) return
  try {
    const keysToRemove: Array<string> = []
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index)
      if (key?.startsWith(GLOBAL_LAST_SESSION_KEY)) keysToRemove.push(key)
    }
    for (const key of keysToRemove) {
      window.localStorage.removeItem(key)
    }
  } catch {
    // ignore
  }
}

export function writeLastSession(
  friendlyId: string,
  profileName?: string,
): void {
  const trimmed = friendlyId.trim()
  if (!trimmed || trimmed === 'main' || trimmed === 'new') return
  writeStorage(GLOBAL_LAST_SESSION_KEY, trimmed)
  const profile = profileName?.trim()
  if (profile) {
    writeStorage(profileLastSessionKey(profile), trimmed)
  }
}

export function readLastSession(profileName?: string): string | null {
  const profile = profileName?.trim()
  if (profile) {
    const profileLast = readStorage(profileLastSessionKey(profile))
    if (profileLast) return profileLast
  }
  return readStorage(GLOBAL_LAST_SESSION_KEY)
}

export function writeLastAgent(agentId: string): void {
  const trimmed = agentId.trim()
  if (!trimmed) return
  writeStorage(GLOBAL_LAST_AGENT_KEY, trimmed)
}

export function readLastAgent(): string | null {
  const value = readStorage(GLOBAL_LAST_AGENT_KEY)
  return value
}

export function resolveSessionForProfile(
  sessions: Array<{ friendlyId?: string }> | undefined,
  profileName: string,
  options?: { sessionsLoaded?: boolean },
): string {
  const list = Array.isArray(sessions) ? sessions : []
  const profileLast = readStorage(profileLastSessionKey(profileName.trim()))

  // Session list not fetched yet — trust remembered session for fast profile switch.
  if (list.length === 0 && !options?.sessionsLoaded) {
    return profileLast || 'new'
  }

  // Fetched and confirmed empty — start fresh instead of a stale remembered id.
  if (list.length === 0) {
    return 'new'
  }

  const ids = new Set(
    list
      .map((session) => session.friendlyId?.trim())
      .filter((id): id is string => Boolean(id)),
  )

  if (profileLast && ids.has(profileLast)) return profileLast

  const globalLast = readStorage(GLOBAL_LAST_SESSION_KEY)
  if (globalLast && ids.has(globalLast)) return globalLast

  return list[0]?.friendlyId?.trim() || 'new'
}
