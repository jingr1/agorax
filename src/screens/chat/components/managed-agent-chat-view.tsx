'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createManagedSlashRuntime } from '../slash-commands/managed'
import { ChatScreen } from '../chat-screen'
import { chatBrandForRuntime } from '../agent-chat-brands'
import { useExternalAgentSessions } from '../hooks/use-external-agent-sessions'
import { useManagedAgentChat } from '../hooks/use-managed-agent-chat'
import { useChatMobile } from '../hooks/use-chat-mobile'
import { CHAT_OPEN_SETTINGS_EVENT, CHAT_PENDING_MESSAGE_STORAGE_KEY } from '../chat-events'
import { ChatEmptyState } from './chat-empty-state'
import { AgentInteractionPanel } from './agent-interaction-panel'
import { AgentChatMessagePane } from './agent-chat-message-pane'
import { AgentChatFrame } from './agent-chat-frame'
import type { AgentActivityComposerOptions, AgentActivitySessionCapabilities } from '@agorax/agent-activity-core'
import type { AgentWithStatus } from '@/lib/agent-types'
import type {
  ChatComposerAttachment,
  ChatComposerHandle,
  ChatComposerHelpers,
} from './chat-composer'
import { resolveAgentAvatarSrc } from '@/lib/agent-avatar'
import { AssistantAvatarProvider } from '@/components/avatars'
import { toast } from '@/components/ui/toast'
import { useChatSettingsStore } from '@/hooks/use-chat-settings'

type ThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'adaptive'

function thinkingStorageKey(sessionId: string | null): string {
  return `claude-code-thinking-${sessionId && !sessionId.startsWith('new-') ? sessionId : 'new'}`
}

function readStoredThinking(sessionId: string | null): ThinkingLevel {
  if (typeof window === 'undefined') return 'medium'
  try {
    const stored = window.sessionStorage.getItem(thinkingStorageKey(sessionId))
    if (
      stored === 'off' ||
      stored === 'low' ||
      stored === 'medium' ||
      stored === 'high' ||
      stored === 'adaptive'
    ) {
      return stored
    }
  } catch {
    /* ignore */
  }
  return 'medium'
}

function getBrand(agent: AgentWithStatus) {
  return chatBrandForRuntime(agent.runtime)
}

function getModelsEndpoint(agentId: string): string {
  // Always agent-scoped. Never fall back to global Hermes /api/models —
  // that made every managed agent look identical.
  return `/api/agents/${encodeURIComponent(agentId)}/models`
}

/**
 * Claude Code / Codex (and future managed runtimes) — same ChatScreen shell
 * (session sidebar) + AgentChatFrame (messages / composer / file explorer).
 */
export function ManagedAgentChatView({
  agent,
  sessionId,
}: {
  agent: AgentWithStatus
  sessionId: string | null
}) {
  const sessionController = useExternalAgentSessions(agent.agentId)
  const chat = useManagedAgentChat({
    agentId: agent.agentId,
    runtime: agent.runtime,
    sessionId,
  })
  const queryClient = useQueryClient()
  const { isMobile } = useChatMobile(queryClient)
  const openModelPickerRef = useRef<(() => void) | null>(null)
  const composerHandleRef = useRef<ChatComposerHandle | null>(null)
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>(() =>
    readStoredThinking(sessionId),
  )
  const busyMessageMode = useChatSettingsStore((state) => state.settings.busyMessageMode)
  const commandsQuery = useQuery({
    queryKey: ['agent-commands', agent.agentId, sessionId],
    queryFn: async ({ signal }) => {
      const query = sessionId && !sessionId.startsWith('new') ? `?sessionId=${encodeURIComponent(sessionId)}` : ''
      const response = await fetch(`/api/agents/${encodeURIComponent(agent.agentId)}/commands${query}`, { signal })
      const payload = await response.json() as { commands: AgentActivityComposerOptions['commands']; capabilities: AgentActivitySessionCapabilities | null; error?: string }
      if (!response.ok) throw new Error(payload.error || 'Failed to load runtime commands')
      return payload
    },
    refetchInterval: 15_000,
  })
  const capabilities = chat.composer.capabilities ?? commandsQuery.data?.capabilities ?? null
  const canSteer = capabilities?.activeTurnGuidance === true
  const canInterrupt = capabilities?.interrupt === true
  const canSubmit = chat.composer.availability !== 'blocked' || chat.composer.blockedReason === 'active_turn'
  const resolvedBusyMode = (busyMessageMode === 'steer' && !canSteer) || (busyMessageMode === 'interrupt' && !canInterrupt) ? 'queue' : busyMessageMode

  useEffect(() => {
    setThinkingLevel(readStoredThinking(sessionId))
  }, [sessionId])

  useEffect(() => {
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
  }, [sessionId, agent.agentId])

  const handleThinkingLevelChange = useCallback(
    (level: ThinkingLevel) => {
      setThinkingLevel(level)
      try {
        window.sessionStorage.setItem(thinkingStorageKey(sessionId), level)
      } catch {
        /* ignore */
      }
    },
    [sessionId],
  )

  const slashRuntime = useMemo(
    () =>
      createManagedSlashRuntime({
        onNew: () => {
          chat.startNewSession()
          toast('New chat', { type: 'success' })
        },
        onClear: () => {
          chat.clearMessages()
          toast('Chat cleared', { type: 'success' })
        },
        onModel: () => {
          window.dispatchEvent(
            new CustomEvent(CHAT_OPEN_SETTINGS_EVENT, {
              detail: { section: 'model' },
            }),
          )
          openModelPickerRef.current?.()
        },
        onHelp: (catalog) => {
          toast(`Commands: ${catalog.map((command) => command.command).join(', ')}`, { type: 'success' })
        },
        onRuntimeCommand: (command) => chat.submit(command, [], { effort: thinkingLevel }),
        onUnavailable: (command) => toast(`${command} is unavailable for this runtime`, { type: 'warning' }),
      }, { capabilities, commands: commandsQuery.data?.commands }),
    [chat.startNewSession, chat.clearMessages, chat.submit, capabilities, commandsQuery.data?.commands, thinkingLevel],
  )

  const handleSubmit = useCallback(
    (
      value: string,
      attachments: Array<ChatComposerAttachment>,
      _fastMode: boolean,
      helpers: ChatComposerHelpers,
    ) => {
      void chat.submit(value, attachments, { effort: thinkingLevel }).then(() => helpers.reset()).catch(() => undefined)
    },
    [chat, thinkingLevel],
  )

  const activeFriendlyId = sessionController.activeFriendlyId
  const isNewChat =
    !sessionId || sessionId === 'new' || activeFriendlyId === 'new'

  const brand = useMemo(() => getBrand(agent), [agent])
  const modelsEndpoint = useMemo(
    () => getModelsEndpoint(agent.agentId),
    [agent.agentId],
  )

  const composerBrand = useMemo(() => {
    const displayName = agent.name.trim() || agent.agentId
    if (agent.runtime === 'codex') {
      return {
        label: displayName,
        hint: `Codex · ${displayName} · ~/.codex/config.toml`,
      }
    }
    if (agent.runtime === 'cursor') {
      return {
        label: displayName,
        hint: `Cursor · ${displayName}`,
      }
    }
    if (agent.runtime === 'opencode') {
      return {
        label: displayName,
        hint: `OpenCode · ${displayName}`,
      }
    }
    return {
      label: displayName,
      hint: `Claude Code · ${displayName} · ~/.claude/settings.json`,
    }
  }, [agent])

  // Capability display comes from the engine session snapshot (canonical),
  // never fabricated: null means the runtime has not reported capabilities.
  const capabilityHint = useMemo(() => {
    const capabilities = chat.composer.capabilities
    if (!capabilities) return 'Capabilities unknown'
    const enabled = [
      capabilities.imageInput ? 'images' : null,
      capabilities.modelSwitch ? 'model switch' : null,
      capabilities.interrupt ? 'interrupt' : null,
      capabilities.planMode ? 'plan mode' : null,
      capabilities.compact ? 'compact' : null,
    ].filter((label): label is string => label !== null)
    return enabled.length > 0 ? `Capabilities: ${enabled.join(' · ')}` : 'No optional capabilities reported'
  }, [chat.composer.capabilities])

  // Always pass contextUsage (including null) so ContextIndicator skips Hermes
  // /api/context-usage polling for managed runtimes.
  const contextUsage = useMemo(() => {
    const usage = chat.usage as
      | { contextWindow?: { usedTokens?: number; totalTokens?: number } | null }
      | null
      | undefined
    const window = usage?.contextWindow
    if (
      !window ||
      typeof window.usedTokens !== 'number' ||
      typeof window.totalTokens !== 'number' ||
      window.totalTokens <= 0
    ) {
      return null
    }
    return {
      usedTokens: window.usedTokens,
      maxTokens: window.totalTokens,
    }
  }, [chat.usage])

  const turnMetaHint = useMemo(() => {
    const fileChanges = chat.fileChanges as
      | { filesChanged?: number; linesAdded?: number; linesRemoved?: number }
      | null
      | undefined
    if (!fileChanges || typeof fileChanges !== 'object') return null
    const files = fileChanges.filesChanged
    const added = fileChanges.linesAdded
    const removed = fileChanges.linesRemoved
    if (
      typeof files !== 'number' &&
      typeof added !== 'number' &&
      typeof removed !== 'number'
    ) {
      return null
    }
    return `Files ${typeof files === 'number' ? files : '—'} · +${typeof added === 'number' ? added : 0}/−${typeof removed === 'number' ? removed : 0}`
  }, [chat.fileChanges])

  return (
    <AssistantAvatarProvider
      value={{
        src: resolveAgentAvatarSrc(agent.runtime),
        alt: agent.name,
      }}
    >
      <ChatScreen
        activeFriendlyId={
          sessionId && !sessionId.startsWith('new-') ? sessionId : 'new'
        }
        isNewChat={isNewChat}
        sessionController={sessionController}
        hermesChrome={false}
        renderMain={
          <AgentChatFrame
            brand={brand}
            agentName={agent.name}
            agentRuntime={agent.runtime}
            activeTitle={chat.activeTitle}
            isMobile={isMobile}
            defaultFileExplorerCollapsed={false}
            fileExplorerStorageKey={`agent-file-explorer:${agent.agentId}`}
            composerChrome="padded"
            composerHandleRef={composerHandleRef}
            composerProps={{
              onSubmit: handleSubmit,
              // Match Hermes: keep composer interactive while streaming so the
              // primary control becomes the red Stop button (via isLoading).
              isLoading: chat.isStreaming,
              // Engine-owned submit admission: blocked while the runtime
              // reports unavailable or a pending interaction holds the turn.
              disabled: !canSubmit,
              queuedCount: chat.composer.queuedCount,
              onClearQueue: chat.clearQueue,
              onQueue: canSubmit ? (value, attachments, helpers) => {
                void chat.submit(value, attachments, { effort: thinkingLevel, mode: 'queue' }).then(() => helpers.reset()).catch(() => undefined)
              } : undefined,
              onSteer: canSubmit && canSteer ? (value, attachments, helpers) => {
                return chat.submit(value, attachments, { effort: thinkingLevel, mode: 'steer' }).then(() => helpers.reset()).catch(() => undefined)
              } : undefined,
              onInterruptSend: canSubmit && canInterrupt ? (value, attachments, helpers) => {
                void chat.submit(value, attachments, { effort: thinkingLevel, mode: 'interrupt' }).then(() => helpers.reset()).catch(() => undefined)
              } : undefined,
              busyMessageMode: resolvedBusyMode,
              canSteer,
              runtimeCapabilities: capabilities,
              clearDraftOnSubmit: false,
              onAbort: chat.abort,
              sessionKey: chat.activeSessionId,
              embedded: true,
              modelsEndpoint,
              // OpenCode model ids are already `provider/model` (e.g.
              // `opencode/exo-free`); Claude Code / Codex / Cursor need bare ids.
              modelKeyMode:
                agent.runtime === 'opencode' ? 'provider-prefixed' : 'bare',
              gatewayQueriesEnabled: false,
              slashRuntime,
              skillsAgentId: agent.agentId,
              thinkingLevel,
              onThinkingLevelChange: handleThinkingLevelChange,
              runtimeLabel: composerBrand.label,
              runtimeConfigHint: `${composerBrand.hint} · ${capabilityHint}`,
              contextUsage,
            }}
            topNotices={
              <>
                {commandsQuery.error ? (
                  <div role="status" className="my-2 mx-4 text-xs text-warning">
                    Commands unavailable: {commandsQuery.error.message}
                  </div>
                ) : null}
                {chat.error ? (
                  <div className="my-2 mx-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
                    {chat.error}
                  </div>
                ) : null}
                {turnMetaHint ? (
                  <div className="my-2 mx-4 text-[11px] text-muted-foreground">
                    {turnMetaHint}
                  </div>
                ) : null}
              </>
            }
            // Tutti docks interactive prompts above the composer
            // (composerFloatingPrompt / bottom dock), not above the transcript.
            aboveComposer={
              <AgentInteractionPanel
                interactions={chat.interactions.filter(
                  (interaction) => interaction.status === 'pending',
                )}
                responses={chat.interactionResponses}
                onRespond={chat.respondToInteraction}
              />
            }
          >
            <AgentChatMessagePane
              messages={chat.messages}
              turnBusy={chat.turnBusy}
              isStreaming={chat.isStreaming}
              streamingMessageId={chat.streamingMessageId}
              activeToolCalls={chat.activeToolCalls}
              sessionKey={chat.activeSessionId}
              emptyState={
                <ChatEmptyState
                  name={agent.name}
                  runtime={agent.runtime}
                  suggestions={brand.suggestions}
                  compact={isMobile}
                  onSuggestionClick={(prompt) =>
                    void chat.submit(prompt, [], { effort: thinkingLevel }).catch(() => undefined)
                  }
                />
              }
            />
          </AgentChatFrame>
        }
      />
    </AssistantAvatarProvider>
  )
}
