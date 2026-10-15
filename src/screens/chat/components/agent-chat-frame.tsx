'use client'

import {
  Suspense,
  lazy,
  useCallback,
  useImperativeHandle,
  useRef,
  useState,
  forwardRef,
  type ReactNode,
  type Ref,
} from 'react'
import { cn } from '@/lib/utils'
import { ChatHeader } from './chat-header'
import { ChatEmptyState } from './chat-empty-state'
import { ChatComposer } from './chat-composer'
import type {
  ChatComposerAttachment,
  ChatComposerHandle,
  ChatComposerHelpers,
  ThinkingLevel,
} from './chat-composer'
import type { ContextUsageOverride } from './context-indicator'
import type { BusyMessageMode } from '@/screens/chat/lib/composer-primary-action'
import type { AgentChatBrand } from '../agent-chat-brands'
import type { SlashCommandRuntime } from '../slash-commands/types'
import {
  ChatContainerContent,
  ChatContainerRoot,
  ChatContainerScrollAnchor,
} from '@/components/prompt-kit/chat-container'

const FileExplorerSidebar = lazy(async () => {
  const module = await import('@/components/file-explorer')
  return { default: module.FileExplorerSidebar }
})

export type AgentChatFrameHandle = {
  toggleFileExplorer: () => void
  insertReference: (reference: string) => void
}

export type AgentChatFrameProps = {
  brand: AgentChatBrand
  /** Agent display name for the new-session empty state. */
  agentName: string
  /** Runtime / provider for empty-state avatar. */
  agentRuntime?: string | null
  activeTitle: string
  isMobile?: boolean
  compact?: boolean
  hideHeader?: boolean
  hideFileExplorer?: boolean
  /** Override collapse; when omitted Frame owns state. */
  defaultFileExplorerCollapsed?: boolean
  fileExplorerStorageKey?: string
  headerExtra?: ReactNode
  topNotices?: ReactNode
  children?: ReactNode
  /** Convenience empty state when there is no message list yet. */
  showEmpty?: boolean
  onSuggestionClick?: (prompt: string) => void
  aboveComposer?: ReactNode
  showComposer?: boolean
  /** Hermes composer is self-padded; managed uses a surface chrome. */
  composerChrome?: 'bare' | 'padded'
  composerProps: {
    onSubmit: (
      value: string,
      attachments: Array<ChatComposerAttachment>,
      fastMode: boolean,
      helpers: ChatComposerHelpers,
    ) => void
    isLoading: boolean
    disabled?: boolean
    onAbort?: () => void
    sessionKey?: string
    embedded?: boolean
    modelsEndpoint?: string
    modelKeyMode?: 'provider-prefixed' | 'bare'
    gatewayQueriesEnabled?: boolean
    slashRuntime?: SlashCommandRuntime
    skillsAgentId?: string
    thinkingLevel?: ThinkingLevel
    onThinkingLevelChange?: (level: ThinkingLevel) => void
    runtimeLabel?: string
    runtimeConfigHint?: string
    onQueue?: (
      value: string,
      attachments: Array<ChatComposerAttachment>,
      helpers: ChatComposerHelpers,
    ) => void
    onInterruptSend?: (
      value: string,
      attachments: Array<ChatComposerAttachment>,
      helpers: ChatComposerHelpers,
    ) => void
    onSteer?: (
      value: string,
      attachments: Array<ChatComposerAttachment>,
      helpers: ChatComposerHelpers,
    ) => void | Promise<void>
    isCompacting?: boolean
    busyMessageMode?: BusyMessageMode
    canSteer?: boolean
    contextRefreshToken?: string | number
    contextUsage?: ContextUsageOverride | null
    queuedCount?: number
    onClearQueue?: () => void
    focusKey?: string
    wrapperRef?: Ref<HTMLDivElement>
  }
  headerProps?: Partial<React.ComponentProps<typeof ChatHeader>>
  composerHandleRef?: Ref<ChatComposerHandle | null>
  mainRef?: Ref<HTMLDivElement | null>
  className?: string
  mainClassName?: string
  mainStyle?: React.CSSProperties
}

/**
 * Shared agent chat chrome: Header → empty/list → Composer + right file sidebar.
 * Does not own Hermes Terminal / Approvals.
 */
export const AgentChatFrame = forwardRef<
  AgentChatFrameHandle,
  AgentChatFrameProps
>(function AgentChatFrame(
  {
    brand,
    agentName,
    agentRuntime,
    activeTitle,
    isMobile = false,
    compact = false,
    hideHeader = false,
    hideFileExplorer = false,
    defaultFileExplorerCollapsed,
    fileExplorerStorageKey = 'claude-file-explorer-collapsed',
    headerExtra,
    topNotices,
    children,
    showEmpty = false,
    onSuggestionClick,
    aboveComposer,
    showComposer = true,
    composerChrome = 'bare',
    composerProps,
    headerProps,
    composerHandleRef: externalComposerRef,
    mainRef,
    className,
    mainClassName,
    mainStyle,
  },
  ref,
) {
  const internalComposerRef = useRef<ChatComposerHandle | null>(null)
  const setComposerRef = useCallback(
    (handle: ChatComposerHandle | null) => {
      internalComposerRef.current = handle
      if (typeof externalComposerRef === 'function') {
        externalComposerRef(handle)
      } else if (externalComposerRef && 'current' in externalComposerRef) {
        ;(
          externalComposerRef as { current: ChatComposerHandle | null }
        ).current = handle
      }
    },
    [externalComposerRef],
  )

  const [fileExplorerCollapsed, setFileExplorerCollapsed] = useState(() => {
    if (typeof defaultFileExplorerCollapsed === 'boolean') {
      return defaultFileExplorerCollapsed
    }
    if (typeof window === 'undefined') return true
    const stored = localStorage.getItem(fileExplorerStorageKey)
    return stored === null ? true : stored === 'true'
  })

  const toggleFileExplorer = useCallback(() => {
    setFileExplorerCollapsed((prev) => {
      const next = !prev
      if (typeof window !== 'undefined') {
        localStorage.setItem(fileExplorerStorageKey, String(next))
      }
      return next
    })
  }, [fileExplorerStorageKey])

  const insertReference = useCallback((reference: string) => {
    internalComposerRef.current?.insertText(reference)
  }, [])

  useImperativeHandle(
    ref,
    () => ({
      toggleFileExplorer,
      insertReference,
    }),
    [toggleFileExplorer, insertReference],
  )

  const showFilesColumn = !hideFileExplorer && !compact && !isMobile

  const composer = showComposer ? (
    <ChatComposer
      {...composerProps}
      disabled={composerProps.disabled ?? false}
      composerRef={setComposerRef}
    />
  ) : null

  return (
    <div
      className={cn(
        'relative flex h-full min-w-0 flex-1 flex-col overflow-hidden',
        className,
      )}
    >
      <div
        className={cn(
          'flex-1 min-h-0 overflow-hidden',
          isMobile || !showFilesColumn
            ? 'flex min-h-0 w-full flex-col'
            : 'grid grid-cols-[minmax(0,1fr)_auto] grid-rows-[minmax(0,1fr)]',
        )}
      >
        <main
          ref={mainRef as Ref<HTMLElement>}
          className={cn(
            'relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden',
            mainClassName,
          )}
          style={mainStyle}
        >
          {!hideHeader && (
            <ChatHeader
              {...headerProps}
              activeTitle={activeTitle}
            />
          )}
          {headerExtra}
          {topNotices}
          <div className="relative flex min-h-0 flex-1 flex-col">
            {showEmpty ? (
              <ChatContainerRoot className="flex-1">
                <ChatContainerContent className="flex h-full flex-col px-4 py-4">
                  <ChatEmptyState
                    name={agentName}
                    runtime={agentRuntime}
                    suggestions={brand.suggestions}
                    compact={compact || isMobile}
                    onSuggestionClick={onSuggestionClick}
                  />
                  <ChatContainerScrollAnchor />
                </ChatContainerContent>
              </ChatContainerRoot>
            ) : (
              children
            )}
            {aboveComposer}
            {composerChrome === 'padded' && composer ? (
              <div className="shrink-0 bg-surface px-4 py-3">{composer}</div>
            ) : (
              composer
            )}
          </div>
        </main>

        {showFilesColumn ? (
          <Suspense fallback={null}>
            <FileExplorerSidebar
              collapsed={fileExplorerCollapsed}
              onToggle={toggleFileExplorer}
              onInsertReference={insertReference}
              side="right"
              className="min-w-0"
            />
          </Suspense>
        ) : null}
      </div>
    </div>
  )
})
