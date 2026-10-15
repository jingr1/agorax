import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useFeatureCapability } from '@/hooks/use-feature-capability'

import { assistantHasVisibleHostContent } from '@/lib/chat-message-parts'
import {
  foldOpenTurnIntoLiveHost,
  preferLiveAssistantOnCollision,
} from '@/lib/chat-turn-identity'
import {
  deriveFriendlyIdFromKey,
  isMissingAuth,
  readError,
  textFromMessage,
} from './utils'
import {
  advanceStickyStreamingText,
  buildChatNavKey,
  createOptimisticMessage,
  createResponseWaitSnapshot,
  isRetryableUserMessage,
  hasFinalAssistantWriteThrough,
  shouldCancelStreamOnSessionNav,
  shouldClearWaitingForAssistantMessage,
  shouldHandoffStreamOnProfileNav,
  shouldSettleWaitingFromActiveRun,
} from './chat-screen-utils'
import { useHermesEngineChatState } from './hooks/use-hermes-engine-chat'
import { ManagedAgentInteractionPanel } from './components/managed-agent-interaction-panel'
import { getHermesChatRuntime } from '@/stores/hermes-chat-runtime'
import {
  findLastUserMessage,
  historyIndexOf,
  keepCountForEdit,
  keepCountForRegenerate,
} from './session-fork'
import {
  clearSessionQueue,
  dequeueSessionMessage,
  enqueueSessionMessage,
  queuedMessageCount,
} from './lib/session-message-queue'
import {
  appendHistoryMessage,
  chatQueryKeys,
  clearHistoryMessages,
  fetchStatus,
  moveHistoryMessages,
  reconcileSessionDraft,
  updateHistoryMessageByClientId,
  updateHistoryMessageByClientIdEverywhere,
  updateSessionLastMessage,
} from './chat-queries'
import { ChatMessageList } from './components/chat-message-list'
import { ChatEmptyState } from './components/chat-empty-state'
import { ChatComposer } from './components/chat-composer'
import {
  AgentChatFrame,
  type AgentChatFrameHandle,
} from './components/agent-chat-frame'
import { HERMES_CHAT_BRAND } from './agent-chat-brands'
import { HERMES_SLASH_COMMANDS } from './slash-commands/hermes'
import type { SessionController } from './session-controller'
import {
  BackgroundTasksBadge,
  SideQuestionCard,
} from './components/side-channel-cards'
import { ChatSessionSidebar } from './components/chat-session-sidebar'
import { ConnectionStatusMessage } from './components/connection-status-message'
import {
  clearPendingSendForSession,
  consumePendingSend,
  hasPendingGeneration,
  hasPendingSend,
  hasPendingSendForSession,
  isRecentSession,
  resetPendingSend,
  setPendingGeneration,
  setRecentSession,
} from './pending-send'
import { useChatMeasurements } from './hooks/use-chat-measurements'
import { useChatHistory } from './hooks/use-chat-history'
import { useRealtimeChatHistory } from './hooks/use-realtime-chat-history'
import { snapshotOptimisticUserMessages } from './hooks/optimistic-message-reinject'
import { useStreamingMessage } from './hooks/use-streaming-message'
import { useActiveRunCheck } from './hooks/use-active-run-check'
import { useChatMobile } from './hooks/use-chat-mobile'
import { useChatSessions } from './hooks/use-chat-sessions'
import { useAutoSessionTitle } from './hooks/use-auto-session-title'
import { useRenameSession } from './hooks/use-rename-session'
import { useProfiles } from './hooks/use-profiles'
import { resolveSessionForProfile, writeLastSession } from './last-session'
import { useContextAlert } from './hooks/use-context-alert'
import {
  CHAT_OPEN_SETTINGS_EVENT,
  CHAT_PENDING_COMMAND_STORAGE_KEY,
  CHAT_PENDING_MESSAGE_STORAGE_KEY,
  CHAT_RUN_COMMAND_EVENT,
  CHAT_SUBMIT_SELECTION_EVENT,
} from './chat-events'
import type {
  ChatRunCommandDetail,
  ChatSubmitSelectionDetail,
} from './chat-events'
import type { ResponseWaitSnapshot } from './chat-screen-utils'
import type {
  ChatComposerAttachment,
  ChatComposerHandle,
  ChatComposerHelpers,
  ThinkingLevel,
} from './components/chat-composer'
import type { ApprovalRequest } from '@/screens/gateway/lib/approvals-store'
import type { ChatAttachment, ChatMessage, SessionMeta } from './types'
import type { AgentActivity } from '@/stores/chat-activity-store'
import { useChatSettingsStore } from '@/hooks/use-chat-settings'
import { playChatComplete } from '@/lib/sounds'
import {
  addApproval,
  loadApprovals,
  saveApprovals,
} from '@/screens/gateway/lib/approvals-store'
import { stripQueuedWrapper } from '@/lib/strip-queued-wrapper'
import { registerStreamHandoffHandler } from '@/lib/stream-handoff-bridge'
import { cn } from '@/lib/utils'
import { toast } from '@/components/ui/toast'
import { hapticTap } from '@/lib/haptics'
import { SEARCH_MODAL_EVENTS } from '@/hooks/use-search-modal'
import { SIDEBAR_TOGGLE_EVENT } from '@/hooks/use-global-shortcuts'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { TerminalPanel } from '@/components/terminal-panel'
import { useTerminalPanelStore } from '@/stores/terminal-panel-store'
import { useModelSuggestions } from '@/hooks/use-model-suggestions'
import { ModelSuggestionToast } from '@/components/model-suggestion-toast'
import { MobileSessionsPanel } from '@/components/mobile-sessions-panel'
import { ContextAlertModal } from '@/components/usage-meter/context-alert-modal'
import { ErrorToastContainer, showErrorToast } from '@/components/error-toast'
// ContextMeter removed — ContextIndicator in composer replaces top ContextBar
import { persistRecoveryMessage, useChatStore } from '@/stores/chat-store'
import {
  pendingSessionModelKey,
  useSessionModelStore,
} from '@/stores/session-model-store'
import { useResearchCard } from '@/hooks/use-research-card'
// MOBILE_TAB_BAR_OFFSET removed — tab bar always hidden in chat
import { useTapDebug } from '@/hooks/use-tap-debug'
import { useChatMode } from '@/hooks/use-chat-mode'
import { useChatActivityStore } from '@/stores/chat-activity-store'
import { _localModelOverride } from '@/screens/chat/local-model-override'

type ChatScreenProps = {
  activeFriendlyId: string
  isNewChat?: boolean
  onSessionResolved?: (payload: {
    sessionKey: string
    friendlyId: string
  }) => void
  forcedSessionKey?: string
  /** Hide header + file explorer + terminal for panel mode */
  compact?: boolean
  /**
   * Disables internal `navigate()` side effects so the chat can be embedded
   * in other routes (e.g. Operations orchestrator card) without yanking the
   * user out to /chat/<uuid> on mount, refresh, or after send.
   */
  embedded?: boolean
  /** Replace the default chat main panel with a custom node. */
  renderMain?: React.ReactNode
  /**
   * Pluggable session list. When set, ChatSessionSidebar uses this instead of
   * Hermes gateway sessions (Claude Code / managed runtimes).
   */
  sessionController?: SessionController
  /**
   * Hermes-only chrome: TerminalPanel, approvals strip.
   * Managed runtimes pass false.
   */
  hermesChrome?: boolean
  /** Registry agent id for platform skill composer `/` listing. */
  skillsAgentId?: string
  /** Display name for the new-session empty state. */
  agentName?: string
  /** Runtime / provider for the new-session empty-state avatar. */
  agentRuntime?: string | null
  /**
   * Per-agent models catalog URL. When set, composer uses this instead of
   * global Hermes `/api/models` (see GET /api/agents/:id/models).
   */
  modelsEndpoint?: string
  /**
   * Composer footer identity label (agent display name). Hermes should pass
   * this so a per-agent modelsEndpoint does not fall through to a managed
   * runtime brand.
   */
  runtimeLabel?: string
}

type PortableHistoryMessage = {
  role: 'user' | 'assistant' | 'system'
  content: string
}

function normalizeMimeType(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.trim().toLowerCase()
}

function isImageMimeType(value: unknown): boolean {
  const normalized = normalizeMimeType(value)
  return normalized.startsWith('image/')
}

function readDataUrlMimeType(value: unknown): string {
  if (typeof value !== 'string') return ''
  const match = /^data:([^;,]+)[^,]*,/i.exec(value.trim())
  return match?.[1]?.trim().toLowerCase() || ''
}

function stripDataUrlPrefix(value: unknown): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!trimmed) return ''
  const commaIndex = trimmed.indexOf(',')
  if (trimmed.toLowerCase().startsWith('data:') && commaIndex >= 0) {
    return trimmed.slice(commaIndex + 1).trim()
  }
  return trimmed
}

function normalizeMessageValue(value: unknown): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : ''
}

function getPortableHistoryContent(message: ChatMessage): string {
  const text = textFromMessage(message).trim()
  if (text) return text
  if (
    message.role === 'user' &&
    Array.isArray(message.attachments) &&
    message.attachments.length > 0
  ) {
    return 'Please review the attached content.'
  }
  return ''
}

function buildPortableHistory(
  messages: Array<ChatMessage>,
): Array<PortableHistoryMessage> {
  return messages
    .filter(
      (
        message,
      ): message is ChatMessage & { role: 'user' | 'assistant' | 'system' } =>
        message.role === 'user' ||
        message.role === 'assistant' ||
        message.role === 'system',
    )
    .filter((message) => (message as any).__streamingStatus !== 'streaming')
    .map((message) => {
      const content = getPortableHistoryContent(message)
      if (!content) return null
      return {
        role: message.role,
        content,
      }
    })
    .filter((message): message is PortableHistoryMessage => message !== null)
    .slice(-20)
}

function sanitizeExportToken(value: string): string {
  return value
    .trim()
    .replace(/[^a-z0-9-_]+/gi, '-')
    .replace(/^-+|-+$/g, '')
}

function exportConversationTranscript(payload: {
  sessionLabel: string
  messages: Array<ChatMessage>
}) {
  if (typeof document === 'undefined') return false

  const sessionToken =
    sanitizeExportToken(payload.sessionLabel) || 'conversation'
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const body = payload.messages
    .map((message) => {
      const role =
        typeof message.role === 'string' && message.role.trim()
          ? message.role.trim().toUpperCase()
          : 'MESSAGE'
      const text = textFromMessage(message).trim()
      const attachments = Array.isArray(message.attachments)
        ? message.attachments
            .map((attachment) => attachment?.name?.trim())
            .filter((value): value is string => Boolean(value))
        : []

      const lines = [`## ${role}`]
      if (text) lines.push(text)
      if (attachments.length > 0) {
        lines.push('', 'Attachments:')
        for (const attachment of attachments) {
          lines.push(`- ${attachment}`)
        }
      }
      return lines.join('\n')
    })
    .join('\n\n')
    .trim()

  const content = `# Hermes Conversation Export\n\nSession: ${payload.sessionLabel}\nExported: ${new Date().toISOString()}\n\n${body || '_No messages in this conversation._'}\n`
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${sessionToken}-${timestamp}.md`
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
  return true
}

function messageFallbackSignature(message: ChatMessage): string {
  const raw = message as Record<string, unknown>
  const timestamp = normalizeMessageValue(
    typeof raw.timestamp === 'number' ? String(raw.timestamp) : raw.timestamp,
  )

  const contentParts = Array.isArray(message.content)
    ? message.content
        .map((part: any) => {
          if (part.type === 'text') {
            return `t:${typeof part.text === 'string' ? part.text.trim() : ''}`
          }
          if (part.type === 'thinking') {
            return `th:${typeof part.thinking === 'string' ? part.thinking : ''}`
          }
          if (part.type === 'toolCall') {
            const toolPart = part
            return `tc:${toolPart.id ?? ''}:${toolPart.name ?? ''}`
          }
          return `p:${part.type ?? ''}`
        })
        .join('|')
    : ''

  const attachments = Array.isArray(message.attachments)
    ? message.attachments
        .map((attachment) => {
          const name =
            typeof attachment?.name === 'string' ? attachment.name : ''
          const size =
            typeof attachment?.size === 'number' ? String(attachment.size) : ''
          const type =
            typeof attachment?.contentType === 'string'
              ? attachment.contentType
              : ''
          return `${name}:${size}:${type}`
        })
        .join('|')
    : ''

  return `${message.role ?? 'unknown'}:${timestamp}:${contentParts}:${attachments}`
}

function getMessageClientId(message: ChatMessage): string {
  const raw = message as Record<string, unknown>
  const directClientId = normalizeMessageValue(raw.clientId)
  if (directClientId) return directClientId

  const alternateClientId = normalizeMessageValue(raw.client_id)
  if (alternateClientId) return alternateClientId

  const optimisticId = normalizeMessageValue(raw.__optimisticId)
  if (optimisticId.startsWith('opt-')) {
    return optimisticId.slice(4)
  }
  return ''
}

function getRetryMessageKey(message: ChatMessage): string {
  const clientId = getMessageClientId(message)
  if (clientId) return `client:${clientId}`

  const raw = message as Record<string, unknown>
  const optimisticId = normalizeMessageValue(raw.__optimisticId)
  if (optimisticId) return `optimistic:${optimisticId}`

  const messageId = normalizeMessageValue(raw.id)
  if (messageId) return `id:${messageId}`

  const timestamp = normalizeMessageValue(
    typeof raw.timestamp === 'number' ? String(raw.timestamp) : raw.timestamp,
  )
  const messageText = textFromMessage(message).trim()
  return `fallback:${message.role ?? 'unknown'}:${timestamp}:${messageText}`
}

function isRetryableQueuedMessage(
  message: ChatMessage,
  mode: 'manual' | 'auto',
): boolean {
  return isRetryableUserMessage(message, mode)
}

const commandHelpers: ChatComposerHelpers = {
  reset() {},
  setValue() {},
  setAttachments() {},
}

function getMessageRetryAttachments(
  message: ChatMessage,
): Array<ChatAttachment> {
  if (!Array.isArray(message.attachments)) return []
  return message.attachments.filter((attachment) => {
    return Boolean(attachment) && typeof attachment === 'object'
  })
}

function getMessageStatusValue(message: ChatMessage): string {
  return normalizeMessageValue((message as Record<string, unknown>).status)
}

function getMessageTimestampValue(message: ChatMessage): number | null {
  const raw = message as Record<string, unknown>
  const candidates = [
    raw.timestamp,
    raw.__createdAt,
    raw.createdAt,
    raw.created_at,
  ]

  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate < 1_000_000_000_000 ? candidate * 1000 : candidate
    }
    if (typeof candidate === 'string') {
      const parsed = Date.parse(candidate)
      if (!Number.isNaN(parsed)) return parsed
    }
  }

  return null
}

function getMessageAttachmentSignature(message: ChatMessage): string {
  if (!Array.isArray(message.attachments) || message.attachments.length === 0) {
    return ''
  }

  return message.attachments
    .map((attachment) => {
      const name = typeof attachment?.name === 'string' ? attachment.name : ''
      const size =
        typeof attachment?.size === 'number' ? String(attachment.size) : ''
      const type =
        typeof attachment?.contentType === 'string'
          ? attachment.contentType
          : ''
      return `${name}:${size}:${type}`
    })
    .sort()
    .join('|')
}

function isOptimisticUserMessage(message: ChatMessage): boolean {
  const raw = message as Record<string, unknown>
  return (
    normalizeMessageValue(raw.__optimisticId).length > 0 ||
    ['sending', 'sent', 'done'].includes(getMessageStatusValue(message))
  )
}

function shouldCollapseTextDuplicate(
  existing: ChatMessage,
  candidate: ChatMessage,
): boolean {
  if (existing.role !== candidate.role) return false

  if (candidate.role === 'assistant') {
    return true
  }

  if (candidate.role !== 'user') return false

  const existingTs = getMessageTimestampValue(existing)
  const candidateTs = getMessageTimestampValue(candidate)
  if (existingTs !== null && candidateTs !== null) {
    if (Math.abs(existingTs - candidateTs) > 15_000) return false
  }

  // Collapse same-turn user duplicates even after the optimistic marker has been
  // cleared. The send path can leave us with an optimistic local message plus a
  // confirmed/history copy after completion; requiring one side to still look
  // optimistic misses that handoff and leaves both visible.
  const existingSig = getMessageAttachmentSignature(existing)
  const candidateSig = getMessageAttachmentSignature(candidate)
  if (existingSig && candidateSig) {
    return existingSig === candidateSig
  }

  return true
}

function stripQueuedWrapperFromUserMessage(message: ChatMessage): ChatMessage {
  if (message.role !== 'user') return message

  const text = textFromMessage(message)
  const cleanedText = stripQueuedWrapper(text)
  if (cleanedText === text) return message

  return {
    ...message,
    content: [{ type: 'text', text: cleanedText }],
    text: cleanedText,
    body: cleanedText,
    message: cleanedText,
  }
}

export function ChatScreen({
  activeFriendlyId,
  isNewChat = false,
  onSessionResolved,
  forcedSessionKey,
  compact = false,
  embedded = false,
  renderMain,
  sessionController,
  hermesChrome = true,
  skillsAgentId,
  agentName,
  agentRuntime,
  modelsEndpoint,
  runtimeLabel,
}: ChatScreenProps) {
  const navigate = useNavigate()
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  })
  /** Full-page chat only — panel/embedded must never steal the URL. */
  const canMutateChatRoute =
    !embedded &&
    (pathname.startsWith('/chat') || pathname === '/new' || pathname === '/')
  const chatFocusMode = useWorkspaceStore((s) => s.chatFocusMode)
  const setChatFocusMode = useWorkspaceStore((s) => s.setChatFocusMode)
  const queryClient = useQueryClient()
  const [sending, setSending] = useState(false)
  const [queueVersion, setQueueVersion] = useState(0)
  const [_creatingSession, setCreatingSession] = useState(false)
  const [sessionsOpen, setSessionsOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isRedirecting, setIsRedirecting] = useState(false)
  const { headerRef, composerRef, mainRef, pinGroupMinHeight, headerHeight } =
    useChatMeasurements()
  useTapDebug(mainRef, { label: 'chat-main' })
  const chatMode = useChatMode()
  const isPortableMode = chatMode === 'portable'
  const portableChatFriendlyId = isPortableMode ? 'main' : activeFriendlyId
  // --- Issue #43 fix: lift waitingForResponse into persistent Zustand store ---
  // The store survives component unmount, so navigating away mid-stream
  const [liveToolActivity, setLiveToolActivity] = useState<
    Array<{ name: string; timestamp: number }>
  >([])
  const streamTimer = useRef<number | null>(null)
  const failsafeTimerRef = useRef<number | null>(null)
  const lastAssistantSignature = useRef('')
  const refreshHistoryRef = useRef<() => void>(() => {})
  const retriedQueuedMessageKeysRef = useRef(new Set<string>())
  const hasSeenDisconnectRef = useRef(false)
  const hadErrorRef = useRef(false)
  const abortActiveStreamRef = useRef<() => void>(() => {})
  /** Live send-stream fetch only — not orphaned Zustand streamingState. */
  const localIsStreamingRef = useRef(false)
  const wasBusyForQueueRef = useRef(false)
  const mountDrainKeyRef = useRef<string | null>(null)
  const [pendingApprovals, setPendingApprovals] = useState<
    Array<ApprovalRequest>
  >([])
  const [isCompacting, setIsCompacting] = useState(false)
  const [btwCard, setBtwCard] = useState<{
    question: string
    answer?: string
    error?: string
    loading: boolean
  } | null>(null)
  const [backgroundTasks, setBackgroundTasks] = useState<
    Array<{
      taskId: string
      status: 'running' | 'done' | 'error'
      prompt: string
      sessionId: string
      answer?: string
      error?: string
    }>
  >([])
  const [researchResetKey, setResearchResetKey] = useState(0)
  // Per-session thinking level — stored in sessionStorage keyed by session
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>(() => {
    if (typeof window === 'undefined') return 'medium'
    const key = `claude-thinking-${activeFriendlyId || 'new'}`
    const stored = window.sessionStorage.getItem(key)
    if (
      stored === 'off' ||
      stored === 'low' ||
      stored === 'medium' ||
      stored === 'high' ||
      stored === 'adaptive'
    )
      return stored
    return 'medium'
  })
  // Tracks whether the user has explicitly picked a thinking level for this session.
  // A missing/absent sessionStorage key means we should fall back to the Hermes config default.
  const thinkingInitializedByUserRef = useRef(false)
  const handleNewChat = useCallback(() => {
    navigate({ to: '/chat/$sessionKey', params: { sessionKey: 'new' } })
  }, [navigate])

  const handleActiveSessionDelete = useCallback(() => {
    navigate({ to: '/chat/$sessionKey', params: { sessionKey: 'main' } })
  }, [navigate])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const key = `claude-thinking-${activeFriendlyId || 'new'}`
    thinkingInitializedByUserRef.current =
      window.sessionStorage.getItem(key) !== null
  }, [activeFriendlyId])
  const { alertOpen, alertThreshold, alertPercent, dismissAlert } =
    useContextAlert()

  const pendingStartRef = useRef(false)
  const composerHandleRef = useRef<ChatComposerHandle | null>(null)
  const agentChatFrameRef = useRef<AgentChatFrameHandle | null>(null)
  // Idempotency guard prevents duplicate sends on paste/attach double-fire.
  const lastSendKeyRef = useRef('')
  const lastSendAtRef = useRef(0)
  const activeSendRef = useRef<{
    sessionKey: string
    friendlyId: string
    clientId: string
  } | null>(null)
  const { isMobile } = useChatMobile(queryClient)
  const mobileKeyboardInset = useWorkspaceStore((s) => s.mobileKeyboardInset)
  const mobileComposerFocused = useWorkspaceStore(
    (s) => s.mobileComposerFocused,
  )
  const mobileKeyboardActive = mobileKeyboardInset > 0 || mobileComposerFocused
  void mobileKeyboardActive // kept for future use
  const isTerminalPanelOpen = useTerminalPanelStore(
    (state) => state.isPanelOpen,
  )
  const terminalPanelHeight = useTerminalPanelStore(
    (state) => state.panelHeight,
  )
  const { renameSession, renaming: renamingSessionTitle } = useRenameSession()
  const sseConnectionState = useChatStore((s) => s.connectionState)
  const sessionTruncateCap = useFeatureCapability('sessionTruncate')
  const sessionCompressCap = useFeatureCapability('sessionCompress')
  const canTruncateSession = sessionTruncateCap.available
  const canCompressSession = sessionCompressCap.available
  const UNAVAILABLE_TRUNCATE_MSG =
    'Not available on this Hermes build (needs upstream session_truncate)'
  const UNAVAILABLE_COMPRESS_MSG =
    'Not available on this Hermes build (needs upstream session_compress)'

  const {
    activeProfileName,
    workspaceProfileName,
    isReady: profilesReady,
  } = useProfiles()

  const {
    sessionsQuery,
    sessions: hermesSessions,
    activeSession,
    activeExists,
    activeSessionKey,
    activeTitle: hermesActiveTitle,
    sessionsError: hermesSessionsError,
    sessionsLoading: hermesSessionsLoading,
    sessionsFetching: hermesSessionsFetching,
    refetchSessions: hermesRefetchSessions,
  } = useChatSessions({ activeFriendlyId, isNewChat, forcedSessionKey })

  const sessions = sessionController?.sessions ?? hermesSessions
  const sessionsError = sessionController
    ? sessionController.error
    : hermesSessionsError
  const sessionsLoading = sessionController
    ? sessionController.loading
    : hermesSessionsLoading
  const sessionsFetching = sessionController
    ? (sessionController.fetching ?? false)
    : hermesSessionsFetching
  const refetchSessions = sessionController
    ? sessionController.onRetry
    : hermesRefetchSessions
  const activeTitle = hermesActiveTitle
  const sidebarActiveFriendlyId =
    sessionController?.activeFriendlyId ?? activeFriendlyId
  const sidebarOnNewChat = sessionController?.onNewChat ?? handleNewChat
  const sidebarOnActiveSessionDelete =
    sessionController?.onActiveSessionDelete ?? handleActiveSessionDelete
  const sessionOwnedByProfile = sessions.some(
    (session) => session.friendlyId === activeFriendlyId,
  )
  // With a cached active profile, sessions can succeed before /profiles/list.
  // Don't block history on profilesReady once this route session is in the list.
  const sessionVerified =
    isPortableMode ||
    isNewChat ||
    Boolean(forcedSessionKey) ||
    isRecentSession(activeFriendlyId) ||
    hasPendingGeneration({
      sessionKey: forcedSessionKey || activeSessionKey,
      friendlyId: activeFriendlyId,
    }) ||
    (sessionsQuery.isSuccess && sessionOwnedByProfile)
  const {
    historyQuery,
    historyMessages,
    messageCount,
    historyError,
    resolvedSessionKey,
    activeCanonicalKey,
    sessionKeyForHistory,
  } = useChatHistory({
    activeFriendlyId: portableChatFriendlyId,
    activeSessionKey,
    forcedSessionKey,
    isNewChat,
    isRedirecting,
    activeExists,
    sessionsReady: sessionsQuery.isSuccess,
    queryClient,
    historyRefetchInterval:
      sseConnectionState === 'connected' ? 60_000 : 20_000,
    portableMode: isPortableMode,
    profileName: activeProfileName,
    sessionVerified,
  })

  // Skeleton / gateway-deferral gate — defined early so models/composer don't
  // race history on a cold gateway. Skip for /chat/new: history query is
  // disabled there but stays isPending with no data, which would trap the UI
  // in the skeleton forever instead of ChatEmptyState.
  const historyLoading =
    !isNewChat &&
    (isRedirecting ||
      (!historyQuery.data &&
        (historyQuery.isPending ||
          historyQuery.isLoading ||
          historyQuery.isFetching)))

  // --- Waiting state management (Issue #43 + #449) ---
  // resolvedSessionKey is now available (defined above from useChatHistory).
  const storeWaiting = useChatStore((s) => s.waitingSessionKeys)
  const sessionKeyForWaiting = useRef<string | undefined>(undefined)
  const pendingVerifySessionKeyRef = useRef<string | undefined>(undefined)

  // Keep the waiting-state ref in sync with the resolved session key
  sessionKeyForWaiting.current = resolvedSessionKey

  // Synchronously detect stale waiting state from sessionStorage.
  // This runs during render (not in an effect) so the guard in
  // waitingForResponse is active on the very first render, preventing
  // a flash of the "Thinking" indicator when reopening an old session.
  const needsStaleCheck =
    resolvedSessionKey &&
    !isNewChat &&
    storeWaiting.has(resolvedSessionKey) &&
    pendingVerifySessionKeyRef.current !== resolvedSessionKey

  if (needsStaleCheck) {
    pendingVerifySessionKeyRef.current = resolvedSessionKey
  }

  // Track whether the active-run API check has completed.
  // Initialize to false when we detect stale state (needs verification),
  // true otherwise. This prevents showing "Thinking" until the API confirms.
  const [activeRunCheckDone, setActiveRunCheckDone] = useState(!needsStaleCheck)

  const pendingSessionIdentity = useMemo(
    () => ({
      sessionKey:
        resolvedSessionKey ||
        activeCanonicalKey ||
        (isNewChat ? null : sessionKeyForHistory) ||
        null,
      friendlyId: isNewChat ? 'new' : activeFriendlyId,
    }),
    [
      resolvedSessionKey,
      activeCanonicalKey,
      isNewChat,
      sessionKeyForHistory,
      activeFriendlyId,
    ],
  )

  const waitingForResponse = useMemo(() => {
    const key = sessionKeyForWaiting.current
    if (!key) {
      return (
        hasPendingSendForSession(pendingSessionIdentity) ||
        hasPendingGeneration(pendingSessionIdentity)
      )
    }

    // If we restored waiting state from sessionStorage but haven't verified
    // with the API yet, don't show thinking — it might be stale (Issue #449).
    if (
      storeWaiting.has(key) &&
      pendingVerifySessionKeyRef.current === key &&
      !activeRunCheckDone
    ) {
      return false
    }

    return storeWaiting.has(key)
  }, [storeWaiting, activeRunCheckDone, pendingSessionIdentity])

  const setWaitingForResponse = useCallback((waiting: boolean) => {
    const store = useChatStore.getState()
    const key = sessionKeyForWaiting.current
    if (!key) return
    if (waiting) {
      store.setSessionWaiting(key)
    } else {
      store.clearSessionWaiting(key)
    }
  }, [])
  // verification before showing thinking (Issue #449).
  useEffect(() => {
    const currentSessionKey = resolvedSessionKey
    if (!currentSessionKey || isNewChat) return
    const store = useChatStore.getState()
    if (store.isSessionWaiting(currentSessionKey)) {
      pendingVerifySessionKeyRef.current = currentSessionKey
      setActiveRunCheckDone(false)
    } else {
      // No restored waiting state — no need to verify
      pendingVerifySessionKeyRef.current = undefined
      setActiveRunCheckDone(true)
    }
  }, [resolvedSessionKey, isNewChat])

  // Remount reconcile: clear orphan waiting/streaming when server has no live
  // run. Never setSessionWaiting here — busy is Engine turnBusy; waiting is
  // send/recovery latch only (arms settle probes, not Working).
  useActiveRunCheck({
    sessionKey: resolvedSessionKey ?? '',
    enabled:
      !isNewChat && Boolean(resolvedSessionKey) && historyQuery.isSuccess,
    onCheckComplete: useCallback(() => {
      setActiveRunCheckDone(true)
    }, []),
  })

  // Wire SSE realtime stream for instant message delivery
  const {
    messages: realtimeMessages,
    lastCompletedRunAt,
    connectionState,
    isRealtimeStreaming,
    realtimeStreamingThinking,
    realtimeStreamingMessageId,
    realtimeLifecycleEvents,
    clearCompletedStreaming,
    streamingRunId,
    activeToolCalls,
  } = useRealtimeChatHistory({
    sessionKey: isPortableMode
      ? 'main'
      : isNewChat
        ? 'new'
        : resolvedSessionKey ||
          sessionKeyForHistory ||
          activeCanonicalKey ||
          'main',
    friendlyId: portableChatFriendlyId,
    historyMessages,
    portableMode: isPortableMode,
    enabled:
      // Always enable for new chats in portable mode (no sessions API to resolve).
      // In enhanced mode, wait for session resolution before subscribing.
      ((isPortableMode && isNewChat) ||
        (!isNewChat &&
          Boolean(
            resolvedSessionKey || sessionKeyForHistory || activeCanonicalKey,
          ))) &&
      !isRedirecting,
    onUserMessage: useCallback(() => {
      // External message arrived (e.g. from Telegram) — show thinking indicator
      setWaitingForResponse(true)
      setPendingGeneration(true, {
        sessionKey: sessionKeyForWaiting.current,
        friendlyId: portableChatFriendlyId,
      })
    }, [portableChatFriendlyId, setWaitingForResponse]),
    onApprovalRequest: useCallback((payload: Record<string, unknown>) => {
      const approvalId =
        typeof payload.id === 'string'
          ? payload.id
          : typeof payload.approvalId === 'string'
            ? payload.approvalId
            : typeof payload.approvalId === 'string'
              ? payload.approvalId
              : ''

      const currentApprovals = loadApprovals()
      if (
        approvalId &&
        currentApprovals.some((entry) => {
          return (
            entry.status === 'pending' && entry.gatewayApprovalId === approvalId
          )
        })
      ) {
        setPendingApprovals(
          currentApprovals.filter((entry) => entry.status === 'pending'),
        )
        return
      }

      const actionValue = payload.action ?? payload.tool ?? payload.command
      const action =
        typeof actionValue === 'string'
          ? actionValue
          : actionValue
            ? JSON.stringify(actionValue)
            : 'Tool call requires approval'
      const contextValue = payload.context ?? payload.input ?? payload.args
      const context =
        typeof contextValue === 'string'
          ? contextValue
          : contextValue
            ? JSON.stringify(contextValue)
            : ''
      const agentNameValue =
        payload.agentName ?? payload.agent ?? payload.source
      const agentName =
        typeof agentNameValue === 'string' && agentNameValue.trim().length > 0
          ? agentNameValue
          : 'Agent'
      const agentIdValue =
        payload.agentId ?? payload.sessionKey ?? payload.source
      const agentId =
        typeof agentIdValue === 'string' && agentIdValue.trim().length > 0
          ? agentIdValue
          : 'claude'

      addApproval({
        agentId,
        agentName,
        action,
        context,
        source: 'agent',
        gatewayApprovalId: approvalId || undefined,
      })
      setPendingApprovals(
        loadApprovals().filter((entry) => entry.status === 'pending'),
      )
    }, []),
    onCompactionStart: useCallback(() => {
      setIsCompacting(true)
    }, []),
    onCompactionEnd: useCallback(() => {
      setIsCompacting(false)
    }, []),
  })

  // Keep activity stream open persistently — opens on mount so it's ready
  // before the first tool call fires (avoids connection latency gap).
  const waitingForResponseRef = useRef(waitingForResponse)
  useEffect(() => {
    waitingForResponseRef.current = waitingForResponse
  }, [waitingForResponse])

  useEffect(() => {
    const events = new EventSource('/api/events')
    const onActivity = (event: MessageEvent) => {
      // Only populate pills while waiting — but connection stays warm always
      if (!waitingForResponseRef.current) return
      try {
        const payload = JSON.parse(event.data) as {
          type?: unknown
          title?: unknown
        }
        if (payload.type !== 'tool' || typeof payload.title !== 'string') {
          return
        }
        const name = payload.title.replace(/^Tool activity:\s*/i, '').trim()
        if (!name) return
        setLiveToolActivity((prev) => {
          const filtered = prev.filter((entry) => entry.name !== name)
          return [{ name, timestamp: Date.now() }, ...filtered].slice(0, 5)
        })
      } catch {
        // Ignore malformed activity events.
      }
    }
    events.addEventListener('activity', onActivity)
    return () => {
      events.removeEventListener('activity', onActivity)
      events.close()
    }
  }, []) // mount only — stays open for session lifetime

  // Clear tool pills after response arrives (with brief delay so last pill is visible)
  useEffect(() => {
    if (waitingForResponse) return
    const timer = window.setTimeout(() => setLiveToolActivity([]), 800)
    return () => window.clearTimeout(timer)
  }, [waitingForResponse])

  useEffect(() => {
    if (!waitingForResponse) return
    clearCompletedStreaming()
  }, [clearCompletedStreaming, waitingForResponse])

  useEffect(() => {
    function checkApprovals() {
      const all = loadApprovals()
      setPendingApprovals(all.filter((entry) => entry.status === 'pending'))
    }
    checkApprovals()
    const id = window.setInterval(checkApprovals, 2000)
    return () => window.clearInterval(id)
  }, [])

  const resolvePendingApproval = useCallback(
    async (approval: ApprovalRequest, status: 'approved' | 'denied') => {
      const nextApprovals = loadApprovals().map((entry) => {
        if (entry.id !== approval.id) return entry
        return {
          ...entry,
          status,
          resolvedAt: Date.now(),
        }
      })
      saveApprovals(nextApprovals)
      setPendingApprovals(
        nextApprovals.filter((entry) => entry.status === 'pending'),
      )
      if (!approval.gatewayApprovalId) return

      const endpoint =
        status === 'approved'
          ? `/api/approvals/${approval.gatewayApprovalId}/approve`
          : `/api/approvals/${approval.gatewayApprovalId}/deny`
      try {
        await fetch(endpoint, { method: 'POST' })
      } catch {
        // Local resolution still succeeds when API endpoint is unavailable.
      }
    },
    [],
  )

  // --- Stream management ---
  const streamStop = useCallback(() => {
    if (streamTimer.current) {
      window.clearTimeout(streamTimer.current)
      streamTimer.current = null
    }
  }, [])

  useEffect(() => {
    return () => {
      streamStop()
      if (failsafeTimerRef.current) {
        window.clearTimeout(failsafeTimerRef.current)
        failsafeTimerRef.current = null
      }
    }
  }, [streamStop])

  const streamFinish = useCallback(() => {
    streamStop()
    if (failsafeTimerRef.current) {
      window.clearTimeout(failsafeTimerRef.current)
      failsafeTimerRef.current = null
    }
    const activeSend = activeSendRef.current
    if (activeSend) {
      setPendingGeneration(false, {
        sessionKey: activeSend.sessionKey,
        friendlyId: activeSend.friendlyId,
      })
    }
    setPendingGeneration(false, {
      sessionKey: sessionKeyForWaiting.current,
      friendlyId: isNewChat ? 'new' : activeFriendlyId,
    })
    setWaitingForResponse(false)
  }, [activeFriendlyId, isNewChat, streamStop])

  const streamStart = useCallback(() => {
    if (!activeFriendlyId || isNewChat) return
    // No aggressive delayed refetch here — it wipes optimistic user messages
    // from the cache before the server has echoed them, causing the user's
    // message to disappear until the agent completes. The existing failsafes
    // (5s + 10s timeouts at lines below, active-run polling) handle the case
    // where SSE misses the done event.
    void activeFriendlyId // keep dep for eslint
  }, [activeFriendlyId, isNewChat])

  refreshHistoryRef.current = function refreshHistory() {
    // Snapshot any unconfirmed optimistic user messages BEFORE refetch.
    // The refetch replaces the query cache with server data — if the server
    // hasn't processed the user's POST yet, the optimistic message vanishes.
    const historySessionKey = isPortableMode
      ? 'main'
      : activeSessionKey || sessionKeyForHistory || resolvedSessionKey || 'main'
    const reInjectOptimistic = snapshotOptimisticUserMessages(
      queryClient,
      portableChatFriendlyId,
      historySessionKey,
    )

    void historyQuery.refetch({ cancelRefetch: true }).then(() => {
      // Re-inject optimistic messages that weren't in the server response
      reInjectOptimistic()
    })
  }

  const clearTimerRef = useRef<number | null>(null)

  // Failsafe: clear after done event + 10s if response never shows in display
  useEffect(() => {
    if (lastCompletedRunAt && waitingForResponse) {
      const timer = window.setTimeout(() => streamFinish(), 10000)
      return () => window.clearTimeout(timer)
    }
  }, [lastCompletedRunAt, waitingForResponse, streamFinish])

  // Hard failsafe: if waiting for 5s+ and SSE missed the done event, refetch
  // history only when there is no final assistant text (thinking-only ≠ complete).
  useEffect(() => {
    if (!waitingForResponse) return
    const fallback = window.setTimeout(() => {
      if (localIsStreamingRef.current) return
      const key = resolvedSessionKey || sessionKeyForHistory
      if (
        key &&
        hasFinalAssistantWriteThrough(
          useChatStore.getState().realtimeMessages.get(key),
        )
      ) {
        return
      }
      refreshHistoryRef.current()
    }, 5000)
    return () => window.clearTimeout(fallback)
  }, [waitingForResponse, resolvedSessionKey, sessionKeyForHistory])

  // Settle probe (recovery latch only): while send-path waiting is set, probe
  // active-run even if SSE reports connected. After gateway interrupt the run
  // is often already gone and no `done` arrives — without this, waiting stuck
  // until the 120s failsafe. Does not drive Working (hermesTurnBusy = Engine).
  useEffect(() => {
    if (!waitingForResponse || !resolvedSessionKey) return

    let missingRunCount = 0
    let cancelled = false

    async function probeActiveRun() {
      // Skip only while this tab's AbortController is still live. Do not treat
      // leftover Zustand streamingState as "still running" — that deadlocks
      // Stop after remount/handoff when the server run is already gone.
      if (localIsStreamingRef.current) {
        missingRunCount = 0
        return
      }
      try {
        const res = await fetch(
          `/api/sessions/${encodeURIComponent(resolvedSessionKey)}/active-run`,
        )
        if (cancelled || !res.ok) return
        const data = await res.json()
        if (cancelled || !data.ok) return

        const decision = shouldSettleWaitingFromActiveRun(data.run)
        const hasLiveWriteThrough = hasFinalAssistantWriteThrough(
          useChatStore.getState().realtimeMessages.get(resolvedSessionKey),
        )
        if (decision === 'keep') {
          missingRunCount = 0
          // Still registered — only poll history when final assistant text is
          // missing (thinking-only must not skip refetch).
          if (!hasLiveWriteThrough) refreshHistoryRef.current()
          return
        }
        if (decision === 'missing') {
          missingRunCount += 1
          // Allow ~one registration lag window (2 probes) before settling.
          if (missingRunCount < 2) {
            if (!hasLiveWriteThrough) refreshHistoryRef.current()
            return
          }
        }

        useChatStore.getState().clearStreamingSession(resolvedSessionKey)
        setLiveToolActivity([])
        streamFinish()
        if (!hasLiveWriteThrough) refreshHistoryRef.current()
      } catch {
        // ignore network errors
      }
    }

    const initial = window.setTimeout(() => {
      void probeActiveRun()
    }, 2500)
    const interval = window.setInterval(() => {
      void probeActiveRun()
    }, 5000)
    return () => {
      cancelled = true
      window.clearTimeout(initial)
      window.clearInterval(interval)
    }
  }, [waitingForResponse, resolvedSessionKey, streamFinish])

  useAutoSessionTitle({
    friendlyId: activeFriendlyId,
    sessionKey: resolvedSessionKey,
    activeSession,
    messages: historyMessages,
    messageCount,
    enabled:
      !isNewChat && Boolean(resolvedSessionKey) && historyQuery.isSuccess,
  })

  // Phase 4.1: Smart Model Suggestions — prefer per-agent catalog when set.
  const resolvedModelsEndpoint = modelsEndpoint?.trim() || '/api/models'
  const modelsQuery = useQuery({
    queryKey: ['models', resolvedModelsEndpoint],
    queryFn: async () => {
      const res = await fetch(resolvedModelsEndpoint)
      if (!res.ok) return { models: [] }
      const data = await res.json()
      return data
    },
    enabled: !historyLoading,
    staleTime: 5 * 60 * 1000, // 5 minutes
  })

  const currentModelQuery = useQuery({
    queryKey: [
      'claude',
      'session-status-model',
      resolvedSessionKey || activeFriendlyId || 'main',
      activeProfileName || 'default',
    ],
    queryFn: async () => {
      try {
        const statusSessionKey =
          resolvedSessionKey || activeFriendlyId || 'main'
        const params = new URLSearchParams()
        if (statusSessionKey) params.set('sessionKey', statusSessionKey)
        if (activeProfileName) params.set('profile', activeProfileName)
        const query = params.toString() ? `?${params.toString()}` : ''
        const res = await fetch(`/api/session-status${query}`)
        if (!res.ok) return ''
        const data = await res.json()
        const payload = data.payload ?? data
        // Same logic as chat-composer: read model from status payload
        if (payload.model) return String(payload.model)
        if (payload.currentModel) return String(payload.currentModel)
        if (payload.modelAlias) return String(payload.modelAlias)
        if (payload.resolved?.modelProvider && payload.resolved?.model) {
          return `${payload.resolved.modelProvider}/${payload.resolved.model}`
        }
        return ''
      } catch {
        return ''
      }
    },
    enabled: !historyLoading,
    refetchInterval: historyLoading ? false : 30_000,
    retry: false,
  })

  // Fetch the configured reasoning effort so the Chat Controls default matches
  // what Hermes actually uses instead of hardcoding 'medium'.
  const reasoningEffortQuery = useQuery({
    queryKey: ['hermes-config', 'reasoning-effort'],
    queryFn: async () => {
      try {
        const res = await fetch('/api/hermes-config')
        if (!res.ok) return 'medium'
        const data = (await res.json()) as { config?: Record<string, unknown> }
        const agentSection = data?.config?.agent
        if (
          agentSection &&
          typeof agentSection === 'object' &&
          !Array.isArray(agentSection)
        ) {
          const effort = (agentSection as Record<string, unknown>)
            .reasoning_effort
          if (
            effort === 'off' ||
            effort === 'low' ||
            effort === 'medium' ||
            effort === 'high'
          )
            return effort
        }
        return 'medium'
      } catch {
        return 'medium'
      }
    },
    enabled: !historyLoading,
    staleTime: 10 * 60 * 1000,
    retry: false,
  })

  const availableModelIds = useMemo(() => {
    const models = modelsQuery.data?.models || []
    return models.map((m: any) => m.id).filter((id: string) => id)
  }, [modelsQuery.data])

  const gatewayModel = currentModelQuery.data || ''
  // Must match ChatComposer’s modelSessionKey so picker selections are the
  // model actually sent on /api/send-stream (previously the store updated the
  // button label only, while sends always used the gateway/default model).
  const pendingModelKey = pendingSessionModelKey(skillsAgentId)
  const modelSessionKey = isNewChat
    ? pendingModelKey
    : forcedSessionKey ||
      resolvedSessionKey ||
      activeCanonicalKey ||
      activeSessionKey ||
      pendingModelKey
  const sessionModel = useSessionModelStore((s) => s.models[modelSessionKey])
  // When chatting via a per-agent models endpoint, prefer that catalog's
  // currentModel over Hermes session-status (which can still say Kimi).
  const catalogCurrentModel =
    typeof modelsQuery.data?.currentModel === 'string'
      ? modelsQuery.data.currentModel.trim()
      : ''
  const currentModel =
    _localModelOverride ||
    sessionModel ||
    (modelsEndpoint?.trim() ? catalogCurrentModel : '') ||
    gatewayModel

  // Ref so sendMessage can always read latest thinkingLevel without being in deps
  const thinkingLevelRef = useRef<ThinkingLevel>(thinkingLevel)
  useEffect(() => {
    thinkingLevelRef.current = thinkingLevel
  }, [thinkingLevel])

  // Auto-upgrade thinking to adaptive for Claude 4.6 when session first loads
  const thinkingInitializedRef = useRef(false)
  useEffect(() => {
    if (!currentModel) return
    if (thinkingInitializedRef.current) return
    thinkingInitializedRef.current = true
    const is46 =
      currentModel.toLowerCase().includes('4-6') ||
      currentModel.toLowerCase().includes('claude-4.6')
    if (is46) {
      const key = `claude-thinking-${activeFriendlyId || 'new'}`
      const stored =
        typeof window !== 'undefined'
          ? window.sessionStorage.getItem(key)
          : null
      // Only auto-set if not explicitly configured
      if (!stored) {
        setThinkingLevel('adaptive')
      }
    }
  }, [currentModel, activeFriendlyId])

  // If no per-session thinking level override exists, inherit from Hermes config
  useEffect(() => {
    if (thinkingInitializedByUserRef.current) return
    const configEffort = reasoningEffortQuery.data
    if (!configEffort) return
    if (
      configEffort === 'off' ||
      configEffort === 'low' ||
      configEffort === 'medium' ||
      configEffort === 'high'
    ) {
      setThinkingLevel(configEffort)
    }
  }, [reasoningEffortQuery.data])

  // Persist thinking level changes to sessionStorage
  const handleThinkingLevelChange = useCallback(
    (level: ThinkingLevel) => {
      setThinkingLevel(level)
      if (typeof window !== 'undefined') {
        const key = `claude-thinking-${activeFriendlyId || 'new'}`
        window.sessionStorage.setItem(key, level)
      }
    },
    [activeFriendlyId],
  )

  const { suggestion, dismiss, dismissForSession } = useModelSuggestions({
    currentModel, // Real model from session-status (fail closed if empty)
    sessionKey: resolvedSessionKey || 'main',
    messages: historyMessages.map((m: ChatMessage) => ({
      role: m.role as 'user' | 'assistant',
      content: textFromMessage(m),
    })) as any,
    availableModels: availableModelIds,
  })

  const {
    isStreaming: localIsStreaming,
    streamingText: localStreamingText,
    streamingMessageId: localStreamingMessageId,
    streamingRunId: localStreamingRunId,
    startStreaming,
    cancelStreaming,
    handoffActiveStreamForProfileSwitch,
  } = useStreamingMessage({
    pinMainSession:
      activeFriendlyId === 'main' &&
      (resolvedSessionKey || activeFriendlyId || 'main') === 'main',
    onSessionResolved: useCallback(
      ({
        sessionKey,
        friendlyId,
      }: {
        sessionKey: string
        friendlyId: string
      }) => {
        const activeSend = activeSendRef.current
        if (activeSend) {
          activeSendRef.current = {
            ...activeSend,
            sessionKey,
            friendlyId,
          }
        }
        if (
          sessionKey === activeFriendlyId &&
          friendlyId === activeFriendlyId
        ) {
          return
        }
        onSessionResolved?.({ sessionKey, friendlyId })
      },
      [activeFriendlyId, onSessionResolved],
    ),
    onStarted: useCallback(
      ({ runId }: { runId: string | null }) => {
        const activeSend = activeSendRef.current
        if (!activeSend?.clientId) return
        updateHistoryMessageByClientIdEverywhere(
          queryClient,
          activeSend.clientId,
          (message) => ({
            ...message,
            status: 'sent',
            // Clear __optimisticId so isOptimisticUserMessage returns false.
            // Without this the message keeps being treated as pending and
            // gets re-persisted, causing transcript duplication. Fixes #506.
            __optimisticId: undefined,
            runId: runId ?? message.runId,
          }),
        )
        setSending(false)
      },
      [queryClient],
    ),
    onComplete: useCallback(
      (message: ChatMessage) => {
        const activeSend = activeSendRef.current
        if (activeSend?.clientId) {
          updateHistoryMessageByClientIdEverywhere(
            queryClient,
            activeSend.clientId,
            (message) => ({
              ...message,
              status: 'done',
            }),
          )
        }
        // Persist recovery under the same session key the history query reads
        // from. The activeSend key may have been promoted to a backend id during
        // stream resolution, which can differ from the route-friendly session
        // key. Using the history key prevents the completed message from being
        // saved under a key the UI never reads.
        const persistSessionKey = sessionKeyForHistory || activeSend?.sessionKey
        const persistFriendlyId = activeFriendlyId || activeSend?.friendlyId
        if (persistSessionKey && persistFriendlyId) {
          persistRecoveryMessage(persistSessionKey, message)
          // Append the final message to the history cache immediately so it
          // renders without waiting for the next background refetch, which can
          // race with the realtime buffer being cleared.
          appendHistoryMessage(
            queryClient,
            persistFriendlyId,
            persistSessionKey,
            message,
          )
          clearPendingSendForSession(persistSessionKey, persistFriendlyId)
        }
        activeSendRef.current = null
        // Do NOT refetch history here. The streamed message is already in the
        // cache; a post-turn refetch replaces it with a differently shaped
        // server echo (often tools without thinking / rewritten text) and
        // feels like a page reload. Durable sync is deferred/quiet in
        // use-realtime-chat-history onDone + normal poll/focus refetch.
        setSending(false)
        // Clear recovery waiting — busy UI already follows Engine settle.
        streamFinish()
        // Play notification sound if the user opted in (Settings → Chat).
        // Read directly from the store to avoid re-creating this callback on every settings change.
        if (useChatSettingsStore.getState().settings.soundOnChatComplete) {
          playChatComplete()
        }
      },
      [
        queryClient,
        streamFinish,
        sessionKeyForHistory,
        activeFriendlyId,
      ],
    ),
    onError: useCallback(
      (messageText: string) => {
        const activeSend = activeSendRef.current
        if (activeSend?.clientId && !isMissingAuth(messageText)) {
          updateHistoryMessageByClientIdEverywhere(
            queryClient,
            activeSend.clientId,
            (message) => ({
              ...message,
              status: 'error',
            }),
          )
        }
        activeSendRef.current = null
        setSending(false)
        if (isMissingAuth(messageText)) {
          if (canMutateChatRoute) {
            try {
              navigate({ to: '/', replace: true })
            } catch {
              /* router not ready */
            }
          }
          return
        }
        const errorMessage = `Failed to send message. ${messageText}`
        setError(errorMessage)
        toast('Failed to send message', { type: 'error' })
        showErrorToast(messageText)
        const failedSend = activeSendRef.current
        if (failedSend) {
          setPendingGeneration(false, {
            sessionKey: failedSend.sessionKey,
            friendlyId: failedSend.friendlyId,
          })
        }
        setPendingGeneration(false, pendingSessionIdentity)
        setWaitingForResponse(false)
      },
      [canMutateChatRoute, navigate, pendingSessionIdentity, queryClient],
    ),
    onMessageAccepted: useCallback(
      (_sessionKey: string, friendlyId: string, clientId: string) => {
        // HTTP 200 received — server accepted the message. Clear "sending"
        // status immediately so the Retry timer never fires. This is the
        // primary confirmation path since the server does NOT echo user
        // messages back via SSE.
        updateHistoryMessageByClientId(
          queryClient,
          friendlyId,
          _sessionKey,
          clientId,
          (message) => ({
            ...message,
            status: 'queued',
          }),
        )
        updateHistoryMessageByClientIdEverywhere(
          queryClient,
          clientId,
          (message) => ({
            ...message,
            status: 'queued',
          }),
        )
      },
      [queryClient],
    ),
    onAbort: useCallback(() => {
      const abortedSend = activeSendRef.current
      if (abortedSend) {
        setPendingGeneration(false, {
          sessionKey: abortedSend.sessionKey,
          friendlyId: abortedSend.friendlyId,
        })
      }
      setPendingGeneration(false, pendingSessionIdentity)
      activeSendRef.current = null
      setSending(false)
      setWaitingForResponse(false)
    }, [pendingSessionIdentity, setWaitingForResponse]),
    acceptedTimeoutMs: modelsQuery.data?.streamAcceptedTimeoutMs,
    handoffTimeoutMs: modelsQuery.data?.streamHandoffTimeoutMs,
  })

  // Cancel any in-flight stream when the user navigates between sessions or
  // starts a new chat. Without this, an SSE stream from session A keeps
  // running after the user navigates away — and any chunks it had already
  // buffered before our abort takes effect could land in session B (the
  // newly active session). See #297 (cross-session response contamination).
  // Note: useStreamingMessage also has its own generation-token guard for
  // the buffered-chunk race, but cancelling here is the cleaner contract
  // (an in-flight response that the user navigated away from is no longer
  // wanted in either session).
  const navCancelKeyRef = useRef<string | null>(null)
  useEffect(() => {
    registerStreamHandoffHandler(handoffActiveStreamForProfileSwitch)
    return () => registerStreamHandoffHandler(null)
  }, [handoffActiveStreamForProfileSwitch])

  useEffect(() => {
    const navKey = buildChatNavKey({
      profileName: workspaceProfileName,
      canonicalSessionKey: activeCanonicalKey ?? '',
      friendlyId: activeFriendlyId,
      isNewChat,
    })
    const activeSend = activeSendRef.current
    const previousNavKey = navCancelKeyRef.current

    if (
      shouldHandoffStreamOnProfileNav(previousNavKey, navKey) &&
      (localIsStreaming || waitingForResponse)
    ) {
      // Sidebar should have handoff'd already; this is a safety net.
      void handoffActiveStreamForProfileSwitch()
    } else if (
      shouldCancelStreamOnSessionNav({
        previousNavKey,
        nextNavKey: navKey,
        nextFriendlyId: isNewChat ? 'new' : activeFriendlyId,
        activeSendKey: activeSend?.sessionKey || activeSend?.friendlyId,
      })
    ) {
      cancelStreaming()
    }
    navCancelKeyRef.current = navKey
  }, [
    activeCanonicalKey,
    activeFriendlyId,
    cancelStreaming,
    handoffActiveStreamForProfileSwitch,
    isNewChat,
    localIsStreaming,
    waitingForResponse,
    workspaceProfileName,
  ])

  // Phase D: list + busy from Engine (+ submitting overlay). History reconciles
  // into Engine when idle — UI no longer dual-merges history ⊕ chat-store.
  // waitingForResponse / pendingGeneration are recovery-only — never UI busy.
  const {
    chatState: hermesEngineChat,
    interactionResponses: hermesInteractionResponses,
    respondToInteraction: respondHermesInteraction,
  } = useHermesEngineChatState({
    workspaceId: workspaceProfileName || activeProfileName || 'default',
    agentSessionId: resolvedSessionKey,
    profileName: workspaceProfileName || activeProfileName,
    isSubmitting: sending,
    historyMessages,
    historyReady: historyQuery.isSuccess || historyMessages.length > 0,
  })
  const hermesPendingInteractions = hermesEngineChat.interactions
  const hermesTurnBusy = hermesEngineChat.turnBusy
  // Composer / queue / edit: Engine busy + local AbortController + sending.
  // waitingForResponse stays recovery-only.
  const interactionBusy = hermesTurnBusy || localIsStreaming || sending
  // Portable keeps local Abort streaming; Hermes 1:1 chrome follows Engine.
  const activeIsRealtimeStreaming = isPortableMode
    ? localIsStreaming
    : hermesEngineChat.isStreaming || localIsStreaming
  // Portable sticky text bridges empty tool-phase frames. Hermes 1:1 list
  // reads Engine message content — no chat-store streamingText overlay.
  const stickyStreamingTextRef = useRef<{ runId: string | null; text: string }>(
    {
      runId: null,
      text: '',
    },
  )
  if (isPortableMode) {
    stickyStreamingTextRef.current = advanceStickyStreamingText({
      isStreaming: activeIsRealtimeStreaming,
      runId: streamingRunId ?? null,
      rawText: localStreamingText,
      smoothedText: localStreamingText,
      previousState: stickyStreamingTextRef.current,
    })
  }
  const stableActiveStreamingText =
    isPortableMode && activeIsRealtimeStreaming
      ? localStreamingText || stickyStreamingTextRef.current.text
      : ''

  // Hermes 1:1: Engine projection is the list. Portable keeps legacy merge.
  // Identity dedupe is owned by reconcile (turn stamp), not UI text collapse.
  const finalDisplayMessages = useMemo(() => {
    if (!isPortableMode) {
      return hermesEngineChat.messages
        .filter((msg) => {
          if (msg.role === 'user') {
            const text = stripQueuedWrapper(textFromMessage(msg))
            if (text.startsWith('A subagent task')) return false
            return true
          }
          if (msg.role === 'assistant' || msg.role === 'system') {
            return (
              msg.role === 'system' || assistantHasVisibleHostContent(msg)
            )
          }
          return false
        })
        .map((msg) => stripQueuedWrapperFromUserMessage(msg))
    }

    const filtered = realtimeMessages.filter((msg) => {
      if (msg.role === 'user') {
        const text = stripQueuedWrapper(textFromMessage(msg))
        if (text.startsWith('A subagent task')) return false
        return true
      }
      if (msg.role === 'assistant') {
        return assistantHasVisibleHostContent(msg)
      }
      return false
    })

    const sortedForDedup = [...filtered].sort((a, b) => {
      const aRaw = a as Record<string, unknown>
      const bRaw = b as Record<string, unknown>
      const aIsOptimistic =
        normalizeMessageValue(aRaw.__optimisticId).startsWith('opt-') &&
        !normalizeMessageValue(aRaw.id)
      const bIsOptimistic =
        normalizeMessageValue(bRaw.__optimisticId).startsWith('opt-') &&
        !normalizeMessageValue(bRaw.id)
      if (aIsOptimistic && !bIsOptimistic) return 1
      if (!aIsOptimistic && bIsOptimistic) return -1
      return 0
    })

    const seen = new Set<string>()
    const seenByText = new Map<string, ChatMessage>()
    const dedupedSet = new Set<ChatMessage>()
    for (const msg of sortedForDedup) {
      const raw = msg as Record<string, unknown>
      const rawOptimisticId = normalizeMessageValue(raw.__optimisticId)
      const bareOptimisticUuid = rawOptimisticId.startsWith('opt-')
        ? rawOptimisticId.slice(4)
        : ''
      const idCandidates = [
        normalizeMessageValue(raw.id),
        normalizeMessageValue(raw.messageId),
        normalizeMessageValue(raw.clientId),
        normalizeMessageValue(raw.client_id),
        normalizeMessageValue(raw.nonce),
        normalizeMessageValue(raw.idempotencyKey),
        bareOptimisticUuid,
        rawOptimisticId,
      ].filter(Boolean)

      const primaryKey =
        idCandidates.length > 0
          ? `${msg.role}:id:${idCandidates[0]}`
          : `${msg.role}:fallback:${messageFallbackSignature(msg)}`

      if (seen.has(primaryKey)) continue

      const text = stripQueuedWrapper(textFromMessage(msg)).trim()
      if (text.length > 0) {
        const normalizedText = text.replace(/\s+/g, ' ')
        const textKey = `${msg.role}:text:${normalizedText}`
        const existingTextMatch = seenByText.get(textKey)
        if (
          existingTextMatch &&
          shouldCollapseTextDuplicate(existingTextMatch, msg)
        ) {
          const preferred = preferLiveAssistantOnCollision(
            existingTextMatch,
            msg,
            realtimeStreamingMessageId,
          )
          if (preferred === existingTextMatch) {
            continue
          }
          dedupedSet.delete(existingTextMatch)
          seenByText.set(textKey, msg)
        } else if (!existingTextMatch) {
          seenByText.set(textKey, msg)
        }
      }

      seen.add(primaryKey)
      for (const candidate of idCandidates.slice(1)) {
        seen.add(`${msg.role}:id:${candidate}`)
      }
      dedupedSet.add(msg)
    }

    const deduped = filtered
      .filter((msg) => dedupedSet.has(msg))
      .map((msg) => stripQueuedWrapperFromUserMessage(msg))

    let lastUserIndex = -1
    for (let i = deduped.length - 1; i >= 0; i -= 1) {
      if (deduped[i]?.role === 'user') {
        lastUserIndex = i
        break
      }
    }
    const liveId =
      realtimeStreamingMessageId ||
      (() => {
        for (let i = deduped.length - 1; i > lastUserIndex; i -= 1) {
          const row = deduped[i] as {
            role?: string
            __streamingStatus?: string
            messageId?: string
            id?: string
          }
          if (row?.role !== 'assistant') continue
          const id =
            (typeof row.messageId === 'string' && row.messageId.trim()) ||
            (typeof row.id === 'string' && row.id.trim()) ||
            ''
          if (!id) continue
          if (row.__streamingStatus === 'streaming') return id
          if (id.startsWith('assistant:')) return id
        }
        return null
      })()

    if (!liveId) {
      return deduped
    }

    return foldOpenTurnIntoLiveHost(deduped, {
      liveMessageId: liveId,
      isStreaming: activeIsRealtimeStreaming,
      streamingText: stableActiveStreamingText,
      streamingThinking: realtimeStreamingThinking,
      toolCalls: activeToolCalls,
      runId: streamingRunId ?? null,
    })
  }, [
    activeToolCalls,
    activeIsRealtimeStreaming,
    hermesEngineChat.messages,
    isPortableMode,
    realtimeMessages,
    realtimeStreamingMessageId,
    realtimeStreamingThinking,
    stableActiveStreamingText,
    streamingRunId,
  ])

  // Hermes 1:1: Engine streamingMessageId. Portable: local Abort buffer.
  const derivedStreamingInfo = useMemo(() => {
    if (!isPortableMode) {
      return {
        isStreaming: hermesEngineChat.isStreaming || localIsStreaming,
        streamingMessageId:
          hermesEngineChat.streamingMessageId ||
          realtimeStreamingMessageId ||
          null,
      }
    }
    if (!activeIsRealtimeStreaming) {
      return { isStreaming: false, streamingMessageId: null as string | null }
    }
    return {
      isStreaming: true,
      streamingMessageId: localStreamingMessageId,
    }
  }, [
    activeIsRealtimeStreaming,
    hermesEngineChat.isStreaming,
    hermesEngineChat.streamingMessageId,
    isPortableMode,
    localIsStreaming,
    localStreamingMessageId,
    realtimeStreamingMessageId,
  ])

  const responseWaitSnapshotRef = useRef<ResponseWaitSnapshot | null>(null)
  const activeRealtimeStreamingRef = useRef(activeIsRealtimeStreaming)

  useEffect(() => {
    localIsStreamingRef.current = localIsStreaming
  }, [localIsStreaming])

  useEffect(() => {
    activeRealtimeStreamingRef.current = activeIsRealtimeStreaming
  }, [activeIsRealtimeStreaming])

  // Orphaned store streaming: waiting already cleared (or never restored) but
  // streamingState still marks the composer busy. Reconcile against active-run
  // so Stop / idle recover without a full reload.
  useEffect(() => {
    if (!resolvedSessionKey || resolvedSessionKey === 'new') return
    if (localIsStreaming) return
    if (!isRealtimeStreaming) return

    let cancelled = false
    async function clearOrphanedStreaming() {
      try {
        const res = await fetch(
          `/api/sessions/${encodeURIComponent(resolvedSessionKey)}/active-run`,
        )
        if (cancelled || !res.ok) return
        const data = await res.json()
        if (cancelled || !data.ok) return
        if (shouldSettleWaitingFromActiveRun(data.run) === 'keep') return
        useChatStore.getState().clearStreamingSession(resolvedSessionKey)
        setLiveToolActivity([])
        streamFinish()
      } catch {
        // ignore network errors
      }
    }

    const initial = window.setTimeout(() => {
      void clearOrphanedStreaming()
    }, 400)
    const interval = window.setInterval(() => {
      void clearOrphanedStreaming()
    }, 4000)
    return () => {
      cancelled = true
      window.clearTimeout(initial)
      window.clearInterval(interval)
    }
  }, [
    isRealtimeStreaming,
    localIsStreaming,
    resolvedSessionKey,
    streamFinish,
  ])

  useEffect(() => {
    if (!waitingForResponse) {
      responseWaitSnapshotRef.current = null
      return
    }
    if (responseWaitSnapshotRef.current) return
    responseWaitSnapshotRef.current =
      createResponseWaitSnapshot(finalDisplayMessages)
  }, [waitingForResponse, finalDisplayMessages])

  useEffect(() => {
    if (!waitingForResponse) {
      if (clearTimerRef.current) {
        window.clearTimeout(clearTimerRef.current)
        clearTimerRef.current = null
      }
      return
    }
    const snapshot = responseWaitSnapshotRef.current
    if (!snapshot) return
    if (shouldClearWaitingForAssistantMessage(finalDisplayMessages, snapshot)) {
      if (clearTimerRef.current) return
      clearTimerRef.current = window.setTimeout(() => {
        clearTimerRef.current = null
        streamFinish()
      }, 50)
    }
  }, [finalDisplayMessages, waitingForResponse, streamFinish])

  // Note: do not streamFinish() merely because streamingState flickers off.
  // Busy UI is turnBusy / TurnActivityHost; waiting settlement stays on
  // onComplete / shouldClearWaiting / active-run probe / failsafes.

  const handleSwitchModel = useCallback(async () => {
    if (!suggestion) return

    try {
      const res = await fetch('/api/model-switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionKey: resolvedSessionKey || 'main',
          model: suggestion.suggestedModel,
        }),
      })

      if (res.ok) {
        dismiss()
        // Optionally show success toast or update UI
      }
    } catch (err) {
      setError(
        `Failed to switch model. ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }, [suggestion, resolvedSessionKey, dismiss])

  // Sync chat activity to global store for sidebar orchestrator avatar
  const setLocalActivity = useChatActivityStore((s) => s.setLocalActivity) as (
    next: AgentActivity,
  ) => void
  useEffect(() => {
    if (liveToolActivity.length > 0) {
      setLocalActivity('tool-use')
    } else if (activeIsRealtimeStreaming) {
      setLocalActivity('responding')
    } else if (hermesTurnBusy) {
      setLocalActivity('thinking')
    } else {
      setLocalActivity('idle')
    }
  }, [
    hermesTurnBusy,
    activeIsRealtimeStreaming,
    liveToolActivity,
    setLocalActivity,
  ])

  const statusQuery = useQuery({
    queryKey: ['claude', 'status'],
    queryFn: fetchStatus,
    retry: 2,
    retryDelay: 1000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    refetchOnMount: true,
    staleTime: 30_000,
    refetchInterval: 60_000, // Re-check every 60s to clear stale errors
  })
  // Don't show errors for new chats or when SSE is connected
  const statusError =
    !isNewChat && connectionState !== 'connected'
      ? statusQuery.error instanceof Error
        ? {
            message: statusQuery.error.message,
            status: (statusQuery.error as Error & { status?: number }).status,
          }
        : statusQuery.data && !statusQuery.data.ok
          ? {
              message: statusQuery.data.error || 'Hermes Agent unavailable',
              status: statusQuery.data.status,
            }
          : null
      : null
  const serverError = statusError?.message ?? sessionsError ?? historyError
  const serverErrorStatus = statusError?.status
  const showErrorNotice = Boolean(serverError) && !isNewChat
  const handleRefetch = useCallback(() => {
    void statusQuery.refetch({ cancelRefetch: true })
    void sessionsQuery.refetch({ cancelRefetch: true })
    void historyQuery.refetch({ cancelRefetch: true })
  }, [statusQuery, sessionsQuery, historyQuery])

  const handleRefreshHistory = useCallback(() => {
    void historyQuery.refetch({ cancelRefetch: true })
  }, [historyQuery])

  useEffect(() => {
    const handleRefreshRequest = () => {
      void historyQuery.refetch()
    }
    window.addEventListener('claude:chat-refresh', handleRefreshRequest)
    return () => {
      window.removeEventListener('claude:chat-refresh', handleRefreshRequest)
    }
  }, [historyQuery])

  useEffect(() => {
    function handleVisibility() {
      if (document.visibilityState !== 'visible') return
      // Never refetch mid-stream — open-turn authority is write-through.
      // After settle, quiet refetch may stamp server ids; merge prefers live text.
      const key = resolvedSessionKey || sessionKeyForHistory
      if (key && useChatStore.getState().streamingState.has(key)) return
      void historyQuery.refetch()
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () =>
      document.removeEventListener('visibilitychange', handleVisibility)
  }, [historyQuery, resolvedSessionKey, sessionKeyForHistory])

  // Re-mount catch-up for responses finished while away. Skip mid-stream only.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const key = resolvedSessionKey || sessionKeyForHistory
      if (key && useChatStore.getState().streamingState.has(key)) return
      void historyQuery.refetch()
    }, 2000)
    return () => window.clearTimeout(timer)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps -- mount-only

  useEffect(() => {
    function handleSSEDrop() {
      void historyQuery.refetch()
      // Stream dropped while we still show Thinking — settle if the server
      // no longer has an active run (typical after gateway interrupt).
      if (!waitingForResponseRef.current || !resolvedSessionKey) return
      void fetch(
        `/api/sessions/${encodeURIComponent(resolvedSessionKey)}/active-run`,
      )
        .then(async (res) => {
          if (!res.ok) return
          const data = await res.json()
          if (!data.ok) return
          const decision = shouldSettleWaitingFromActiveRun(data.run)
          if (decision === 'keep') return
          streamFinish()
        })
        .catch(() => {
          /* ignore */
        })
    }
    window.addEventListener('claude:sse-dropped', handleSSEDrop)
    return () => {
      window.removeEventListener('claude:sse-dropped', handleSSEDrop)
    }
  }, [historyQuery, resolvedSessionKey, streamFinish])

  const terminalPanelInset =
    !isMobile && isTerminalPanelOpen && !chatFocusMode ? terminalPanelHeight : 0
  // --chat-composer-height is the measured offsetHeight of the composer wrapper,
  // which already includes its own paddingBottom (tab bar + safe area).
  // So content just needs composer-height + a small breathing gap.
  const mobileScrollBottomOffset = useMemo(() => {
    if (!isMobile) return 0
    return 'var(--chat-composer-height, 56px)'
  }, [isMobile])

  // Terminal panel reserves space via main marginBottom (sibling overlay).
  // Do not also pad the scroll content by terminal height — that double-counts
  // and leaves a large empty gap above the composer when the panel is open.
  const stableContentStyle = useMemo<React.CSSProperties>(() => {
    if (isMobile) {
      return {
        paddingBottom: 'calc(var(--chat-composer-height, 56px) + 8px)',
      }
    }
    return { paddingBottom: '16px' }
  }, [isMobile])

  // Re-anchor messages when the desktop terminal panel opens/closes (main margin shifts).
  useEffect(() => {
    if (isMobile) return
    const viewport = document.querySelector('[data-chat-scroll-viewport]')
    if (!(viewport instanceof HTMLElement)) return
    const frameId = window.requestAnimationFrame(() => {
      viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'auto' })
    })
    return () => window.cancelAnimationFrame(frameId)
  }, [isMobile, terminalPanelInset])

  const shouldRedirectToNew =
    hermesChrome &&
    !sessionController &&
    !isPortableMode &&
    !isNewChat &&
    !forcedSessionKey &&
    !isRecentSession(activeFriendlyId) &&
    !hasPendingGeneration(pendingSessionIdentity) &&
    profilesReady &&
    sessionsQuery.isSuccess &&
    !sessionOwnedByProfile

  useEffect(() => {
    if (!hermesChrome || sessionController) return
    if (isRedirecting) {
      if (error) setError(null)
      return
    }
    if (shouldRedirectToNew) {
      if (error) setError(null)
      return
    }
    if (
      sessionsQuery.isSuccess &&
      !activeExists &&
      !sessionsError &&
      !historyError
    ) {
      if (error) setError(null)
      return
    }
    const messageText = sessionsError ?? historyError ?? statusError?.message
    if (!messageText) {
      if (error?.startsWith('Failed to load')) {
        setError(null)
      }
      return
    }
    if (isMissingAuth(messageText) && canMutateChatRoute) {
      navigate({ to: '/', replace: true })
    }
    const message = sessionsError
      ? `Failed to load sessions. ${sessionsError}`
      : historyError
        ? `Failed to load history. ${historyError}`
        : statusError
          ? `Hermes Agent unavailable. ${statusError.message}`
          : null
    if (message) setError(message)
  }, [
    activeExists,
    error,
    statusError,
    historyError,
    hermesChrome,
    sessionController,
    sessionsError,
    sessionsQuery.isSuccess,
    shouldRedirectToNew,
    isRedirecting,
    canMutateChatRoute,
    navigate,
  ])

  useEffect(() => {
    if (!isRedirecting) return
    if (isNewChat) {
      setIsRedirecting(false)
      return
    }
    if (!shouldRedirectToNew && sessionsQuery.isSuccess) {
      setIsRedirecting(false)
    }
  }, [isNewChat, isRedirecting, sessionsQuery.isSuccess, shouldRedirectToNew])

  useEffect(() => {
    if (!canMutateChatRoute) return
    if (isNewChat) return
    if (!shouldRedirectToNew) return
    resetPendingSend()
    clearHistoryMessages(queryClient, activeFriendlyId, sessionKeyForHistory)
    const latestSession = resolveSessionForProfile(
      sessions,
      activeProfileName,
      {
        sessionsLoaded: sessionsQuery.isSuccess,
      },
    )
    const targetSession =
      latestSession === activeFriendlyId &&
      !sessionOwnedByProfile &&
      sessionsQuery.isSuccess
        ? 'new'
        : latestSession
    if (targetSession === activeFriendlyId) return
    writeLastSession(targetSession, activeProfileName)
    navigate({
      to: '/chat/$sessionKey',
      params: { sessionKey: targetSession },
      replace: true,
    })
  }, [
    activeFriendlyId,
    activeProfileName,
    isNewChat,
    navigate,
    queryClient,
    sessionKeyForHistory,
    sessions,
    shouldRedirectToNew,
    canMutateChatRoute,
    sessionsQuery.isSuccess,
    sessionOwnedByProfile,
  ])

  useEffect(() => {
    if (!sessionVerified || isNewChat) return
    writeLastSession(activeFriendlyId, activeProfileName)
  }, [activeFriendlyId, activeProfileName, isNewChat, sessionVerified])

  const hideUi = shouldRedirectToNew || isRedirecting
  const isFocusMode = !compact && chatFocusMode
  const showComposer = !isRedirecting && sessionVerified

  const handleToggleFocusMode = useCallback(() => {
    if (compact) return
    setChatFocusMode(!chatFocusMode)
  }, [chatFocusMode, compact, setChatFocusMode])

  useEffect(() => {
    if (compact && chatFocusMode) {
      setChatFocusMode(false)
    }
  }, [chatFocusMode, compact, setChatFocusMode])

  useEffect(() => {
    if (!chatFocusMode) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      setChatFocusMode(false)
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [chatFocusMode, setChatFocusMode])

  // ⌘. (Mac) / Ctrl+. (Win) to toggle focus mode
  useEffect(() => {
    if (compact) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '.' || !(event.metaKey || event.ctrlKey)) return
      event.preventDefault()
      setChatFocusMode(!chatFocusMode)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [compact, chatFocusMode, setChatFocusMode])

  useEffect(() => {
    return () => {
      useWorkspaceStore.getState().setChatFocusMode(false)
    }
  }, [])

  // Reset state when session changes
  useEffect(() => {
    const resetKey = isNewChat ? 'new' : activeFriendlyId
    if (!resetKey) return
    retriedQueuedMessageKeysRef.current.clear()
    if (pendingStartRef.current) {
      pendingStartRef.current = false
      return
    }
    // Only keep waiting when THIS session still has pending send/generation.
    const identity = {
      sessionKey: resolvedSessionKey,
      friendlyId: resetKey,
    }
    if (
      hasPendingSendForSession(identity) ||
      hasPendingGeneration(identity)
    ) {
      setWaitingForResponse(true)
      return
    }
    streamStop()
    lastAssistantSignature.current = ''
    setWaitingForResponse(false)
  }, [activeFriendlyId, isNewChat, resolvedSessionKey, streamStop])

  /**
   * Simplified sendMessage - fire and forget.
   * Response arrives via SSE stream, not via this function.
   */
  const sendMessage = useCallback(
    function sendMessage(
      sessionKey: string,
      friendlyId: string,
      body: string,
      attachments: Array<ChatAttachment> = [],
      fastMode = false,
      skipOptimistic = false,
      existingClientId = '',
    ) {
      // Read from ref so we always get the latest value without capturing it in deps
      const currentThinkingLevel = thinkingLevelRef.current
      setLocalActivity('reading')
      const normalizedAttachments = attachments.map((attachment) => ({
        ...attachment,
        id: attachment.id ?? crypto.randomUUID(),
      }))

      // Inject text/file attachment content directly into the message body.
      // Servers reliably forward text in the message body; file attachments
      // may be silently dropped for non-image types.
      const textBlocks = normalizedAttachments
        .filter((a) => {
          const mime =
            normalizeMimeType(a.contentType ?? '') ||
            readDataUrlMimeType(a.dataUrl ?? '')
          return !isImageMimeType(mime) && (a.dataUrl ?? '').length > 0
        })
        .map((a) => {
          const raw = a.dataUrl ?? ''
          const content = raw.startsWith('data:')
            ? atob(raw.split(',')[1] ?? '')
            : raw
          return `\n\n<attachment name="${a.name ?? 'file'}">\n${content}\n</attachment>`
        })
      const enrichedBody = body + textBlocks.join('')

      let optimisticClientId = existingClientId
      setResearchResetKey((current) => current + 1)
      if (!skipOptimistic) {
        const { clientId, optimisticMessage } = createOptimisticMessage(
          body,
          normalizedAttachments,
        )
        optimisticClientId = clientId
        appendHistoryMessage(
          queryClient,
          friendlyId,
          sessionKey,
          optimisticMessage,
        )
        updateSessionLastMessage(
          queryClient,
          activeProfileName,
          sessionKey,
          friendlyId,
          optimisticMessage,
        )
      }

      setPendingGeneration(true, { sessionKey, friendlyId })
      setSending(true)
      setError(null)
      clearCompletedStreaming()
      setWaitingForResponse(true)
      activeSendRef.current = {
        sessionKey,
        friendlyId,
        clientId: optimisticClientId,
      }

      // Failsafe: clear waitingForResponse after 120s no matter what
      // Prevents infinite spinner if SSE/idle detection both fail
      if (failsafeTimerRef.current) {
        window.clearTimeout(failsafeTimerRef.current)
      }
      failsafeTimerRef.current = window.setTimeout(() => {
        streamFinish()
      }, 120_000)

      // Send a compatibility shape for attachment parsing.
      // Different server/channel versions read different keys.
      const payloadAttachments = normalizedAttachments.map((attachment) => {
        const mimeType =
          normalizeMimeType(attachment.contentType) ||
          readDataUrlMimeType(attachment.dataUrl)
        const isImage = isImageMimeType(mimeType)
        // For text/file attachments, dataUrl holds raw text (not a base64 data URL).
        // We must base64-encode it so the server can build a valid data: URI.
        const rawDataUrl = attachment.dataUrl ?? ''
        let encodedContent: string
        let finalDataUrl: string
        if (!isImage && !rawDataUrl.startsWith('data:')) {
          encodedContent = btoa(unescape(encodeURIComponent(rawDataUrl)))
          finalDataUrl = mimeType
            ? `data:${mimeType};base64,${encodedContent}`
            : `data:text/plain;base64,${encodedContent}`
        } else {
          encodedContent = stripDataUrlPrefix(rawDataUrl)
          finalDataUrl = rawDataUrl
        }
        return {
          id: attachment.id,
          name: attachment.name,
          fileName: attachment.name,
          contentType: mimeType || undefined,
          mimeType: mimeType || undefined,
          mediaType: mimeType || undefined,
          type: isImage ? 'image' : 'file',
          content: encodedContent,
          data: encodedContent,
          base64: encodedContent,
          dataUrl: finalDataUrl,
          size: attachment.size,
        }
      })
      const history = buildPortableHistory(finalDisplayMessages)

      try {
        streamStart()
      } catch (e) {
        if (import.meta.env.DEV) {
          console.warn('[chat] streamStart error (non-fatal):', e)
        }
      }

      void startStreaming({
        sessionKey,
        friendlyId,
        message: enrichedBody,
        history,
        attachments:
          payloadAttachments.length > 0 ? payloadAttachments : undefined,
        thinking:
          currentThinkingLevel === 'off' ? undefined : currentThinkingLevel,
        fastMode,
        model: currentModel || undefined,
        idempotencyKey: optimisticClientId || crypto.randomUUID(),
        profileName: workspaceProfileName || activeProfileName || undefined,
      }).catch((err: unknown) => {
        const messageText = err instanceof Error ? err.message : String(err)
        if (import.meta.env.DEV) {
          console.warn('[chat] send-stream failed', messageText)
        }
      })
    },
    [
      finalDisplayMessages,
      clearCompletedStreaming,
      queryClient,
      setLocalActivity,
      startStreaming,
      streamFinish,
      streamStart,
      currentModel,
    ],
  )

  useLayoutEffect(() => {
    if (isNewChat) return
    const pending = consumePendingSend(
      isPortableMode
        ? 'main'
        : forcedSessionKey || resolvedSessionKey || activeSessionKey,
      portableChatFriendlyId,
    )
    if (!pending) return
    pendingStartRef.current = true
    const historyKey = chatQueryKeys.history(
      pending.friendlyId,
      pending.sessionKey,
    )
    const cached = queryClient.getQueryData(historyKey)
    const cachedMessages = Array.isArray((cached as any)?.messages)
      ? (cached as any).messages
      : []
    const alreadyHasOptimistic = cachedMessages.some((message: any) => {
      if (pending.optimisticMessage.clientId) {
        if (message.clientId === pending.optimisticMessage.clientId) return true
        if (message.__optimisticId === pending.optimisticMessage.clientId)
          return true
      }
      if (pending.optimisticMessage.__optimisticId) {
        if (message.__optimisticId === pending.optimisticMessage.__optimisticId)
          return true
      }
      return false
    })
    if (!alreadyHasOptimistic) {
      appendHistoryMessage(
        queryClient,
        pending.friendlyId,
        pending.sessionKey,
        pending.optimisticMessage,
      )
    }
    setWaitingForResponse(true)
    sendMessage(
      pending.sessionKey,
      pending.friendlyId,
      pending.message,
      pending.attachments,
      false,
      true,
      typeof pending.optimisticMessage.clientId === 'string'
        ? pending.optimisticMessage.clientId
        : '',
    )
  }, [
    activeSessionKey,
    forcedSessionKey,
    isNewChat,
    isPortableMode,
    portableChatFriendlyId,
    queryClient,
    resolvedSessionKey,
    sendMessage,
  ])

  const retryQueuedMessage = useCallback(
    function retryQueuedMessage(message: ChatMessage, mode: 'manual' | 'auto') {
      if (!isRetryableQueuedMessage(message, mode)) return false

      const body = textFromMessage(message).trim()
      const attachments = getMessageRetryAttachments(message)
      if (body.length === 0 && attachments.length === 0) return false

      const retryKey = getRetryMessageKey(message)
      if (
        mode === 'auto' &&
        retriedQueuedMessageKeysRef.current.has(retryKey)
      ) {
        return false
      }

      const sessionKeyForSend = isPortableMode
        ? 'main'
        : forcedSessionKey || resolvedSessionKey || activeSessionKey || 'main'
      const sessionKeyForMessage = sessionKeyForHistory || sessionKeyForSend
      const existingClientId = getMessageClientId(message)

      if (existingClientId) {
        updateHistoryMessageByClientId(
          queryClient,
          portableChatFriendlyId,
          sessionKeyForMessage,
          existingClientId,
          function markSending(currentMessage) {
            return { ...currentMessage, status: 'sending' }
          },
        )
        updateHistoryMessageByClientIdEverywhere(
          queryClient,
          existingClientId,
          function markSendingEverywhere(currentMessage) {
            return { ...currentMessage, status: 'sending' }
          },
        )
      }

      if (mode === 'auto') {
        retriedQueuedMessageKeysRef.current.add(retryKey)
      }

      sendMessage(
        sessionKeyForSend,
        portableChatFriendlyId,
        body,
        attachments,
        false,
        true,
        existingClientId,
      )
      return true
    },
    [
      activeSessionKey,
      forcedSessionKey,
      isPortableMode,
      portableChatFriendlyId,
      queryClient,
      resolvedSessionKey,
      sessionKeyForHistory,
      sendMessage,
    ],
  )

  const flushRetryableMessages = useCallback(
    function flushRetryableMessages() {
      for (const message of finalDisplayMessages) {
        retryQueuedMessage(message, 'auto')
      }
    },
    [finalDisplayMessages, retryQueuedMessage],
  )

  const handleRetryMessage = useCallback(
    function handleRetryMessage(message: ChatMessage) {
      const retryKey = getRetryMessageKey(message)
      retriedQueuedMessageKeysRef.current.delete(retryKey)
      retryQueuedMessage(message, 'manual')
    },
    [retryQueuedMessage],
  )

  useEffect(() => {
    if (false) {
      // Server connection checks removed — Hermes Agent uses direct API
      hasSeenDisconnectRef.current = true
      retriedQueuedMessageKeysRef.current.clear()
      return
    }

    if (connectionState === 'connected' && hasSeenDisconnectRef.current) {
      hasSeenDisconnectRef.current = false
      flushRetryableMessages()
    }
  }, [connectionState, flushRetryableMessages])

  useEffect(() => {
    if (statusError) {
      hadErrorRef.current = true
      retriedQueuedMessageKeysRef.current.clear()
      return
    }

    const isHealthy = statusQuery.data?.ok === true
    if (isHealthy && hadErrorRef.current) {
      hadErrorRef.current = false
      flushRetryableMessages()
    }
  }, [flushRetryableMessages, statusError, statusQuery.data])

  useEffect(() => {
    function handleHealthRestored() {
      retriedQueuedMessageKeysRef.current.clear()
      hadErrorRef.current = false
      flushRetryableMessages()
      handleRefetch()
    }

    window.addEventListener('claude:health-restored', handleHealthRestored)
    return () => {
      window.removeEventListener('claude:health-restored', handleHealthRestored)
    }
  }, [flushRetryableMessages, handleRefetch])

  const createSessionForMessage = useCallback(
    async (preferredFriendlyId?: string) => {
      setCreatingSession(true)
      try {
        const profile =
          workspaceProfileName || activeProfileName || 'default'
        const runtime = getHermesChatRuntime(profile, {
          profileName: profile,
        })
        // Engine activateSession → POST /api/sessions + agorax_run_mapping.
        const activationId = `activate-${crypto.randomUUID()}`
        const clientSubmitId = crypto.randomUUID()
        const provisionalId = preferredFriendlyId?.trim() || clientSubmitId
        const accepted = runtime.engine.activateSession({
          mode: 'new',
          activationId,
          agentSessionId: provisionalId,
          agentTargetId: 'hermes-native',
          clientSubmitId,
          workspaceId: profile,
          ...(preferredFriendlyId?.trim()
            ? { title: preferredFriendlyId.trim() }
            : {}),
        })
        if (!accepted) {
          throw new Error('Hermes Engine rejected activateSession')
        }

        // Wait briefly for mapping / session to land (effect is async).
        let sessionKey = ''
        let friendlyId = preferredFriendlyId?.trim() || ''
        for (let i = 0; i < 40; i += 1) {
          const mapping = await runtime.getMapping(provisionalId)
          if (mapping?.gatewaySessionId) {
            sessionKey = mapping.gatewaySessionId
            break
          }
          await new Promise((r) => setTimeout(r, 50))
        }
        if (!sessionKey) {
          const snap = runtime.engine.getSnapshot()
          const sessions = Object.values(
            snap.sessionLifecycle.sessionsById ?? {},
          ) as Array<{
            agentSessionId?: string
            providerSessionId?: string | null
          }>
          const found = sessions.find(
            (s) => s.agentSessionId === provisionalId || s.providerSessionId,
          )
          sessionKey =
            found?.providerSessionId?.trim() ||
            found?.agentSessionId?.trim() ||
            ''
        }
        if (!friendlyId) {
          friendlyId = deriveFriendlyIdFromKey(sessionKey) || sessionKey
        }
        if (!sessionKey || !friendlyId) {
          throw new Error('Invalid session response')
        }

        // Re-key mapping to gateway session id for send/cancel lookup.
        await runtime.putMapping({
          agentSessionId: sessionKey,
          turnId: null,
          gatewaySessionId: sessionKey,
          assignmentId: null,
          hermesRunId: null,
          bridgeKind: 'hermes-native',
          updatedAtUnixMs: Date.now(),
        })
        runtime.ensureSessionHydrated(sessionKey)

        setRecentSession(friendlyId)
        queryClient.invalidateQueries({ queryKey: chatQueryKeys.sessions })
        return { sessionKey, friendlyId }
      } finally {
        setCreatingSession(false)
      }
    },
    [queryClient, workspaceProfileName, activeProfileName],
  )

  const upsertSessionInCache = useCallback(
    (friendlyId: string, lastMessage: ChatMessage) => {
      if (!friendlyId) return
      setRecentSession(friendlyId)
      queryClient.setQueryData(
        chatQueryKeys.sessionsForProfile(activeProfileName),
        function upsert(existing: unknown) {
          const sessions = Array.isArray(existing)
            ? (existing as Array<SessionMeta>)
            : []
          const now = Date.now()
          const existingIndex = sessions.findIndex((session) => {
            return (
              session.friendlyId === friendlyId || session.key === friendlyId
            )
          })

          if (existingIndex === -1) {
            return [
              {
                key: friendlyId,
                friendlyId,
                updatedAt: now,
                lastMessage,
                titleStatus: 'idle',
              },
              ...sessions,
            ]
          }

          return sessions.map((session, index) => {
            if (index !== existingIndex) return session
            return {
              ...session,
              updatedAt: now,
              lastMessage,
            }
          })
        },
      )
    },
    [queryClient, activeProfileName, workspaceProfileName],
  )

  const scrollChatToBottom = useCallback(
    (behavior: ScrollBehavior = 'smooth') => {
      const viewport = document.querySelector('[data-chat-scroll-viewport]')
      if (viewport) {
        viewport.scrollTo({ top: viewport.scrollHeight, behavior })
      }
    },
    [],
  )

  const truncateCurrentSession = useCallback(
    async (keepCount: number) => {
      const sessionKey =
        forcedSessionKey ||
        resolvedSessionKey ||
        activeSessionKey ||
        activeFriendlyId
      if (!sessionKey || sessionKey === 'new' || sessionKey === 'main') {
        throw new Error('Open a session first')
      }
      const res = await fetch(
        `/api/sessions/${encodeURIComponent(sessionKey)}/truncate`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            keepCount,
            profileName: workspaceProfileName || activeProfileName || undefined,
          }),
        },
      )
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean
        error?: string
        removedCount?: number
      }
      if (!res.ok || !data.ok) {
        throw new Error(data.error || `Truncate failed (${res.status})`)
      }
      await historyQuery.refetch({ cancelRefetch: true })
      return data.removedCount ?? 0
    },
    [
      activeFriendlyId,
      activeProfileName,
      activeSessionKey,
      forcedSessionKey,
      historyQuery,
      resolvedSessionKey,
      workspaceProfileName,
    ],
  )

  const handleEditMessage = useCallback(
    (message: ChatMessage) => {
      if (!canTruncateSession) {
        toast(UNAVAILABLE_TRUNCATE_MSG, { type: 'error' })
        return
      }
      if (interactionBusy) {
        toast('Wait for the current reply to finish', { type: 'error' })
        return
      }
      const historyIndex = historyIndexOf(message)
      if (historyIndex === null) {
        toast('Cannot edit this message', { type: 'error' })
        return
      }
      const text = textFromMessage(message).trim()
      if (!text) {
        toast('Nothing to edit', { type: 'error' })
        return
      }
      void (async () => {
        try {
          await truncateCurrentSession(keepCountForEdit(historyIndex))
          composerHandleRef.current?.setValue(text)
          toast('Editing — change the text and send', { type: 'success' })
        } catch (err) {
          toast(
            `Edit failed. ${err instanceof Error ? err.message : String(err)}`,
            { type: 'error' },
          )
        }
      })()
    },
    [canTruncateSession, interactionBusy, truncateCurrentSession],
  )

  const handleRegenerateMessage = useCallback(
    (message: ChatMessage) => {
      if (!canTruncateSession) {
        toast(UNAVAILABLE_TRUNCATE_MSG, { type: 'error' })
        return
      }
      if (interactionBusy) {
        toast('Wait for the current reply to finish', { type: 'error' })
        return
      }
      const historyIndex = historyIndexOf(message)
      if (historyIndex === null) {
        toast('Cannot regenerate this message', { type: 'error' })
        return
      }
      const lastUser = findLastUserMessage(finalDisplayMessages)
      const userText = lastUser ? textFromMessage(lastUser).trim() : ''
      if (!userText) {
        toast('No user message to regenerate from', { type: 'error' })
        return
      }
      const sessionKey =
        forcedSessionKey ||
        resolvedSessionKey ||
        activeSessionKey ||
        activeFriendlyId
      const friendlyId = activeFriendlyId || sessionKey
      if (!sessionKey || sessionKey === 'new') {
        toast('Open a session first', { type: 'error' })
        return
      }
      void (async () => {
        try {
          await truncateCurrentSession(keepCountForRegenerate(historyIndex))
          sendMessage(sessionKey, friendlyId, userText, [], false)
        } catch (err) {
          toast(
            `Regenerate failed. ${err instanceof Error ? err.message : String(err)}`,
            { type: 'error' },
          )
        }
      })()
    },
    [
      activeFriendlyId,
      activeIsRealtimeStreaming,
      activeSessionKey,
      canTruncateSession,
      finalDisplayMessages,
      forcedSessionKey,
      interactionBusy,
      resolvedSessionKey,
      sendMessage,
      truncateCurrentSession,
    ],
  )

  const handleUiSlashCommand = useCallback(
    (command: string) => {
      const trimmedCommand = command.trim()
      if (!trimmedCommand.startsWith('/')) return false

      if (trimmedCommand === '/new') {
        // Use the explicit 'new' session sentinel rather than '/chat' alone.
        // The /chat index route redirects to the last-active session via
        // localStorage, so navigating to '/chat' would land in the previous
        // chat instead of opening a fresh one. See #300.
        navigate({ to: '/chat/$sessionKey', params: { sessionKey: 'new' } })
        return true
      }

      if (trimmedCommand === '/clear') {
        const sessionKey =
          forcedSessionKey ||
          resolvedSessionKey ||
          activeSessionKey ||
          activeFriendlyId
        clearHistoryMessages(queryClient, activeFriendlyId, sessionKey)
        toast('Chat cleared', { type: 'success' })
        return true
      }

      if (trimmedCommand === '/model' || trimmedCommand === '/skin') {
        window.dispatchEvent(
          new CustomEvent(CHAT_OPEN_SETTINGS_EVENT, {
            detail: {
              section: trimmedCommand === '/skin' ? 'appearance' : 'claude',
            },
          }),
        )
        return true
      }

      if (trimmedCommand === '/skills') {
        navigate({ to: '/skills' })
        return true
      }

      if (trimmedCommand === '/save') {
        const exported = exportConversationTranscript({
          sessionLabel: activeFriendlyId || 'conversation',
          messages: finalDisplayMessages,
        })
        if (exported) {
          toast('Conversation exported', { type: 'success' })
        }
        return true
      }

      if (trimmedCommand === '/retry') {
        if (!canTruncateSession) {
          toast(UNAVAILABLE_TRUNCATE_MSG, { type: 'error' })
          return true
        }
        if (interactionBusy) {
          toast('Wait for the current reply to finish', { type: 'error' })
          return true
        }
        const lastUser = findLastUserMessage(finalDisplayMessages)
        const historyIndex = lastUser ? historyIndexOf(lastUser) : null
        const userText = lastUser ? textFromMessage(lastUser).trim() : ''
        if (!lastUser || historyIndex === null || !userText) {
          toast('No previous message to retry', { type: 'error' })
          return true
        }
        const sessionKey =
          forcedSessionKey ||
          resolvedSessionKey ||
          activeSessionKey ||
          activeFriendlyId
        const friendlyId = activeFriendlyId || sessionKey
        if (!sessionKey || sessionKey === 'new') {
          toast('Open a session first', { type: 'error' })
          return true
        }
        void (async () => {
          try {
            await truncateCurrentSession(keepCountForEdit(historyIndex))
            sendMessage(sessionKey, friendlyId, userText, [], false)
          } catch (err) {
            toast(
              `Retry failed. ${err instanceof Error ? err.message : String(err)}`,
              { type: 'error' },
            )
          }
        })()
        return true
      }

      if (trimmedCommand === '/undo') {
        if (!canTruncateSession) {
          toast(UNAVAILABLE_TRUNCATE_MSG, { type: 'error' })
          return true
        }
        if (interactionBusy) {
          toast('Wait for the current reply to finish', { type: 'error' })
          return true
        }
        const lastUser = findLastUserMessage(finalDisplayMessages)
        const historyIndex = lastUser ? historyIndexOf(lastUser) : null
        if (historyIndex === null) {
          toast('Nothing to undo', { type: 'error' })
          return true
        }
        void (async () => {
          try {
            const removed = await truncateCurrentSession(
              keepCountForEdit(historyIndex),
            )
            toast(`Undid ${removed} message${removed === 1 ? '' : 's'}`, {
              type: 'success',
            })
          } catch (err) {
            toast(
              `Undo failed. ${err instanceof Error ? err.message : String(err)}`,
              { type: 'error' },
            )
          }
        })()
        return true
      }

      if (trimmedCommand === '/queue' || trimmedCommand.startsWith('/queue ')) {
        const rest = trimmedCommand.slice('/queue'.length).trim()
        const sessionKey =
          forcedSessionKey ||
          resolvedSessionKey ||
          activeSessionKey ||
          activeFriendlyId
        if (!rest) {
          const count =
            sessionKey && sessionKey !== 'new'
              ? queuedMessageCount(sessionKey)
              : 0
          toast(
            count === 0
              ? 'Queue is empty — /queue <text> to add a follow-up'
              : count === 1
                ? '1 message queued'
                : `${count} messages queued`,
            { type: 'info' },
          )
          return true
        }
        if (!sessionKey || sessionKey === 'new') {
          toast('Open a session first', { type: 'error' })
          return true
        }
        const busy = interactionBusy
        if (!busy) {
          sendMessage(
            sessionKey,
            activeFriendlyId || sessionKey,
            rest,
            [],
            false,
          )
          return true
        }
        const entry = enqueueSessionMessage(sessionKey, { text: rest })
        if (!entry) {
          toast('Could not queue message', { type: 'error' })
          return true
        }
        setQueueVersion((version) => version + 1)
        toast(
          `Queued (${queuedMessageCount(sessionKey)}) — sends after this reply`,
          { type: 'success' },
        )
        return true
      }

      if (
        trimmedCommand === '/interrupt' ||
        trimmedCommand.startsWith('/interrupt ')
      ) {
        const rest = trimmedCommand.slice('/interrupt'.length).trim()
        const sessionKey =
          forcedSessionKey ||
          resolvedSessionKey ||
          activeSessionKey ||
          activeFriendlyId
        const busy = interactionBusy
        if (!busy) {
          if (!rest) {
            toast('Nothing to interrupt', { type: 'info' })
            return true
          }
          if (!sessionKey || sessionKey === 'new') {
            toast('Open a session first', { type: 'error' })
            return true
          }
          sendMessage(
            sessionKey,
            activeFriendlyId || sessionKey,
            rest,
            [],
            false,
          )
          return true
        }
        if (rest) {
          if (!sessionKey || sessionKey === 'new') {
            toast('Open a session first', { type: 'error' })
            return true
          }
          // Queue first so drain after cancel picks it up.
          enqueueSessionMessage(sessionKey, { text: rest })
          setQueueVersion((version) => version + 1)
        }
        abortActiveStreamRef.current()
        toast(
          rest
            ? 'Interrupted — queued follow-up will send next'
            : 'Interrupted',
          { type: 'success' },
        )
        return true
      }

      if (trimmedCommand === '/steer' || trimmedCommand.startsWith('/steer ')) {
        const rest = trimmedCommand.slice('/steer'.length).trim()
        if (!rest) {
          toast('Usage: /steer <text>', { type: 'info' })
          return true
        }
        const sessionKey =
          forcedSessionKey ||
          resolvedSessionKey ||
          activeSessionKey ||
          activeFriendlyId
        const runId = localStreamingRunId || streamingRunId || null
        const busy = interactionBusy
        if (!busy || !runId) {
          if (!sessionKey || sessionKey === 'new') {
            toast('Open a session first', { type: 'error' })
            return true
          }
          if (!busy) {
            sendMessage(
              sessionKey,
              activeFriendlyId || sessionKey,
              rest,
              [],
              false,
            )
            return true
          }
          enqueueSessionMessage(sessionKey, { text: rest })
          setQueueVersion((version) => version + 1)
          toast('No live run — queued for next turn', { type: 'info' })
          return true
        }
        void (async () => {
          try {
            const res = await fetch(
              `/api/runs/${encodeURIComponent(runId)}/steer`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: rest, profileName: workspaceProfileName || activeProfileName || undefined }),
              },
            )
            const data = (await res.json().catch(() => ({}))) as {
              ok?: boolean
              error?: string
              fallback?: string
            }
            if (!res.ok || !data.ok) {
              if (sessionKey && sessionKey !== 'new') {
                enqueueSessionMessage(sessionKey, { text: rest })
                setQueueVersion((version) => version + 1)
                toast('Steer unavailable — queued for next turn', {
                  type: 'warning',
                })
                return
              }
              toast(data.error || 'Steer failed', { type: 'error' })
              return
            }
            toast('Steered current reply', { type: 'success' })
          } catch (err) {
            toast(
              `Steer failed. ${err instanceof Error ? err.message : String(err)}`,
              { type: 'error' },
            )
          }
        })()
        return true
      }

      if (
        trimmedCommand === '/compress' ||
        trimmedCommand === '/compact' ||
        trimmedCommand.startsWith('/compress ') ||
        trimmedCommand.startsWith('/compact ')
      ) {
        if (!canCompressSession) {
          toast(UNAVAILABLE_COMPRESS_MSG, { type: 'error' })
          return true
        }
        const focusTopic = trimmedCommand
          .replace(/^\/(?:compress|compact)\s*/i, '')
          .trim()
        const sessionKey =
          forcedSessionKey ||
          resolvedSessionKey ||
          activeSessionKey ||
          activeFriendlyId
        if (!sessionKey || sessionKey === 'new') {
          toast('Open a session first', { type: 'error' })
          return true
        }
        if (interactionBusy) {
          toast('Wait for the current reply to finish', { type: 'error' })
          return true
        }
        setIsCompacting(true)
        void (async () => {
          try {
            const res = await fetch(
              `/api/sessions/${encodeURIComponent(sessionKey)}/compress`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  focusTopic: focusTopic || undefined,
                  keepCount: 6,
                  profileName:
                    workspaceProfileName || activeProfileName || undefined,
                }),
              },
            )
            const data = (await res.json().catch(() => ({}))) as {
              ok?: boolean
              error?: string
              beforeCount?: number
              afterCount?: number
            }
            if (!res.ok || !data.ok) {
              toast(data.error || 'Compress failed', { type: 'error' })
              return
            }
            toast(
              `Compressed ${data.beforeCount ?? '?'} → ${data.afterCount ?? '?'} messages`,
              { type: 'success' },
            )
            refreshHistoryRef.current()
          } catch (err) {
            toast(
              `Compress failed. ${err instanceof Error ? err.message : String(err)}`,
              { type: 'error' },
            )
          } finally {
            setIsCompacting(false)
          }
        })()
        return true
      }

      if (trimmedCommand === '/btw' || trimmedCommand.startsWith('/btw ')) {
        const question = trimmedCommand.slice('/btw'.length).trim()
        if (!question) {
          toast('Usage: /btw <question>', { type: 'info' })
          return true
        }
        const sessionKey =
          forcedSessionKey ||
          resolvedSessionKey ||
          activeSessionKey ||
          activeFriendlyId
        if (!sessionKey || sessionKey === 'new') {
          toast('Open a session first', { type: 'error' })
          return true
        }
        setBtwCard({ question, loading: true })
        void (async () => {
          try {
            const res = await fetch('/api/btw', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                sessionId: sessionKey,
                question,
                profileName: workspaceProfileName || activeProfileName || undefined,
              }),
            })
            const data = (await res.json().catch(() => ({}))) as {
              ok?: boolean
              error?: string
              answer?: string
            }
            if (!res.ok || !data.ok || !data.answer) {
              setBtwCard({
                question,
                loading: false,
                error: data.error || 'Side question failed',
              })
              return
            }
            setBtwCard({ question, answer: data.answer, loading: false })
          } catch (err) {
            setBtwCard({
              question,
              loading: false,
              error: err instanceof Error ? err.message : String(err),
            })
          }
        })()
        return true
      }

      if (
        trimmedCommand === '/bg' ||
        trimmedCommand === '/background' ||
        trimmedCommand.startsWith('/bg ') ||
        trimmedCommand.startsWith('/background ')
      ) {
        const prompt = trimmedCommand
          .replace(/^\/(?:bg|background)\s*/i, '')
          .trim()
        if (!prompt) {
          toast('Usage: /bg <prompt>', { type: 'info' })
          return true
        }
        const sessionKey =
          forcedSessionKey ||
          resolvedSessionKey ||
          activeSessionKey ||
          activeFriendlyId
        if (!sessionKey || sessionKey === 'new') {
          toast('Open a session first', { type: 'error' })
          return true
        }
        void (async () => {
          try {
            const res = await fetch('/api/background', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                sessionId: sessionKey,
                prompt,
                profileName: workspaceProfileName || activeProfileName || undefined,
              }),
            })
            const data = (await res.json().catch(() => ({}))) as {
              ok?: boolean
              error?: string
              taskId?: string
              sessionId?: string
            }
            if (!res.ok || !data.ok || !data.taskId) {
              toast(data.error || 'Background task failed to start', {
                type: 'error',
              })
              return
            }
            setBackgroundTasks((prev) => [
              {
                taskId: data.taskId!,
                status: 'running',
                prompt,
                sessionId: data.sessionId || '',
              },
              ...prev,
            ])
            toast('Background task started', { type: 'success' })
          } catch (err) {
            toast(
              `Background failed. ${err instanceof Error ? err.message : String(err)}`,
              { type: 'error' },
            )
          }
        })()
        return true
      }

      return false
    },
    [
      activeFriendlyId,
      activeIsRealtimeStreaming,
      activeProfileName,
      activeSessionKey,
      canCompressSession,
      canTruncateSession,
      finalDisplayMessages,
      forcedSessionKey,
      localStreamingRunId,
      navigate,
      queryClient,
      resolvedSessionKey,
      interactionBusy,
      sending,
      sendMessage,
      streamingRunId,
      truncateCurrentSession,
      workspaceProfileName,
    ],
  )

  const hermesSlashRuntime = useMemo(
    () => ({
      catalog: HERMES_SLASH_COMMANDS,
      sources: { gatewayCommands: true, skills: true },
      execute: (command: string) => handleUiSlashCommand(command),
    }),
    [handleUiSlashCommand],
  )

  const send = useCallback(
    (
      body: string,
      attachments: Array<ChatComposerAttachment>,
      fastMode: boolean,
      helpers: ChatComposerHelpers,
    ) => {
      const trimmedBody = body.trim()
      if (trimmedBody.length === 0 && attachments.length === 0) return
      if (attachments.length === 0 && handleUiSlashCommand(trimmedBody)) return

      // Deduplicate sends with identical content within a 500ms window.
      // This prevents double-fire from paste events that trigger multiple send paths.
      const sendKey = `${trimmedBody}|${attachments.map((a) => `${a.name}:${a.size}`).join(',')}`
      const now = Date.now()
      if (
        sendKey === lastSendKeyRef.current &&
        now - lastSendAtRef.current < 500
      )
        return
      lastSendKeyRef.current = sendKey
      lastSendAtRef.current = now

      // Haptic feedback on mobile when message is sent
      if (isMobile) hapticTap()

      helpers.reset()

      // Scroll to bottom immediately so user sees their message + incoming response
      requestAnimationFrame(() => scrollChatToBottom('smooth'))

      const attachmentPayload: Array<ChatAttachment> = attachments.map(
        (attachment) => ({
          ...attachment,
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime safety
          id: attachment.id ?? crypto.randomUUID(),
        }),
      )

      if (isNewChat) {
        // In portable mode, use 'main' — no server-side sessions exist.
        // In enhanced mode, create a UUID thread for the sessions API.
        const threadId = isPortableMode ? 'main' : crypto.randomUUID()
        // Promote the draft model pick onto the real session before send so
        // later turns in this thread keep using it.
        useSessionModelStore
          .getState()
          .transferModel(pendingModelKey, threadId)
        const { optimisticMessage } = createOptimisticMessage(
          trimmedBody,
          attachmentPayload,
        )
        appendHistoryMessage(queryClient, threadId, threadId, optimisticMessage)
        upsertSessionInCache(threadId, optimisticMessage)
        setPendingGeneration(true, {
          sessionKey: threadId,
          friendlyId: threadId,
        })
        setSending(true)
        setWaitingForResponse(true)

        const persistLastSession = (friendlyId: string) => {
          writeLastSession(friendlyId, activeProfileName)
        }
        const routeToSession = (friendlyId: string) => {
          if (!canMutateChatRoute) return
          persistLastSession(friendlyId)
          navigate({
            to: '/chat/$sessionKey',
            params: { sessionKey: friendlyId },
            replace: true,
          })
        }
        const launchSend = (sessionKey: string, friendlyId: string) => {
          if (sessionKey !== threadId || friendlyId !== threadId) {
            setRecentSession(friendlyId)
            moveHistoryMessages(
              queryClient,
              threadId,
              threadId,
              friendlyId,
              sessionKey,
            )
            reconcileSessionDraft(
              queryClient,
              activeProfileName,
              threadId,
              threadId,
              friendlyId,
              sessionKey,
            )
            useSessionModelStore.getState().transferModel(threadId, friendlyId)
            routeToSession(friendlyId)
          }
          sendMessage(
            sessionKey,
            friendlyId,
            trimmedBody,
            attachmentPayload,
            fastMode,
            true,
            typeof optimisticMessage.clientId === 'string'
              ? optimisticMessage.clientId
              : '',
          )
        }

        // Route onto the new thread first so the optimistic user message is
        // visible, then wait for the gateway session before streaming.
        // Sending in parallel used to 404; navigating after send used to
        // abort the in-flight SSE (#297 cancel-on-nav).
        routeToSession(threadId)

        if (isPortableMode) {
          launchSend('main', 'main')
          return
        }

        void createSessionForMessage(threadId)
          .then((created) => {
            launchSend(created.sessionKey, created.friendlyId)
          })
          .catch((err: unknown) => {
            if (import.meta.env.DEV) {
              console.warn('[chat] failed to register new thread', err)
            }
            launchSend(threadId, threadId)
          })
        return
      }

      const sessionKeyForSend = isPortableMode
        ? 'main'
        : forcedSessionKey || resolvedSessionKey || activeSessionKey || 'main'
      sendMessage(
        sessionKeyForSend,
        isPortableMode ? 'main' : activeFriendlyId,
        trimmedBody,
        attachmentPayload,
        fastMode,
      )
    },
    [
      activeFriendlyId,
      activeSessionKey,
      activeProfileName,
      canMutateChatRoute,
      createSessionForMessage,
      forcedSessionKey,
      isNewChat,
      isPortableMode,
      navigate,
      onSessionResolved,
      scrollChatToBottom,
      sendMessage,
      upsertSessionInCache,
      queryClient,
      resolvedSessionKey,
      handleUiSlashCommand,
    ],
  )

  const handleAbortStreaming = useCallback(() => {
    if (isMobile) hapticTap()

    const activeSend = activeSendRef.current
    if (activeSend?.clientId) {
      updateHistoryMessageByClientIdEverywhere(
        queryClient,
        activeSend.clientId,
        (message) => ({
          ...message,
          status: 'sent',
        }),
      )
    }
    activeSendRef.current = null
    const stopSessionKey =
      forcedSessionKey ||
      resolvedSessionKey ||
      activeSessionKey ||
      activeFriendlyId ||
      null
    cancelStreaming({
      userStop: true,
      sessionKey: stopSessionKey,
    })
    // Belt-and-suspenders: Stop must clear composer busy even when the hook
    // remounted and activeSessionKeyRef no longer matches the store key.
    if (stopSessionKey) {
      useChatStore.getState().clearStreamingSession(stopSessionKey)
      useChatStore.getState().clearSessionWaiting(stopSessionKey)
    }
    if (activeFriendlyId && activeFriendlyId !== stopSessionKey) {
      useChatStore.getState().clearStreamingSession(activeFriendlyId)
      useChatStore.getState().clearSessionWaiting(activeFriendlyId)
    }
    setLiveToolActivity([])
    clearCompletedStreaming()
    setSending(false)
    streamFinish()
  }, [
    activeFriendlyId,
    activeSessionKey,
    cancelStreaming,
    clearCompletedStreaming,
    forcedSessionKey,
    isMobile,
    queryClient,
    resolvedSessionKey,
    streamFinish,
  ])
  abortActiveStreamRef.current = handleAbortStreaming

  // Poll background tasks while any are running.
  const backgroundRunningCount = backgroundTasks.filter(
    (task) => task.status === 'running',
  ).length
  useEffect(() => {
    const sessionKey =
      forcedSessionKey ||
      resolvedSessionKey ||
      activeSessionKey ||
      activeFriendlyId
    if (!sessionKey || sessionKey === 'new') return
    if (backgroundRunningCount === 0) return

    let cancelled = false
    const poll = async () => {
      try {
        const res = await fetch(
          `/api/background?session_id=${encodeURIComponent(sessionKey)}`,
        )
        if (!res.ok) return
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean
          tasks?: Array<{
            taskId: string
            status: 'running' | 'done' | 'error'
            prompt: string
            sessionId: string
            answer?: string
            error?: string
          }>
        }
        if (cancelled || !data.ok || !data.tasks) return
        setBackgroundTasks(data.tasks)
      } catch {
        // ignore transient poll errors
      }
    }
    void poll()
    const timer = window.setInterval(() => {
      void poll()
    }, 2500)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [
    activeFriendlyId,
    activeSessionKey,
    backgroundRunningCount,
    forcedSessionKey,
    resolvedSessionKey,
  ])

  const queueSessionKey = useMemo(() => {
    if (isNewChat) return ''
    return (
      forcedSessionKey ||
      resolvedSessionKey ||
      activeCanonicalKey ||
      activeSessionKey ||
      activeFriendlyId ||
      ''
    )
  }, [
    activeCanonicalKey,
    activeFriendlyId,
    activeSessionKey,
    forcedSessionKey,
    isNewChat,
    resolvedSessionKey,
  ])

  const queuedCount = useMemo(() => {
    if (!queueSessionKey || queueSessionKey === 'new') return 0
    return queuedMessageCount(queueSessionKey)
    // queueVersion intentionally invalidates the memoized count
    // eslint-disable-next-line react-hooks/exhaustive-deps -- queueVersion is the bump signal
  }, [queueSessionKey, queueVersion])

  const handleQueueFromComposer = useCallback(
    (
      body: string,
      attachments: Array<ChatComposerAttachment>,
      helpers: ChatComposerHelpers,
    ) => {
      if (!queueSessionKey || queueSessionKey === 'new') {
        toast('Open a session first', { type: 'error' })
        return
      }
      const entry = enqueueSessionMessage(queueSessionKey, {
        text: body,
        attachments,
      })
      if (!entry) {
        toast('Could not queue message', { type: 'error' })
        return
      }
      helpers.reset()
      setQueueVersion((version) => version + 1)
      toast(
        `Queued (${queuedMessageCount(queueSessionKey)}) — sends after this reply`,
        { type: 'success' },
      )
    },
    [queueSessionKey],
  )

  const handleClearQueue = useCallback(() => {
    if (!queueSessionKey || queueSessionKey === 'new') return
    clearSessionQueue(queueSessionKey)
    setQueueVersion((version) => version + 1)
    toast('Queue cleared', { type: 'success' })
  }, [queueSessionKey])

  const busyMessageMode = useChatSettingsStore(
    (s) => s.settings.busyMessageMode ?? 'queue',
  )
  const activeSteerRunId = localStreamingRunId || streamingRunId || null
  const canSteer = Boolean(activeSteerRunId)

  const handleSteerFromComposer = useCallback(
    async (
      body: string,
      attachments: Array<ChatComposerAttachment>,
      helpers: ChatComposerHelpers,
    ) => {
      const text = body.trim()
      if (!text && attachments.length === 0) return

      // Attachments aren't supported on the Hermes steer API yet — queue instead.
      if (attachments.length > 0 || !activeSteerRunId) {
        if (!queueSessionKey || queueSessionKey === 'new') {
          toast('Open a session first', { type: 'error' })
          return
        }
        const entry = enqueueSessionMessage(queueSessionKey, {
          text: text || '(attachment)',
          attachments,
        })
        if (entry) {
          helpers.reset()
          setQueueVersion((version) => version + 1)
          toast(
            activeSteerRunId
              ? 'Attachments queued (steer is text-only)'
              : 'No live run — queued for next turn',
            { type: 'info' },
          )
        }
        return
      }

      try {
        const res = await fetch(
          `/api/runs/${encodeURIComponent(activeSteerRunId)}/steer`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              text,
              profileName: workspaceProfileName || activeProfileName || undefined,
            }),
          },
        )
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean
          error?: string
          fallback?: string
        }
        if (!res.ok || !data.ok) {
          if (
            data.fallback === 'queue' ||
            res.status === 409 ||
            !queueSessionKey ||
            queueSessionKey === 'new'
          ) {
            if (queueSessionKey && queueSessionKey !== 'new') {
              enqueueSessionMessage(queueSessionKey, { text })
              setQueueVersion((version) => version + 1)
              helpers.reset()
              toast('Steer unavailable — queued for next turn', {
                type: 'warning',
              })
              return
            }
          }
          toast(data.error || 'Steer failed', { type: 'error' })
          return
        }
        helpers.reset()
        toast('Steered current reply', { type: 'success' })
      } catch (err) {
        toast(
          `Steer failed. ${err instanceof Error ? err.message : String(err)}`,
          { type: 'error' },
        )
      }
    },
    [activeProfileName, activeSteerRunId, queueSessionKey, workspaceProfileName],
  )

  const handleInterruptSendFromComposer = useCallback(
    (
      body: string,
      attachments: Array<ChatComposerAttachment>,
      helpers: ChatComposerHelpers,
    ) => {
      if (!queueSessionKey || queueSessionKey === 'new') {
        toast('Open a session first', { type: 'error' })
        return
      }
      const entry = enqueueSessionMessage(queueSessionKey, {
        text: body,
        attachments,
      })
      if (!entry) {
        toast('Could not queue interrupt message', { type: 'error' })
        return
      }
      helpers.reset()
      setQueueVersion((version) => version + 1)
      abortActiveStreamRef.current()
      toast('Interrupted — follow-up will send next', { type: 'success' })
    },
    [queueSessionKey],
  )

  // Drain one queued follow-up when the current turn becomes idle.
  useEffect(() => {
    const busy = interactionBusy || isCompacting
    if (busy) {
      wasBusyForQueueRef.current = true
      return
    }
    if (!queueSessionKey || queueSessionKey === 'new') return

    const shouldDrain =
      wasBusyForQueueRef.current || mountDrainKeyRef.current !== queueSessionKey
    mountDrainKeyRef.current = queueSessionKey
    wasBusyForQueueRef.current = false
    if (!shouldDrain) return
    if (queuedMessageCount(queueSessionKey) === 0) return

    const next = dequeueSessionMessage(queueSessionKey)
    if (!next) return
    setQueueVersion((version) => version + 1)

    const attachments: Array<ChatAttachment> = (next.attachments ?? []).map(
      (attachment) => ({
        id: attachment.id ?? crypto.randomUUID(),
        name: attachment.name ?? 'file',
        contentType: attachment.contentType ?? 'application/octet-stream',
        size: attachment.size ?? 0,
        dataUrl: attachment.dataUrl,
        previewUrl: attachment.previewUrl,
        kind: attachment.kind,
      }),
    )
    sendMessage(
      queueSessionKey,
      activeFriendlyId || queueSessionKey,
      next.text,
      attachments,
      false,
    )
  }, [
    activeFriendlyId,
    interactionBusy,
    isCompacting,
    queueSessionKey,
    sendMessage,
  ])

  const runPaletteSlashCommand = useCallback(
    (command: string) => {
      const trimmedCommand = command.trim()
      if (!trimmedCommand.startsWith('/')) return
      if (handleUiSlashCommand(trimmedCommand)) return
      send(trimmedCommand, [], false, commandHelpers)
    },
    [commandHelpers, handleUiSlashCommand, send],
  )

  useEffect(() => {
    function handleRunCommand(event: Event) {
      const detail = (event as CustomEvent<ChatRunCommandDetail>).detail
      if (!detail?.command) return
      runPaletteSlashCommand(detail.command)
    }

    window.addEventListener(CHAT_RUN_COMMAND_EVENT, handleRunCommand)
    return () => {
      window.removeEventListener(CHAT_RUN_COMMAND_EVENT, handleRunCommand)
    }
  }, [runPaletteSlashCommand])

  useEffect(() => {
    function handleSubmitSelection(event: Event) {
      const detail = (event as CustomEvent<ChatSubmitSelectionDetail>).detail
      const text = detail?.text?.trim()
      if (!text) return
      send(text, [], false, commandHelpers)
    }

    window.addEventListener(CHAT_SUBMIT_SELECTION_EVENT, handleSubmitSelection)
    return () => {
      window.removeEventListener(
        CHAT_SUBMIT_SELECTION_EVENT,
        handleSubmitSelection,
      )
    }
  }, [commandHelpers, send])

  useEffect(() => {
    const pendingCommand = window.sessionStorage.getItem(
      CHAT_PENDING_COMMAND_STORAGE_KEY,
    )
    if (!pendingCommand) return

    window.sessionStorage.removeItem(CHAT_PENDING_COMMAND_STORAGE_KEY)
    runPaletteSlashCommand(pendingCommand)
  }, [runPaletteSlashCommand])

  useEffect(() => {
    // Managed chat owns its own composer handle via renderMain.
    if (renderMain) return

    const pendingMessage = window.sessionStorage.getItem(
      CHAT_PENDING_MESSAGE_STORAGE_KEY,
    )
    if (!pendingMessage) return

    let attempts = 0
    const tryPrefill = () => {
      if (composerHandleRef.current) {
        window.sessionStorage.removeItem(CHAT_PENDING_MESSAGE_STORAGE_KEY)
        composerHandleRef.current.setValue(pendingMessage)
        return
      }
      attempts += 1
      if (attempts < 20) {
        timer = window.setTimeout(tryPrefill, 50)
      }
    }

    let timer = window.setTimeout(tryPrefill, 0)
    return () => window.clearTimeout(timer)
  }, [activeFriendlyId, renderMain])

  const toggleSidebar = useWorkspaceStore((s) => s.toggleSidebar)

  const handleToggleSidebarCollapse = useCallback(() => {
    toggleSidebar()
  }, [toggleSidebar])

  const handleToggleFileExplorer = useCallback(() => {
    agentChatFrameRef.current?.toggleFileExplorer()
  }, [])

  useEffect(() => {
    function handleToggleFileExplorerFromSearch() {
      handleToggleFileExplorer()
    }

    window.addEventListener(
      SEARCH_MODAL_EVENTS.TOGGLE_FILE_EXPLORER,
      handleToggleFileExplorerFromSearch,
    )
    window.addEventListener(SIDEBAR_TOGGLE_EVENT, handleToggleSidebarCollapse)
    return () => {
      window.removeEventListener(
        SEARCH_MODAL_EVENTS.TOGGLE_FILE_EXPLORER,
        handleToggleFileExplorerFromSearch,
      )
      window.removeEventListener(
        SIDEBAR_TOGGLE_EVENT,
        handleToggleSidebarCollapse,
      )
    }
  }, [handleToggleFileExplorer, handleToggleSidebarCollapse])

  const visibleMessages =
    sessionVerified ||
    Boolean(historyQuery.data) ||
    !historyLoading ||
    finalDisplayMessages.length > 0
      ? finalDisplayMessages
      : []
  const historyEmpty = !historyLoading && visibleMessages.length === 0
  const errorNotice = useMemo(() => {
    if (!showErrorNotice) return null
    if (!serverError) return null
    return (
      <ConnectionStatusMessage
        state="error"
        error={serverError}
        status={serverErrorStatus}
        onRetry={handleRefetch}
      />
    )
  }, [serverError, serverErrorStatus, handleRefetch, showErrorNotice])

  const mobileHeaderStatus: 'connected' | 'connecting' | 'disconnected' =
    connectionState === 'connected'
      ? 'connected'
      : statusQuery.data?.ok === false || statusQuery.isError
        ? 'disconnected'
        : 'connecting'

  const activeHeaderToolName =
    liveToolActivity[0]?.name || activeToolCalls[0]?.name || undefined
  const headerStatusMode: 'idle' | 'sending' | 'streaming' | 'tool' =
    activeHeaderToolName
      ? 'tool'
      : derivedStreamingInfo.isStreaming || localIsStreaming
        ? 'streaming'
        : interactionBusy
          ? 'sending'
          : 'idle'
  const researchCard = useResearchCard({
    sessionKey: resolvedSessionKey || activeCanonicalKey,
    isStreaming: derivedStreamingInfo.isStreaming,
    resetKey: `${resolvedSessionKey || activeCanonicalKey || 'main'}:${researchResetKey}`,
  })

  // Pull-to-refresh offset removed

  const handleOpenAgentDetails = useCallback(() => {
    // agent view panel removed
  }, [])

  const handleRenameActiveSessionTitle = useCallback(
    async (nextTitle: string) => {
      const sessionKey =
        resolvedSessionKey || activeSession?.key || activeSessionKey || ''
      if (!sessionKey) return
      await renameSession(
        sessionKey,
        activeSession?.friendlyId ?? null,
        nextTitle,
      )
    },
    [
      activeSession?.friendlyId,
      activeSession?.key,
      activeSessionKey,
      renameSession,
      resolvedSessionKey,
    ],
  )

  // Listen for mobile header agent-details tap
  useEffect(() => {
    const handler = () => {
      /* agent view removed */
    }
    window.addEventListener('claude:chat-agent-details', handler)
    return () =>
      window.removeEventListener('claude:chat-agent-details', handler)
  }, [])

  return (
    <div
      className={cn(
        'relative min-w-0 flex flex-col overflow-hidden',
        compact ? 'h-full flex-1 min-h-0' : 'h-full w-full',
      )}
      style={{ background: 'var(--theme-bg)' }}
    >
      <div
        className={cn(
          'flex-1 min-h-0 overflow-hidden',
          compact
            ? 'flex min-h-0 w-full flex-col'
            : isMobile
              ? 'flex flex-col'
              : hermesChrome && !hideUi && !isFocusMode
                ? 'grid grid-cols-[auto_minmax(0,1fr)_auto] grid-rows-[minmax(0,1fr)]'
                : 'grid grid-cols-[auto_minmax(0,1fr)] grid-rows-[minmax(0,1fr)]',
        )}
      >
        {compact || isFocusMode || isMobile ? null : (
          <ChatSessionSidebar
            sessions={sessions}
            sessionsLoading={sessionsLoading}
            sessionsFetching={sessionsFetching}
            sessionsError={sessionsError}
            onRetrySessions={refetchSessions}
            activeFriendlyId={sidebarActiveFriendlyId}
            onNewChat={sidebarOnNewChat}
            onActiveSessionDelete={sidebarOnActiveSessionDelete}
            onActivateSession={sessionController?.onActivateSession}
            onRenameSession={sessionController?.onRename}
            onDeleteSession={sessionController?.onDelete}
          />
        )}

        {renderMain ?? (
          <AgentChatFrame
            ref={agentChatFrameRef}
            brand={HERMES_CHAT_BRAND}
            agentName={agentName?.trim() || 'Hermes'}
            agentRuntime={agentRuntime ?? 'hermes'}
            activeTitle={sessionVerified ? activeTitle : '\u00a0'}
            isMobile={isMobile}
            compact={compact}
            hideHeader={compact}
            hideFileExplorer={hideUi || compact || isFocusMode || isMobile}
            composerChrome="bare"
            showComposer={showComposer}
            composerHandleRef={composerHandleRef}
            mainRef={mainRef}
            mainClassName={cn(
              'transition-[margin-bottom] duration-200',
              (hermesTurnBusy ||
                hasPendingGeneration(pendingSessionIdentity)) &&
                'chat-streaming-glow',
            )}
            mainStyle={{
              marginBottom:
                terminalPanelInset > 0 ? `${terminalPanelInset}px` : undefined,
            }}
            headerProps={{
              onRenameTitle: handleRenameActiveSessionTitle,
              renamingTitle: renamingSessionTitle,
              wrapperRef: headerRef,
              onOpenSessions: () => setSessionsOpen(true),
              sessions: sessions ?? [],
              activeFriendlyId,
              onSelectSession: (key) =>
                void navigate({
                  to: '/chat/$sessionKey',
                  params: { sessionKey: key },
                }),
              dataUpdatedAt: historyQuery.dataUpdatedAt,
              onRefresh: handleRefreshHistory,
              agentModel: currentModel,
              agentConnected: mobileHeaderStatus === 'connected',
              onOpenAgentDetails: handleOpenAgentDetails,
              pullOffset: 0,
              statusMode: headerStatusMode,
              activeToolName: activeHeaderToolName,
              thinkingLevel,
              isFocusMode,
              onToggleFocusMode: handleToggleFocusMode,
              onUndo: undefined,
              onClear: undefined,
            }}
            topNotices={
              <>
                {errorNotice && (
                  <div className="sticky top-0 z-20 px-4 py-2">
                    {errorNotice}
                  </div>
                )}
                {hermesChrome && pendingApprovals.length > 0 && (
                  <div className="mx-4 mb-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 dark:border-amber-800/50 dark:bg-amber-900/15">
                    <div className="space-y-2">
                      {pendingApprovals.map((approval) => (
                        <div
                          key={approval.id}
                          className="flex items-center justify-between gap-3"
                        >
                          <div className="min-w-0 flex-1">
                            <p className="text-xs font-semibold text-amber-700 dark:text-amber-400">
                              {'\uD83D\uDD10'} Approval Required -{' '}
                              {approval.agentName || 'Agent'}
                            </p>
                            <p className="mt-0.5 truncate text-xs text-amber-600 dark:text-amber-500">
                              {approval.action}
                            </p>
                            {approval.context ? (
                              <p className="mt-0.5 truncate text-[10px] font-mono text-amber-500 dark:text-amber-600">
                                {approval.context.slice(0, 100)}
                              </p>
                            ) : null}
                          </div>
                          <div className="flex shrink-0 gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                void resolvePendingApproval(
                                  approval,
                                  'approved',
                                )
                              }}
                              className="rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-600"
                            >
                              Approve
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                void resolvePendingApproval(approval, 'denied')
                              }}
                              className="rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30 dark:border-red-800/50 dark:bg-red-900/10 dark:text-red-400"
                            >
                              Deny
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            }
            aboveComposer={
              showComposer ? (
                <>
                  {hermesChrome && hermesPendingInteractions.length > 0 ? (
                    <ManagedAgentInteractionPanel
                      interactions={hermesPendingInteractions}
                      responses={hermesInteractionResponses}
                      onRespond={respondHermesInteraction}
                    />
                  ) : null}
                  {btwCard ? (
                    <div className="px-3 pt-2 md:px-4">
                      <SideQuestionCard
                        question={btwCard.question}
                        answer={btwCard.answer}
                        loading={btwCard.loading}
                        error={btwCard.error}
                        onClose={() => setBtwCard(null)}
                      />
                    </div>
                  ) : null}
                  {backgroundTasks.length > 0 ? (
                    <div className="px-3 pt-2 md:px-4">
                      <BackgroundTasksBadge
                        tasks={backgroundTasks}
                        onOpenSession={(sessionId) => {
                          if (!sessionId) return
                          navigate({
                            to: '/chat/$sessionKey',
                            params: { sessionKey: sessionId },
                          })
                        }}
                      />
                    </div>
                  ) : null}
                </>
              ) : null
            }
            composerProps={{
              onSubmit: send,
              onQueue: handleQueueFromComposer,
              onInterruptSend: handleInterruptSendFromComposer,
              onSteer: handleSteerFromComposer,
              onAbort: handleAbortStreaming,
              isLoading: headerStatusMode !== 'idle',
              disabled: hideUi,
              isCompacting,
              busyMessageMode,
              canSteer,
              queuedCount,
              onClearQueue: handleClearQueue,
              contextRefreshToken: `${resolvedSessionKey || activeSessionKey || 'new'}:${lastCompletedRunAt}:${sending ? 1 : 0}:${waitingForResponse ? 1 : 0}`,
              sessionKey: isNewChat
                ? undefined
                : forcedSessionKey ||
                  resolvedSessionKey ||
                  activeCanonicalKey ||
                  activeSessionKey,
              wrapperRef: composerRef,
              embedded,
              focusKey: `${isNewChat ? 'new' : activeFriendlyId}:${activeCanonicalKey ?? ''}`,
              thinkingLevel,
              onThinkingLevelChange: handleThinkingLevelChange,
              gatewayQueriesEnabled: !historyLoading,
              slashRuntime: hermesSlashRuntime,
              skillsAgentId,
              modelsEndpoint,
              runtimeLabel:
                runtimeLabel?.trim() || agentName?.trim() || undefined,
            }}
          >
            {hideUi ? null : (
              <ChatMessageList
                messages={visibleMessages}
                onRetryMessage={handleRetryMessage}
                onEditMessage={
                  canTruncateSession ? handleEditMessage : undefined
                }
                onRegenerateMessage={
                  canTruncateSession ? handleRegenerateMessage : undefined
                }
                onRefresh={handleRefreshHistory}
                loading={historyLoading}
                empty={historyEmpty}
                emptyState={
                  <ChatEmptyState
                    name={agentName?.trim() || 'Hermes'}
                    runtime={agentRuntime ?? 'hermes'}
                    suggestions={HERMES_CHAT_BRAND.suggestions}
                    compact={compact}
                    onSuggestionClick={(prompt) => {
                      composerHandleRef.current?.setValue(prompt + ' ')
                    }}
                  />
                }
                notice={null}
                noticePosition="end"
                turnBusy={hermesTurnBusy}
                sessionKey={activeCanonicalKey}
                pinToTop={false}
                pinGroupMinHeight={pinGroupMinHeight}
                headerHeight={headerHeight}
                contentStyle={stableContentStyle}
                bottomOffset={isMobile ? mobileScrollBottomOffset : 0}
                isStreaming={derivedStreamingInfo.isStreaming}
                streamingMessageId={derivedStreamingInfo.streamingMessageId}
                // Hermes 1:1: Engine message owns text/thinking/tools.
                // chat-store streaming sidecars are portable-only (dual-source
                // overlays caused Activity/body forks after Phase D).
                streamingText={
                  isPortableMode && activeIsRealtimeStreaming
                    ? stableActiveStreamingText || undefined
                    : undefined
                }
                streamingThinking={
                  isPortableMode && activeIsRealtimeStreaming
                    ? realtimeStreamingThinking || undefined
                    : undefined
                }
                lifecycleEvents={
                  isPortableMode ? realtimeLifecycleEvents : undefined
                }
                hideSystemMessages
                activeToolCalls={isPortableMode ? activeToolCalls : undefined}
                liveToolActivity={isPortableMode ? liveToolActivity : undefined}
                researchCard={researchCard}
                isCompacting={isCompacting}
              />
            )}
          </AgentChatFrame>
        )}

      </div>
      {hermesChrome &&
        !compact &&
        !hideUi &&
        !isMobile &&
        !isFocusMode && <TerminalPanel />}

      {suggestion && (
        <ModelSuggestionToast
          suggestedModel={suggestion.suggestedModel}
          reason={suggestion.reason}
          costImpact={suggestion.costImpact}
          onSwitch={handleSwitchModel}
          onDismiss={dismiss}
          onDismissForSession={dismissForSession}
        />
      )}

      {isMobile && (
        <MobileSessionsPanel
          open={sessionsOpen}
          onClose={() => setSessionsOpen(false)}
          sessions={sessions}
          activeFriendlyId={sidebarActiveFriendlyId}
          onSelectSession={(friendlyId) => {
            setSessionsOpen(false)
            if (sessionController?.onActivateSession) {
              sessionController.onActivateSession({
                key: friendlyId,
                friendlyId,
              })
              return
            }
            void navigate({
              to: '/chat/$sessionKey',
              params: { sessionKey: friendlyId },
            })
          }}
          onNewChat={() => {
            setSessionsOpen(false)
            sidebarOnNewChat()
          }}
        />
      )}

      <ContextAlertModal
        open={alertOpen}
        onClose={dismissAlert}
        threshold={alertThreshold}
        contextPercent={alertPercent}
      />

      <ErrorToastContainer />
    </div>
  )
}
