import type { SessionMeta } from './types'

/**
 * Pluggable session list controller for ChatSessionSidebar.
 * Hermes fills this from gateway useChatSessions; managed runtimes from
 * the daemon Host (useExternalAgentSessions).
 */
export type SessionController = {
  sessions: Array<SessionMeta>
  loading: boolean
  fetching?: boolean
  error: string | null
  activeFriendlyId: string
  onNewChat: () => void
  onRetry: () => void
  onActivateSession?: (session: SessionMeta) => void
  onRename?: (session: SessionMeta, title: string) => void
  onDelete?: (session: SessionMeta) => void | boolean | Promise<boolean | void>
  onActiveSessionDelete?: () => void
}
