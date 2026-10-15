type ResolveSessionKeyInput = {
  rawSessionKey?: string
  friendlyId?: string
  defaultKey?: string
}

type ResolveSessionResult = {
  sessionKey: string
  resolvedVia: 'raw' | 'friendly' | 'default'
}

type SessionLike = {
  id: string
  title?: string | null
  message_count?: number | null
}

/**
 * @deprecated No longer used — `main` always resolves to state.db's most
 * recent real session. Kept temporarily for callers that haven't been
 * migrated yet; always returns false.
 */
type PortableMainBindingOptions = {
  sessionKey: string | null | undefined
  dashboardAvailable: boolean
  enhancedChat: boolean
}

const SYNTHETIC_SESSION_KEYS = new Set(['main', 'new'])

export function isInternalSessionKey(id: string): boolean {
  return (
    id.startsWith('cron_') ||
    id.startsWith('cron:') ||
    id.startsWith('agent:main:ops-')
  )
}

export function hasRealTitle(session: SessionLike): boolean {
  const title = (session.title ?? '').trim()
  return title.length > 0 && title !== session.id
}

export function resolveMainChatSessionId(
  sessions: Array<SessionLike>,
): string | null {
  const titled = sessions.find(
    (session) => !isInternalSessionKey(session.id) && hasRealTitle(session),
  )
  const fallback = titled
    ? null
    : sessions.find(
        (session) =>
          !isInternalSessionKey(session.id) &&
          typeof session.message_count === 'number' &&
          session.message_count > 0,
      )
  return (titled ?? fallback)?.id ?? null
}

export function isSyntheticSessionKey(
  value: string | null | undefined,
): boolean {
  if (!value) return false
  return SYNTHETIC_SESSION_KEYS.has(value.trim())
}

/**
 * @deprecated Always returns false. `main` now resolves via
 * `resolveMainChatSessionId()` against the active profile's state.db.
 * Dashboard availability is no longer a binding condition.
 */
export function shouldBindMainToPortableSession({
  sessionKey: _sessionKey,
  dashboardAvailable: _dashboardAvailable,
  enhancedChat: _enhancedChat,
}: PortableMainBindingOptions): boolean {
  return false
}

export async function resolveSessionKey({
  rawSessionKey,
  friendlyId,
  defaultKey = 'new',
}: ResolveSessionKeyInput): Promise<ResolveSessionResult> {
  const trimmedRaw = rawSessionKey?.trim() ?? ''
  if (trimmedRaw.length > 0) {
    return { sessionKey: trimmedRaw, resolvedVia: 'raw' }
  }

  const trimmedFriendly = friendlyId?.trim() ?? ''
  if (trimmedFriendly.length > 0) {
    return { sessionKey: trimmedFriendly, resolvedVia: 'friendly' }
  }

  return { sessionKey: defaultKey, resolvedVia: 'default' }
}
