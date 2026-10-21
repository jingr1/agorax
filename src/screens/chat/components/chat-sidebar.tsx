import { HugeiconsIcon } from '@hugeicons/react'
import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  Moon02Icon,
  Search01Icon,
  Settings01Icon,
  Sun02Icon,
} from '@hugeicons/core-free-icons'
import { AnimatePresence, motion } from 'motion/react'
import { lazy, memo, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useRouterState } from '@tanstack/react-router'
import { CHAT_OPEN_SETTINGS_EVENT } from '../chat-events'
import { useChatSettings as useSidebarSettings } from '../hooks/use-chat-settings'
import type { ChatOpenSettingsDetail } from '../chat-events'
import { t } from '@/lib/i18n'

// Settings UI pulls the provider screens into the first module graph.
// Load it only when a dialog actually opens so the shell can start on a
// high-latency Tailscale link.
const SettingsDialog = lazy(() =>
  import('@/components/settings-dialog').then((m) => ({
    default: m.SettingsDialog,
  })),
)
const ProvidersDialog = lazy(() =>
  import('./providers-dialog').then((m) => ({
    default: m.ProvidersDialog,
  })),
)
import {
  TooltipContent,
  TooltipProvider,
  TooltipRoot,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { Button, buttonVariants } from '@/components/ui/button'
import { UserAvatar } from '@/components/avatars'
import { SEARCH_MODAL_EVENTS, useSearchModal } from '@/hooks/use-search-modal'
import {
  selectChatProfileAvatarDataUrl,
  selectChatProfileDisplayName,
  selectSidebarHoverExpand,
  useChatSettingsStore,
} from '@/hooks/use-chat-settings'
import { StatusDot } from '@/components/status-indicator'
import { applyTheme, useSettingsStore } from '@/hooks/use-settings'
import { setTheme, type ThemeId } from '@/lib/theme'
import { NAV_ITEMS } from '@/lib/nav-registry'

/** Tutti-adjacent nav chrome: slightly heavier stroke than Hugeicons default. */
const NAV_ICON_STROKE = 2
const NAV_ICON_SIZE = 20

type WorkspaceStats = Record<string, unknown>

function ThemeToggleMini() {
  const _theme = useSettingsStore((state) => state.settings.theme)
  const updateSettings = useSettingsStore((state) => state.updateSettings)
  void _theme
  // Detect dark/light from actual data-theme attribute
  const currentDataTheme =
    typeof document !== 'undefined'
      ? document.documentElement.getAttribute('data-theme') || 'claude-nous'
      : 'claude-nous'
  const isDark = !currentDataTheme.endsWith('-light')

  // Map between dark and light counterparts — must include all theme families
  const LIGHT_DARK_PAIRS: Record<string, string> = {
    'claude-nous': 'claude-nous-light',
    'claude-nous-light': 'claude-nous',
    'claude-official': 'claude-official-light',
    'claude-official-light': 'claude-official',
    'claude-classic': 'claude-classic-light',
    'claude-classic-light': 'claude-classic',
    'claude-slate': 'claude-slate-light',
    'claude-slate-light': 'claude-slate',
    webui: 'default-light',
    'webui-light': 'default',
    default: 'default-light',
    'default-light': 'default',
  }

  return (
    <button
      type="button"
      onClick={() => {
        // Fall back to current family rather than dropping the user into claude-official
        const nextDataTheme =
          LIGHT_DARK_PAIRS[currentDataTheme] ||
          (isDark
            ? `${currentDataTheme}-light`
            : currentDataTheme.replace(/-light$/, ''))
        setTheme(nextDataTheme as ThemeId)
        // Also update settings hook
        const nextMode = nextDataTheme.endsWith('-light') ? 'light' : 'dark'
        applyTheme(nextMode)
        updateSettings({ theme: nextMode })
      }}
      className="shrink-0 rounded-lg p-1.5 transition-colors hover:opacity-80"
      style={{ color: 'var(--theme-muted)' }}
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
    >
      <HugeiconsIcon
        icon={isDark ? Sun02Icon : Moon02Icon}
        size={16}
        strokeWidth={NAV_ICON_STROKE}
      />
    </button>
  )
}

type ChatSidebarProps = {
  activeFriendlyId: string
  creatingSession: boolean
  onCreateSession: () => void
  isCollapsed: boolean
  onToggleCollapse: () => void
  onSelectSession?: () => void
  onActiveSessionDelete?: () => void
}

// ── Reusable nav item ───────────────────────────────────────────────────

type NavItemDef = {
  kind: 'link' | 'button'
  to?: string
  search?: Record<string, unknown>
  hash?: string
  icon: unknown
  label: string
  active: boolean
  onClick?: () => void
  disabled?: boolean
  badge?: 'error-dot' | string | number
  dataTour?: string
}

export async function fetchWorkspaceStats(): Promise<WorkspaceStats | null> {
  try {
    const response = await fetch('/api/workspace/stats')
    if (!response.ok) return null
    return (await response.json()) as WorkspaceStats
  } catch {
    return null
  }
}

export async function fetchWorkspaceProjectShortcuts(): Promise<Array<never>> {
  return []
}

function NavItem({
  item,
  isCollapsed,
  transition,
  onSelectSession,
}: {
  item: NavItemDef
  isCollapsed: boolean
  transition: Record<string, unknown>
  onSelectSession?: () => void
}) {
  const cls = cn(
    buttonVariants({ variant: 'ghost', size: 'sm' }),
    'w-full h-auto min-h-11 gap-2.5 rounded-lg py-2 md:min-h-0',
    isCollapsed ? 'justify-center px-0' : 'justify-start px-3',
    item.active
      ? 'bg-[var(--theme-input)] text-[var(--theme-accent)] hover:bg-[var(--theme-card2)]'
      : 'text-[var(--theme-muted)] hover:bg-[var(--transparency-hover)] hover:text-[var(--theme-text)]',
  )

  const iconEl =
    item.badge === 'error-dot' ? (
      <span className="relative inline-flex size-5 shrink-0 items-center justify-center">
        <HugeiconsIcon
          icon={item.icon as any}
          size={NAV_ICON_SIZE}
          strokeWidth={NAV_ICON_STROKE}
          className="size-5 shrink-0"
        />
        <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-red-500" />
      </span>
    ) : (
      <HugeiconsIcon
        icon={item.icon as any}
        size={NAV_ICON_SIZE}
        strokeWidth={NAV_ICON_STROKE}
        className="size-5 shrink-0"
      />
    )

  const labelEl = (
    <AnimatePresence initial={false} mode="wait">
      {!isCollapsed ? (
        <motion.span
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={transition}
          className="flex min-w-0 items-center gap-2"
        >
          <span className="overflow-hidden whitespace-nowrap">
            {item.label}
          </span>
          {item.badge && item.badge !== 'error-dot' ? (
            <span
              className="ml-auto inline-flex min-w-6 items-center justify-center rounded-full px-2 py-0.5 text-[10px] font-bold leading-none"
              style={
                item.badge === 'NEW'
                  ? {
                      background:
                        'linear-gradient(180deg, #fde68a 0%, #fbbf24 50%, #d4a017 100%)',
                      color: '#0b1320',
                      boxShadow: '0 0 8px rgba(250,204,21,0.4)',
                      letterSpacing: '0.08em',
                    }
                  : undefined
              }
            >
              {item.badge}
            </span>
          ) : null}
        </motion.span>
      ) : null}
    </AnimatePresence>
  )

  const handleSelect = () => {
    onSelectSession?.()
  }

  if (item.kind === 'link') {
    if (isCollapsed) {
      return (
        <TooltipProvider>
          <TooltipRoot>
            <TooltipTrigger
              render={
                <Link
                  to={item.to}
                  search={item.search as any}
                  hash={item.hash}
                  onClick={handleSelect}
                  className={cls}
                  data-tour={item.dataTour}
                >
                  {iconEl}
                </Link>
              }
            />
            <TooltipContent side="right">{item.label}</TooltipContent>
          </TooltipRoot>
        </TooltipProvider>
      )
    }
    return (
      <Link
        to={item.to}
        search={item.search as any}
        hash={item.hash}
        onClick={handleSelect}
        className={cls}
        data-tour={item.dataTour}
      >
        {iconEl}
        {labelEl}
      </Link>
    )
  }

  if (isCollapsed) {
    return (
      <TooltipProvider>
        <TooltipRoot>
          <TooltipTrigger
            render={
              <Button
                disabled={item.disabled}
                variant="ghost"
                size="sm"
                onClick={() => {
                  item.onClick?.()
                  handleSelect()
                }}
                className={cls}
                data-tour={item.dataTour}
              >
                {iconEl}
              </Button>
            }
          />
          <TooltipContent side="right">{item.label}</TooltipContent>
        </TooltipRoot>
      </TooltipProvider>
    )
  }

  return (
    <Button
      disabled={item.disabled}
      variant="ghost"
      size="sm"
      onClick={() => {
        item.onClick?.()
        handleSelect()
      }}
      className={cls}
      data-tour={item.dataTour}
    >
      {iconEl}
      {labelEl}
    </Button>
  )
}

function NavList({
  items,
  isCollapsed,
  transition,
  onSelectSession,
}: {
  items: Array<NavItemDef>
  isCollapsed: boolean
  transition: Record<string, unknown>
  onSelectSession?: () => void
}) {
  return (
    <div className="space-y-0.5">
      {items.map((item) => (
        <motion.div
          key={item.label}
          layout
          transition={{ layout: transition }}
          className="w-full"
        >
          <NavItem
            item={item}
            isCollapsed={isCollapsed}
            transition={transition}
            onSelectSession={onSelectSession}
          />
        </motion.div>
      ))}
    </div>
  )
}

// ── Main component ──────────────────────────────────────────────────────

function ChatSidebarComponent({
  activeFriendlyId,
  isCollapsed,
  onToggleCollapse,
  onSelectSession,
  onActiveSessionDelete: _onActiveSessionDelete,
}: ChatSidebarProps) {
  const { settingsOpen, settingsSection, setSettingsOpen, handleOpenSettings } =
    useSidebarSettings()
  const profileDisplayName = useChatSettingsStore(selectChatProfileDisplayName)
  const profileAvatarDataUrl = useChatSettingsStore(
    selectChatProfileAvatarDataUrl,
  )
  const openSearchModal = useSearchModal((state) => state.openModal)
  const isSearchModalOpen = useSearchModal((state) => state.isOpen)
  const pathname = useRouterState({
    select: function selectPathname(state) {
      return state.location.pathname
    },
  })

  useEffect(() => {
    function handleOpenSettingsEvent(event: Event) {
      const detail = (event as CustomEvent<ChatOpenSettingsDetail>).detail
      handleOpenSettings(
        detail.section === 'appearance' ? 'appearance' : 'claude',
      )
    }

    window.addEventListener(CHAT_OPEN_SETTINGS_EVENT, handleOpenSettingsEvent)
    return () => {
      window.removeEventListener(
        CHAT_OPEN_SETTINGS_EVENT,
        handleOpenSettingsEvent,
      )
    }
  }, [handleOpenSettings])

  // Platform-aware modifier key
  const _mod = useMemo(
    () =>
      typeof navigator !== 'undefined' &&
      /Mac|iPod|iPhone|iPad/.test(navigator.userAgent)
        ? '⌘'
        : 'Ctrl+',
    [],
  )

  const echoStudioEnabled = useSettingsStore(
    (state) => state.settings.experimentalEchoStudio,
  )

  const transition = {
    duration: 0.15,
    ease: isCollapsed ? 'easeIn' : 'easeOut',
  } as const

  const [providersOpen, setProvidersOpen] = useState(false)
  const [isMobile, setIsMobile] = useState(false)
  const [isHoverExpanded, setIsHoverExpanded] = useState(false)
  const sidebarHoverExpand = useChatSettingsStore(selectSidebarHoverExpand)
  const sidebarRef = useRef<HTMLElement | null>(null)
  const swipeStartRef = useRef<{ x: number; y: number } | null>(null)

  useEffect(() => {
    const media = window.matchMedia('(max-width: 767px)')
    const update = () => setIsMobile(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    if (isMobile || !isCollapsed || !sidebarHoverExpand) {
      setIsHoverExpanded(false)
    }
  }, [isCollapsed, isMobile, sidebarHoverExpand])

  const isHoverPreviewExpanded =
    sidebarHoverExpand && !isMobile && isCollapsed && isHoverExpanded
  const isVisuallyCollapsed = isCollapsed && !isHoverPreviewExpanded

  function handleSidebarToggle() {
    // In hover-preview mode, a click should dismiss the preview first;
    // otherwise toggle the persistent collapsed state.
    if (isHoverPreviewExpanded) {
      setIsHoverExpanded(false)
      return
    }
    onToggleCollapse()
  }

  const asideProps = {
    className: cn(
      'border-r h-full overflow-hidden flex flex-col theme-sidebar theme-border',
      isMobile && 'fixed inset-y-0 left-0 z-50 shadow-2xl',
      isMobile && isCollapsed && 'pointer-events-none',
    ),
  }

  useEffect(() => {
    if (!isMobile || isCollapsed) return
    const node = sidebarRef.current
    if (!node) return

    const SWIPE_CLOSE_PX = 64
    const MAX_VERTICAL_DRIFT_PX = 72

    function handleTouchStart(event: TouchEvent) {
      if (event.touches.length !== 1) return
      const touch = event.touches[0]
      swipeStartRef.current = { x: touch.clientX, y: touch.clientY }
    }

    function handleTouchEnd(event: TouchEvent) {
      const start = swipeStartRef.current
      swipeStartRef.current = null
      if (!start || event.changedTouches.length !== 1) return
      const touch = event.changedTouches[0]
      const dx = touch.clientX - start.x
      const dy = touch.clientY - start.y
      if (Math.abs(dy) > MAX_VERTICAL_DRIFT_PX) return
      if (dx <= -SWIPE_CLOSE_PX) {
        onToggleCollapse()
      }
    }

    node.addEventListener('touchstart', handleTouchStart, { passive: true })
    node.addEventListener('touchend', handleTouchEnd, { passive: true })
    return () => {
      node.removeEventListener('touchstart', handleTouchStart)
      node.removeEventListener('touchend', handleTouchEnd)
    }
  }, [isCollapsed, isMobile, onToggleCollapse])

  useEffect(() => {
    function handleOpenSettingsFromSearch() {
      handleOpenSettings()
    }

    window.addEventListener(
      SEARCH_MODAL_EVENTS.OPEN_SETTINGS,
      handleOpenSettingsFromSearch,
    )
    return () => {
      window.removeEventListener(
        SEARCH_MODAL_EVENTS.OPEN_SETTINGS,
        handleOpenSettingsFromSearch,
      )
    }
  }, [handleOpenSettings])

  // ── Nav definitions ─────────────────────────────────────────────────

  const searchItem: NavItemDef = {
    kind: 'button',
    icon: Search01Icon,
    label: t('common.search'),
    active: isSearchModalOpen,
    onClick: openSearchModal,
  }

  function i18nKeyForNav(id: string): string {
    const key = id === 'echo-studio' ? 'echoStudio' : id
    return `nav.${key}`
  }

  const navItems: Array<NavItemDef> = useMemo(
    () =>
      NAV_ITEMS.filter((item) => {
        if (!item.containers.includes('sidebar')) return false
        if (item.featureFlag === 'echoStudio') return echoStudioEnabled
        return true
      }).map((item) => ({
        kind: 'link' as const,
        to: item.to,
        icon: item.icon as unknown,
        label: t(i18nKeyForNav(item.id) as any),
        active: item.match(pathname),
        dataTour: item.id === 'skills' ? 'skills' : undefined,
      })),
    [echoStudioEnabled, pathname],
  )

  return (
    <motion.aside
      ref={(node) => {
        sidebarRef.current = node
      }}
      initial={false}
      animate={{
        width: isVisuallyCollapsed
          ? isMobile
            ? 0
            : 48
          : isMobile
            ? '85vw'
            : 200,
      }}
      transition={{ type: 'spring', stiffness: 400, damping: 30 }}
      className={cn(
        asideProps.className,
        isMobile && isCollapsed && 'pointer-events-none overflow-hidden',
      )}
      data-tour="sidebar-container"
      style={isMobile ? { maxWidth: 360 } : undefined}
      onMouseEnter={() => {
        if (sidebarHoverExpand && !isMobile && isCollapsed) {
          setIsHoverExpanded(true)
        }
      }}
      onMouseLeave={() => {
        if (sidebarHoverExpand && !isMobile) setIsHoverExpanded(false)
      }}
      aria-hidden={isMobile && isCollapsed ? true : undefined}
      {...(isMobile && isCollapsed ? { inert: true } : {})}
    >
      {/* ── Header ──────────────────────────────────────────────────── */}
      <motion.div
        layout
        transition={{ layout: transition }}
        className="relative flex h-12 items-center px-2"
      >
        <AnimatePresence initial={false}>
          {!isVisuallyCollapsed ? (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={transition}
            >
              <Link
                to="/chat"
                className={cn(
                  buttonVariants({ variant: 'ghost', size: 'sm' }),
                  'w-full pl-1.5 justify-start gap-2',
                )}
              >
                <img
                  src="/agorax-icon-512.png"
                  alt="Agorax"
                  className="size-6 rounded-lg"
                />
                <span
                  className="text-sm font-semibold tracking-tight"
                  style={{ color: 'var(--theme-text)' }}
                >
                  Agorax
                </span>
              </Link>
            </motion.div>
          ) : null}
        </AnimatePresence>
        <TooltipProvider>
          <TooltipRoot>
            <TooltipTrigger
              onClick={handleSidebarToggle}
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={
                    isVisuallyCollapsed ? 'Open Sidebar' : 'Close Sidebar'
                  }
                  className="absolute right-2 top-1/2 shrink-0 -translate-y-1/2 opacity-80 hover:opacity-100"
                  data-tour="sidebar-collapse-toggle"
                >
                  {isVisuallyCollapsed ? (
                    <HugeiconsIcon
                      icon={ArrowRight01Icon}
                      size={18}
                      strokeWidth={NAV_ICON_STROKE}
                    />
                  ) : (
                    <HugeiconsIcon
                      icon={ArrowLeft01Icon}
                      size={18}
                      strokeWidth={NAV_ICON_STROKE}
                    />
                  )}
                </Button>
              }
            />
            <TooltipContent side="right">
              {isVisuallyCollapsed ? 'Open Sidebar' : 'Close Sidebar'}
            </TooltipContent>
          </TooltipRoot>
        </TooltipProvider>
      </motion.div>

      {/* ── Search ─────────────────────────────────────────────────── */}
      <div className="px-2 pb-1">
        <motion.div
          layout
          transition={{ layout: transition }}
          className="w-full"
        >
          <NavItem
            item={searchItem}
            isCollapsed={isVisuallyCollapsed}
            transition={transition}
            onSelectSession={onSelectSession}
          />
        </motion.div>
      </div>

      {/* ── Scrollable body: nav ────────────────────────────────────── */}
      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin flex flex-col">
        <div className={cn('shrink-0 px-2', isMobile && 'order-2')}>
          <NavList
            items={navItems}
            isCollapsed={isVisuallyCollapsed}
            transition={transition}
            onSelectSession={onSelectSession}
          />
        </div>
      </div>

      {/* ── Footer with User Menu ─────────────────────────────────── */}
      <div className="px-2 py-2.5 border-t shrink-0 theme-border theme-panel">
        {/* User card + actions */}
        <div
          className={cn(
            'flex items-center rounded-lg transition-colors',
            isVisuallyCollapsed ? 'flex-col gap-2 py-2' : 'gap-2.5 px-2 py-1.5',
          )}
        >
          {/* User profile trigger */}
          <button
            type="button"
            data-tour="settings"
            onClick={() => handleOpenSettings('profile')}
            className={cn(
              'flex items-center gap-2.5 rounded-lg py-1 text-left transition-colors hover:bg-primary-200 dark:hover:bg-neutral-800 flex-1 min-w-0',
              isVisuallyCollapsed ? 'justify-center px-0' : 'px-1.5',
            )}
            aria-label="User settings"
          >
            <UserAvatar
              size={28}
              src={profileAvatarDataUrl}
              alt={profileDisplayName}
            />
            <AnimatePresence initial={false} mode="wait">
              {!isVisuallyCollapsed && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={transition}
                  className="flex-1 min-w-0 flex items-center gap-1.5"
                >
                  <span className="block truncate text-sm font-medium text-primary-900 dark:text-neutral-100">
                    {profileDisplayName}
                  </span>
                  <StatusDot />
                </motion.div>
              )}
            </AnimatePresence>
          </button>

          {/* Settings + Theme toggle */}
          {!isVisuallyCollapsed && (
            <div className="flex items-center gap-0.5">
              <Link
                to="/settings"
                className="shrink-0 rounded-lg p-1.5 text-[var(--theme-muted)] transition-colors hover:bg-[var(--transparency-hover)] hover:text-[var(--theme-text)]"
                aria-label="Settings"
              >
                <HugeiconsIcon
                  icon={Settings01Icon}
                  size={16}
                  strokeWidth={NAV_ICON_STROKE}
                />
              </Link>
              <ThemeToggleMini />
            </div>
          )}
        </div>
      </div>

      {settingsOpen ? (
        <Suspense fallback={null}>
          <SettingsDialog
            open={settingsOpen}
            onOpenChange={setSettingsOpen}
            initialSection={settingsSection}
          />
        </Suspense>
      ) : null}

      {providersOpen ? (
        <Suspense fallback={null}>
          <ProvidersDialog open={providersOpen} onOpenChange={setProvidersOpen} />
        </Suspense>
      ) : null}
    </motion.aside>
  )
}

function areSidebarPropsEqual(
  prevProps: ChatSidebarProps,
  nextProps: ChatSidebarProps,
): boolean {
  if (prevProps.activeFriendlyId !== nextProps.activeFriendlyId) return false
  if (prevProps.creatingSession !== nextProps.creatingSession) return false
  if (prevProps.isCollapsed !== nextProps.isCollapsed) return false
  return true
}

const MemoizedChatSidebar = memo(ChatSidebarComponent, areSidebarPropsEqual)

export { MemoizedChatSidebar as ChatSidebar }
