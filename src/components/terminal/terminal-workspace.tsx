import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { HugeiconsIcon } from '@hugeicons/react'
import {
  Add01Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  ArrowUp02Icon,
  Cancel01Icon,
  ComputerTerminal01Icon,
  Copy01Icon,
  SidebarLeft01Icon,
} from '@hugeicons/core-free-icons'
import type { FitAddon } from 'xterm-addon-fit'
import type { Terminal } from 'xterm'
import type { XtermClientCtors } from '@/lib/xterm-client'
import type { DebugAnalysis } from '@/components/terminal/debug-panel'
import type { TerminalTab } from '@/stores/terminal-panel-store'
import { DebugPanel } from '@/components/terminal/debug-panel'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useTerminalPanelStore } from '@/stores/terminal-panel-store'

// Dynamic imports to avoid SSR crash (xterm uses `self` which doesn't exist on server)
let xtermCtors: XtermClientCtors | null = null

async function ensureXterm() {
  if (xtermCtors) return
  const { loadXtermClient } = await import('@/lib/xterm-client')
  xtermCtors = await loadXtermClient()
}

type ContextMenuState = {
  tabId: string
  x: number
  y: number
}

type RenameState = {
  tabId: string
  value: string
}

type TerminalWorkspaceProps = {
  mode: 'panel' | 'fullscreen'
  panelVisible?: boolean
  onMinimizePanel?: () => void
  onMaximizePanel?: () => void
  onClosePanel?: () => void
  onBack?: () => void
}

type TerminalSessionResponse = {
  sessionId?: string
  reattach?: boolean
}

// See terminal-panel.tsx — ~/.hermes is not guaranteed to exist in the workspace image.
const DEFAULT_TERMINAL_CWD = '~'
const TERMINAL_BG = '#0d0d0d'
/** Floor for PTY size — fit() on a hidden/zero-width pane otherwise yields
 *  tiny cols and bash wraps `user@host` onto many lines that look like spam. */
const MIN_PTY_COLS = 60
const MIN_PTY_ROWS = 16

function ptySizeFor(terminal: Terminal): { cols: number; rows: number } {
  return {
    cols: Math.max(terminal.cols || 0, MIN_PTY_COLS),
    rows: Math.max(terminal.rows || 0, MIN_PTY_ROWS),
  }
}

function clearTerminalBuffer(terminal: Terminal) {
  // reset() wipes scrollback; clear() alone can leave wrapped prompt junk.
  terminal.reset()
  terminal.write('\x1b[2J\x1b[3J\x1b[H')
}

function toDebugAnalysis(value: unknown): DebugAnalysis | null {
  if (!value || typeof value !== 'object') return null
  const entry = value as Record<string, unknown>
  const summary = typeof entry.summary === 'string' ? entry.summary.trim() : ''
  const rootCause =
    typeof entry.rootCause === 'string' ? entry.rootCause.trim() : ''
  const rawCommands = Array.isArray(entry.suggestedCommands)
    ? entry.suggestedCommands
    : []

  if (!summary || !rootCause) return null

  const suggestedCommands = rawCommands
    .map(function mapCommand(commandEntry) {
      if (!commandEntry || typeof commandEntry !== 'object') return null
      const command = commandEntry as Record<string, unknown>
      const commandText =
        typeof command.command === 'string' ? command.command.trim() : ''
      const descriptionText =
        typeof command.description === 'string'
          ? command.description.trim()
          : ''
      if (!commandText || !descriptionText) return null
      return { command: commandText, description: descriptionText }
    })
    .filter(function removeNulls(command): command is {
      command: string
      description: string
    } {
      return Boolean(command)
    })

  const docsLink =
    typeof entry.docsLink === 'string' && entry.docsLink.trim()
      ? entry.docsLink.trim()
      : undefined

  return {
    summary,
    rootCause,
    suggestedCommands,
    ...(docsLink ? { docsLink } : {}),
  }
}

export function TerminalWorkspace({
  mode,
  panelVisible = true,
  onMinimizePanel,
  onMaximizePanel,
  onClosePanel,
  onBack,
}: TerminalWorkspaceProps) {
  const tabs = useTerminalPanelStore((state) => state.tabs)
  const activeTabId = useTerminalPanelStore((state) => state.activeTabId)
  const createTab = useTerminalPanelStore((state) => state.createTab)
  const closeTab = useTerminalPanelStore((state) => state.closeTab)
  const closeAllTabs = useTerminalPanelStore((state) => state.closeAllTabs)
  const setActiveTab = useTerminalPanelStore((state) => state.setActiveTab)
  const renameTab = useTerminalPanelStore((state) => state.renameTab)
  const setTabSessionId = useTerminalPanelStore(
    (state) => state.setTabSessionId,
  )
  const setTabStatus = useTerminalPanelStore((state) => state.setTabStatus)
  const clearTabPendingCommand = useTerminalPanelStore(
    (state) => state.clearTabPendingCommand,
  )

  const [termHeight, setTermHeight] = useState<number | null>(null)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [renameState, setRenameState] = useState<RenameState | null>(null)
  const [debugAnalysis, setDebugAnalysis] = useState<DebugAnalysis | null>(null)
  const [debugLoading, setDebugLoading] = useState(false)
  const [showDebugPanel, setShowDebugPanel] = useState(false)

  const contextMenuRef = useRef<HTMLDivElement | null>(null)
  const renameInputRef = useRef<HTMLInputElement | null>(null)
  const containerMapRef = useRef(new Map<string, HTMLDivElement>())
  const terminalMapRef = useRef(new Map<string, Terminal>())
  const fitMapRef = useRef(new Map<string, FitAddon>())
  const readerMapRef = useRef(
    new Map<string, ReadableStreamDefaultReader<Uint8Array>>(),
  )
  const connectedRef = useRef(new Set<string>())

  const activeTab = useMemo(
    function activeTabMemo() {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime safety
      return tabs.find((tab) => tab.id === activeTabId) ?? tabs[0] ?? null
    },
    [activeTabId, tabs],
  )

  const sendInput = useCallback(function sendInput(
    tabId: string,
    data: string,
  ) {
    // Look up session ID from store at call time (not stale closure)
    const currentTab = useTerminalPanelStore
      .getState()
      .tabs.find((t) => t.id === tabId)
    if (!currentTab?.sessionId) return
    // Fire-and-forget — never await, never block input
    fetch('/api/terminal-input', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: currentTab.sessionId, data }),
    }).catch(function ignore() {
      return undefined
    })
  }, [])

  const resizeSession = useCallback(async function resizeSession(
    tabId: string,
    terminal: Terminal,
  ) {
    const currentTab = useTerminalPanelStore
      .getState()
      .tabs.find((t) => t.id === tabId)
    if (!currentTab?.sessionId) return
    const { cols, rows } = ptySizeFor(terminal)
    await fetch('/api/terminal-resize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: currentTab.sessionId,
        cols,
        rows,
      }),
    }).catch(function ignore() {
      return undefined
    })
  }, [])

  const captureRecentTerminalOutput = useCallback(
    function captureRecentTerminalOutput(tabId: string): string {
      const terminal = terminalMapRef.current.get(tabId)
      if (!terminal) return ''

      const buffer = terminal.buffer.active
      const startLine = Math.max(0, buffer.length - 100)
      const recentLines: Array<string> = []

      for (let index = startLine; index < buffer.length; index += 1) {
        const line = buffer.getLine(index)
        if (!line) continue
        recentLines.push(line.translateToString(true))
      }

      return recentLines.join('\n').trim()
    },
    [],
  )

  const handleAnalyzeDebug = useCallback(
    async function handleAnalyzeDebug() {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime safety
      if (!activeTab) return

      setShowDebugPanel(true)
      setDebugLoading(true)
      setDebugAnalysis(null)

      try {
        const terminalOutput = captureRecentTerminalOutput(activeTab.id)
        const response = await fetch('/api/debug-analyze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ terminalOutput }),
        })

        const payload = (await response.json().catch(function fallback() {
          return null
        })) as unknown

        const analysis = toDebugAnalysis(payload)
        if (!analysis) {
          throw new Error('Invalid analysis response payload')
        }

        setDebugAnalysis(analysis)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        setDebugAnalysis({
          summary: 'Debug analysis failed.',
          rootCause: message,
          suggestedCommands: [],
        })
      } finally {
        setDebugLoading(false)
      }
    },
    [activeTab, captureRecentTerminalOutput],
  )

  const handleRunDebugCommand = useCallback(
    function handleRunDebugCommand(command: string) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime safety
      if (!activeTab) return
      void sendInput(activeTab.id, `${command}\r`)
    },
    [activeTab, sendInput],
  )

  const handleCloseDebugPanel = useCallback(function handleCloseDebugPanel() {
    setShowDebugPanel(false)
  }, [])

  const focusActiveTerminal = useCallback(
    function focusActiveTerminal() {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime safety
      if (!activeTab) return
      const terminal = terminalMapRef.current.get(activeTab.id)
      terminal?.focus()
    },
    [activeTab],
  )

  const closeTabResources = useCallback(async function closeTabResources(
    tabId: string,
    sessionId: string | null,
  ) {
    const reader = readerMapRef.current.get(tabId)
    readerMapRef.current.delete(tabId)
    if (reader) {
      await reader.cancel().catch(function ignore() {
        return undefined
      })
    }
    const terminal = terminalMapRef.current.get(tabId)
    terminal?.dispose()
    terminalMapRef.current.delete(tabId)
    fitMapRef.current.delete(tabId)
    containerMapRef.current.delete(tabId)
    connectedRef.current.delete(tabId)

    if (sessionId) {
      await fetch('/api/terminal-close', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      }).catch(function ignore() {
        return undefined
      })
    }
  }, [])

  const handleCloseTab = useCallback(
    function handleCloseTab(tab: TerminalTab) {
      void closeTabResources(tab.id, tab.sessionId)
      closeTab(tab.id)
    },
    [closeTab, closeTabResources],
  )

  const handleClosePanel = useCallback(
    function handleClosePanel() {
      const currentTabs = useTerminalPanelStore.getState().tabs
      for (const tab of currentTabs) {
        void closeTabResources(tab.id, tab.sessionId)
      }
      closeAllTabs()
      setShowDebugPanel(false)
      if (onClosePanel) onClosePanel()
    },
    [closeAllTabs, closeTabResources, onClosePanel],
  )

  const connectTab = useCallback(
    async function connectTab(tab: TerminalTab) {
      if (connectedRef.current.has(tab.id)) return
      const terminal = terminalMapRef.current.get(tab.id)
      if (!terminal) return

      connectedRef.current.add(tab.id)
      setTabStatus(tab.id, 'active')

      const pendingCommand =
        tab.pendingCommand && tab.pendingCommand.length > 0
          ? tab.pendingCommand
          : undefined
      if (pendingCommand) {
        clearTabPendingCommand(tab.id)
      }

      const { cols, rows } = ptySizeFor(terminal)
      // Apply size to the local emulator before spawn so wrap matches PTY.
      try {
        terminal.resize(cols, rows)
      } catch {
        /* ignore */
      }

      const response = await fetch('/api/terminal-stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cwd: DEFAULT_TERMINAL_CWD,
          // One-shot provider login (or similar) replaces the default shell.
          command: pendingCommand,
          cols,
          rows,
          // If this tab already has a sessionId, ask the server to reattach
          // to that PTY rather than spawning a fresh one. Lets us survive
          // transient SSE disconnects (network blip, browser suspension,
          // HMR reload) without dropping the user's shell. See #298.
          sessionId: tab.sessionId || undefined,
        }),
      }).catch(function handleError() {
        return null
      })

      if (!response || !response.ok || !response.body) {
        terminal.writeln('\r\n[terminal] failed to connect\r\n')
        connectedRef.current.delete(tab.id)
        setTabStatus(tab.id, 'idle')
        return
      }

      const reader = response.body.getReader()
      readerMapRef.current.set(tab.id, reader)
      const decoder = new TextDecoder()
      let buffer = ''
      let processExited = false

      // Throttled terminal writes — yields to input events between flushes
      let writeBuf = ''
      let flushTimer: ReturnType<typeof setTimeout> | null = null
      const FLUSH_MS = 80 // ~12fps — generous gaps for input
      const MAX_BUF = 8192 // drop old data if buffer overflows (screen redraws)
      function flushWrites() {
        flushTimer = null
        if (writeBuf && terminal) {
          const chunk = writeBuf
          writeBuf = ''
          terminal.write(chunk)
        }
      }
      // Hold incomplete OSC across SSE chunks so we never paint a bare
      // "user@host:" title fragment when a sequence is split mid-flight.
      let ansiCarry = ''
      function queueWrite(data: string) {
        const combined = ansiCarry + data
        const stripped = combined.replace(
          /\x1b\][0-2];[^\x07\x1b]*(?:\x07|\x1b\\)/g,
          '',
        )
        const openOsc = stripped.match(/\x1b\][0-2];[^\x07\x1b]*$/)
        if (openOsc) {
          ansiCarry = openOsc[0]
          writeBuf += stripped.slice(0, -openOsc[0].length)
        } else {
          ansiCarry = ''
          writeBuf += stripped
        }
        if (writeBuf.length > MAX_BUF) {
          clearTimeout(flushTimer as unknown as ReturnType<typeof setTimeout>)
          flushWrites()
          return
        }
        if (!flushTimer) flushTimer = setTimeout(flushWrites, FLUSH_MS)
      }

      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime safety
      while (true) {
        const readState = await reader.read().catch(function onReadError() {
          return { done: true, value: undefined }
        })
        const value = readState.value
        if (readState.done) break
        if (!value) continue

        buffer += decoder.decode(value, { stream: true })
        const blocks = buffer.split('\n\n')
        buffer = blocks.pop() ?? ''

        for (let _bi = 0; _bi < blocks.length; _bi++) {
          // Yield every 10 blocks to let input events through
          if (_bi > 0 && _bi % 10 === 0)
            await new Promise((r) => setTimeout(r, 0))
          const block = blocks[_bi]
          if (!block.trim()) continue
          const lines = block.split('\n')
          let eventName = ''
          let eventData = ''
          for (const line of lines) {
            if (line.startsWith('event: ')) {
              eventName = line.slice(7).trim()
              continue
            }
            if (line.startsWith('data: ')) {
              eventData += line.slice(6)
              continue
            }
            if (line.startsWith('data:')) {
              eventData += line.slice(5)
            }
          }
          if (!eventName || eventName === 'ping') continue

          if (eventName === 'session' && eventData) {
            const payload = JSON.parse(eventData) as TerminalSessionResponse
            if (payload.sessionId) {
              // Fresh PTY (not a live reattach) — wipe scrollback so reopen /
              // login-exit / HMR does not stack another wrapped user@host line.
              if (payload.reattach !== true) {
                clearTimeout(
                  flushTimer as unknown as ReturnType<typeof setTimeout>,
                )
                flushTimer = null
                writeBuf = ''
                ansiCarry = ''
                clearTerminalBuffer(terminal)
              }
              setTabSessionId(tab.id, payload.sessionId)
              // Do NOT rename on session connect when cwd is "~" — that used
              // to overwrite user renames (and right-click Rename looked broken).
              // Only mirror a real workspace path into the tab title.
              if (tab.cwd !== '~' && tab.cwd.trim()) {
                renameTab(tab.id, tab.cwd)
              }
            }
            continue
          }

          if (eventName === 'data' && eventData) {
            const payload = JSON.parse(eventData) as { data?: string }
            if (typeof payload.data === 'string') {
              queueWrite(payload.data)
            }
            continue
          }

          if (eventName === 'exit' && eventData) {
            processExited = true
            // Drop the dead id so we don't "reattach" to a gone PTY and so the
            // follow-up connect starts a clean shell (login CLIs exit this way).
            setTabSessionId(tab.id, null)
            const payload = JSON.parse(eventData) as {
              exitCode?: number
              signal?: number
            }
            terminal.writeln(
              `\r\n[process exited${payload.exitCode != null ? ` code=${payload.exitCode}` : ''}]\r\n`,
            )
            continue
          }

          if (eventName === 'error' && eventData) {
            terminal.writeln('\r\n[terminal] connection error\r\n')
          }
        }
      }

      // Flush any remaining buffered writes
      clearTimeout(flushTimer as unknown as ReturnType<typeof setTimeout>)
      flushWrites()

      const latestTab = useTerminalPanelStore
        .getState()
        .tabs.find((item) => item.id === tab.id)

      // SSE stream ended. Two reasons it could end:
      // 1) The shell/login process exited (PTY closed) — start one fresh shell.
      // 2) The SSE stream itself dropped but the PTY is still alive — reattach.
      const previousSessionId = latestTab?.sessionId ?? null
      connectedRef.current.delete(tab.id)
      setTabStatus(tab.id, 'idle')

      if (processExited) {
        // Login CLI (or other oneshot) finished. Open a normal interactive
        // shell once; do not loop reattach against the dead session id.
        setTimeout(() => {
          const refreshed = useTerminalPanelStore
            .getState()
            .tabs.find((item) => item.id === tab.id)
          if (
            refreshed &&
            !refreshed.sessionId &&
            !connectedRef.current.has(tab.id)
          ) {
            void connectTab(refreshed)
          }
        }, 200)
        return
      }

      if (previousSessionId) {
        const stillSameTab =
          useTerminalPanelStore
            .getState()
            .tabs.find((item) => item.id === tab.id)?.sessionId ===
          previousSessionId
        if (stillSameTab) {
          terminal.writeln('\r\n\x1b[2m[reconnecting...]\x1b[0m')
          setTimeout(() => {
            const refreshed = useTerminalPanelStore
              .getState()
              .tabs.find((item) => item.id === tab.id)
            if (refreshed && refreshed.sessionId === previousSessionId) {
              void connectTab(refreshed)
            }
          }, 600)
          return
        }
      }

      setTabSessionId(tab.id, null)
    },
    [clearTabPendingCommand, renameTab, setTabSessionId, setTabStatus],
  )

  const ensureTerminalForTab = useCallback(
    function ensureTerminalForTab(tab: TerminalTab) {
      if (terminalMapRef.current.has(tab.id)) return
      const container = containerMapRef.current.get(tab.id)
      if (!container) return

      // Guard: xterm must be loaded first
      if (!xtermCtors) {
        void ensureXterm().then(() => {
          // Re-trigger after load
          if (
            !terminalMapRef.current.has(tab.id) &&
            containerMapRef.current.has(tab.id)
          ) {
            ensureTerminalForTab(tab)
          }
        })
        return
      }

      const { Terminal, FitAddon, WebLinksAddon } = xtermCtors
      const isMobile = window.matchMedia('(max-width: 767px)').matches
      const terminal = new Terminal({
        cursorBlink: true,
        fontSize: isMobile ? 11 : 13,
        fontFamily: 'JetBrains Mono, Menlo, Monaco, Consolas, monospace',
        theme: {
          background: TERMINAL_BG,
          foreground: '#e6e6e6',
          cursor: '#ea580c',
          selectionBackground: '#2b2b2b',
        },
      })
      const fitAddon = new FitAddon()
      const webLinks = new WebLinksAddon()
      terminal.loadAddon(fitAddon)
      terminal.loadAddon(webLinks)
      terminal.open(container)
      fitAddon.fit()

      terminal.onData(function onData(data) {
        void sendInput(tab.id, data)
      })

      terminalMapRef.current.set(tab.id, terminal)
      fitMapRef.current.set(tab.id, fitAddon)
      // Defer PTY spawn until the pane is visible — fit() on a hidden
      // absolute layer can report tiny cols and bash wraps prompts into
      // stacks of "user@host" lines.
      if (panelVisible) {
        void resizeSession(tab.id, terminal)
        void connectTab(tab)
      }
    },
    [connectTab, panelVisible, resizeSession, sendInput],
  )

  const handleCreateTab = useCallback(
    function handleCreateTab() {
      const newTabId = createTab(DEFAULT_TERMINAL_CWD)
      window.setTimeout(function focusNewTab() {
        const tab = useTerminalPanelStore
          .getState()
          .tabs.find((item) => item.id === newTabId)
        if (!tab) return
        ensureTerminalForTab(tab)
        focusActiveTerminal()
      }, 0)
    },
    [createTab, ensureTerminalForTab, focusActiveTerminal],
  )

  useEffect(
    function focusRenameInput() {
      if (!renameState) return
      const input = renameInputRef.current
      if (!input) return
      input.focus()
      input.select()
    },
    [renameState],
  )

  useEffect(
    function closeContextMenuOnOutsidePointer() {
      if (!contextMenu) return
      // Use capture so we see the event before React/xterm handlers. Only
      // dismiss when the target is outside the portaled menu.
      function handlePointerDown(event: PointerEvent) {
        const target = event.target
        if (
          target instanceof Node &&
          contextMenuRef.current?.contains(target)
        ) {
          return
        }
        setContextMenu(null)
      }
      function handleEscape(event: KeyboardEvent) {
        if (event.key === 'Escape') {
          setContextMenu(null)
        }
      }
      window.addEventListener('pointerdown', handlePointerDown, true)
      window.addEventListener('keydown', handleEscape)
      return function cleanup() {
        window.removeEventListener('pointerdown', handlePointerDown, true)
        window.removeEventListener('keydown', handleEscape)
      }
    },
    [contextMenu],
  )

  useEffect(
    function ensureTabsInitialized() {
      if (tabs.length === 0) {
        createTab(DEFAULT_TERMINAL_CWD)
        return
      }
      if (!activeTabId) {
        setActiveTab(tabs[0].id)
      }
    },
    [activeTabId, createTab, setActiveTab, tabs],
  )

  useEffect(
    function initializeVisibleTabs() {
      for (const tab of tabs) {
        ensureTerminalForTab(tab)
      }
    },
    [ensureTerminalForTab, tabs],
  )

  useEffect(
    function focusAndFitOnVisible() {
      if (!panelVisible) return
      // Refit all terminals when becoming visible (e.g. navigating back to terminal route)
      window.setTimeout(() => {
        for (const fitAddon of fitMapRef.current.values()) {
          try {
            fitAddon.fit()
          } catch {
            /* ignore */
          }
        }
        const snapshot = useTerminalPanelStore.getState().tabs
        for (const tab of snapshot) {
          const term = terminalMapRef.current.get(tab.id)
          if (!term) continue
          const { cols, rows } = ptySizeFor(term)
          try {
            term.resize(cols, rows)
          } catch {
            /* ignore */
          }
          void resizeSession(tab.id, term)
          // Connect tabs that were created while the pane was hidden.
          if (!connectedRef.current.has(tab.id)) {
            void connectTab(tab)
          }
        }
        focusActiveTerminal()
      }, 100)
    },
    [connectTab, focusActiveTerminal, panelVisible, resizeSession],
  )

  useEffect(
    function fitOnResize() {
      function refitAll() {
        for (const fitAddon of fitMapRef.current.values()) {
          try {
            fitAddon.fit()
          } catch {
            /* */
          }
        }
        const snapshot = useTerminalPanelStore.getState().tabs
        for (const tab of snapshot) {
          const terminal = terminalMapRef.current.get(tab.id)
          if (!terminal) continue
          void resizeSession(tab.id, terminal)
        }
      }

      function handleResize() {
        // Update height from visualViewport (keyboard-aware on mobile)
        const vv = window.visualViewport
        if (vv) {
          setTermHeight(vv.height)
        }
        refitAll()
      }

      const timeout = window.setTimeout(handleResize, 50)
      window.addEventListener('resize', handleResize)
      window.visualViewport?.addEventListener('resize', handleResize)
      window.visualViewport?.addEventListener('scroll', handleResize)

      return function cleanup() {
        window.clearTimeout(timeout)
        window.removeEventListener('resize', handleResize)
        window.visualViewport?.removeEventListener('resize', handleResize)
        window.visualViewport?.removeEventListener('scroll', handleResize)
      }
    },
    [resizeSession],
  )

  useEffect(function disposeOnUnmount() {
    return function cleanup() {
      for (const reader of readerMapRef.current.values()) {
        void reader.cancel().catch(function ignore() {
          return undefined
        })
      }
      readerMapRef.current.clear()
      for (const terminal of terminalMapRef.current.values()) {
        terminal.dispose()
      }
      terminalMapRef.current.clear()
      fitMapRef.current.clear()
      containerMapRef.current.clear()
      connectedRef.current.clear()
    }
  }, [])

  return (
    <div
      className="relative flex min-h-0 flex-col bg-primary-50"
      style={
        termHeight
          ? { height: termHeight, maxHeight: termHeight }
          : { height: '100%' }
      }
    >
      {/* fullscreen header removed — tab bar handles everything */}

      <div className="flex h-8 items-center border-b border-primary-300 bg-primary-100 px-1">
        <div className="flex min-w-0 flex-1 items-center overflow-x-auto">
          {tabs.map(function renderTab(tab) {
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime safety
            const isActive = tab.id === activeTab?.id
            const isRenaming = renameState?.tabId === tab.id
            return (
              <div
                key={tab.id}
                role="tab"
                tabIndex={0}
                aria-selected={isActive}
                aria-label={tab.title}
                onClick={function onClick() {
                  if (isRenaming) return
                  setActiveTab(tab.id)
                  window.setTimeout(function focusCurrent() {
                    terminalMapRef.current.get(tab.id)?.focus()
                  }, 0)
                }}
                onKeyDown={function onTabKey(event) {
                  if (isRenaming) return
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    setActiveTab(tab.id)
                    window.setTimeout(function focusCurrent() {
                      terminalMapRef.current.get(tab.id)?.focus()
                    }, 0)
                  }
                }}
                onContextMenu={function onContextMenu(event) {
                  event.preventDefault()
                  setContextMenu({
                    tabId: tab.id,
                    x: event.clientX,
                    y: event.clientY,
                  })
                }}
                className={cn(
                  'group relative flex h-8 max-w-[220px] cursor-pointer items-center gap-2 px-3 text-xs text-primary-700 transition-colors',
                  isActive
                    ? 'bg-primary-50 text-primary-900'
                    : 'hover:bg-primary-200/70',
                )}
              >
                <span
                  className={cn(
                    'size-2 rounded-full',
                    isActive || tab.status === 'active'
                      ? 'bg-emerald-400'
                      : 'bg-primary-500',
                  )}
                />
                <HugeiconsIcon
                  icon={ComputerTerminal01Icon}
                  size={20}
                  strokeWidth={1.5}
                  className="shrink-0"
                />
                {isRenaming ? (
                  <input
                    ref={renameInputRef}
                    value={renameState.value}
                    onChange={function onRenameChange(event) {
                      setRenameState({
                        tabId: tab.id,
                        value: event.target.value,
                      })
                    }}
                    onClick={function stopTabSwitch(event) {
                      event.stopPropagation()
                    }}
                    onPointerDown={function stopTabSwitch(event) {
                      event.stopPropagation()
                    }}
                    onBlur={function commitRename(event) {
                      const next = event.currentTarget.value.trim()
                      setRenameState(null)
                      if (next) renameTab(tab.id, next)
                    }}
                    onKeyDown={function onRenameKey(event) {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        event.stopPropagation()
                        const next = event.currentTarget.value.trim()
                        setRenameState(null)
                        if (next) renameTab(tab.id, next)
                        return
                      }
                      if (event.key === 'Escape') {
                        event.preventDefault()
                        event.stopPropagation()
                        setRenameState(null)
                      }
                    }}
                    className="min-w-0 flex-1 rounded border border-primary-400 bg-primary-50 px-1 py-0.5 text-xs text-primary-900 outline-none"
                    aria-label="Rename terminal tab"
                  />
                ) : (
                  <span className="truncate text-left tabular-nums">
                    {tab.title}
                  </span>
                )}
                {tabs.length > 1 && !isRenaming ? (
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={function onClose(event) {
                      event.stopPropagation()
                      handleCloseTab(tab)
                    }}
                    onKeyDown={function onCloseByKeyboard(event) {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        event.stopPropagation()
                        handleCloseTab(tab)
                      }
                    }}
                    className="hidden rounded p-0.5 text-primary-600 hover:bg-primary-300 hover:text-primary-900 group-hover:inline-flex"
                  >
                    <HugeiconsIcon
                      icon={Cancel01Icon}
                      size={20}
                      strokeWidth={1.5}
                    />
                  </span>
                ) : null}
                <span
                  className={cn(
                    'pointer-events-none absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-[#ea580c] transition-opacity',
                    isActive ? 'opacity-100' : 'opacity-0',
                  )}
                />
              </div>
            )
          })}
        </div>

        <div className="flex items-center gap-0.5">
          {/* Debug — AI analyzes terminal output to suggest fixes */}
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={handleAnalyzeDebug}
            disabled={debugLoading}
            aria-label="AI Debug analysis"
            title="AI Debug — analyze terminal output"
          >
            🔍
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={handleCreateTab}
            aria-label="New terminal tab"
            title="New tab"
          >
            <HugeiconsIcon icon={Add01Icon} size={20} strokeWidth={1.5} />
          </Button>
          {mode === 'panel' ? (
            <>
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={onMinimizePanel}
                aria-label="Minimize"
              >
                <HugeiconsIcon
                  icon={SidebarLeft01Icon}
                  size={20}
                  strokeWidth={1.5}
                />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={onMaximizePanel}
                aria-label="Maximize"
              >
                <HugeiconsIcon
                  icon={ArrowRight01Icon}
                  size={20}
                  strokeWidth={1.5}
                />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={handleClosePanel}
                aria-label="Close"
              >
                <HugeiconsIcon
                  icon={Cancel01Icon}
                  size={20}
                  strokeWidth={1.5}
                />
              </Button>
            </>
          ) : null}
        </div>
      </div>

      <div
        className="relative flex-1 overflow-hidden bg-primary-50"
        style={{ backgroundColor: TERMINAL_BG }}
      >
        {tabs.map(function renderTerminal(tab) {
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime safety
          const isActive = tab.id === activeTab?.id
          return (
            <div
              key={tab.id}
              className={cn('absolute inset-0', isActive ? 'block' : 'hidden')}
            >
              <div
                ref={function assignContainer(node) {
                  if (node) {
                    containerMapRef.current.set(tab.id, node)
                    ensureTerminalForTab(tab)
                    return
                  }
                  containerMapRef.current.delete(tab.id)
                }}
                onClick={function tapToFocus() {
                  terminalMapRef.current.get(tab.id)?.focus()
                }}
                className="h-full w-full bg-primary-50 font-mono text-primary-900"
                style={{ backgroundColor: TERMINAL_BG }}
              />
            </div>
          )
        })}
      </div>

      {/* Mobile input bar moved to WorkspaceShell as a sibling to prevent re-render freeze */}

      {showDebugPanel ? (
        <DebugPanel
          analysis={debugAnalysis}
          isLoading={debugLoading}
          onRunCommand={handleRunDebugCommand}
          onClose={handleCloseDebugPanel}
        />
      ) : null}

      {contextMenu
        ? createPortal(
            <div
              ref={contextMenuRef}
              role="menu"
              className="fixed z-[200] min-w-36 rounded-md border border-primary-300 bg-primary-100 p-1 shadow-lg"
              style={{ top: contextMenu.y, left: contextMenu.x }}
              onContextMenu={function preventNative(event) {
                event.preventDefault()
              }}
            >
              <button
                type="button"
                role="menuitem"
                className="flex w-full items-center rounded px-2 py-1.5 text-left text-xs text-primary-900 hover:bg-primary-200"
                onPointerDown={function renameTabFromMenu(event) {
                  // Run on pointerdown (not click) so the action beats any
                  // outside-dismiss race and works when click is swallowed.
                  event.preventDefault()
                  event.stopPropagation()
                  const menuTab = tabs.find(
                    (tab) => tab.id === contextMenu.tabId,
                  )
                  setContextMenu(null)
                  if (!menuTab) return
                  // Inline rename — window.prompt is blocked in embedded
                  // browsers and some Electron shells.
                  setRenameState({
                    tabId: menuTab.id,
                    value: menuTab.title,
                  })
                }}
              >
                Rename
              </button>
              <button
                type="button"
                role="menuitem"
                className="flex w-full items-center rounded px-2 py-1.5 text-left text-xs text-primary-900 hover:bg-primary-200"
                onPointerDown={function closeTabFromMenu(event) {
                  event.preventDefault()
                  event.stopPropagation()
                  const menuTab = tabs.find(
                    (tab) => tab.id === contextMenu.tabId,
                  )
                  setContextMenu(null)
                  if (!menuTab) return
                  handleCloseTab(menuTab)
                }}
              >
                Close
              </button>
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}
