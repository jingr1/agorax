// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ManagedAgentChatView } from './managed-agent-chat-view'
import type { AgentChatFrameProps } from './agent-chat-frame'
import type { AgentWithStatus } from '@/lib/agent-types'

const mocks = vi.hoisted(() => ({
  frame: null as AgentChatFrameProps | null,
  submit: vi.fn(), clearQueue: vi.fn(), abort: vi.fn(),
  mode: 'queue',
  capabilities: null as Record<string, boolean> | null,
  blockedReason: 'active_turn',
  commandData: undefined as { commands: Array<{ name: string; description?: string }>; capabilities: Record<string, boolean> | null } | undefined,
}))
vi.mock('./agent-chat-frame', () => ({ AgentChatFrame: (props: AgentChatFrameProps) => {
  mocks.frame = props
  return <div>{props.children}</div>
} }))
vi.mock('../chat-screen', () => ({ ChatScreen: ({ renderMain }: { renderMain: React.ReactNode }) => renderMain }))
vi.mock('../hooks/use-managed-agent-chat', () => ({ useManagedAgentChat: () => ({
  submit: mocks.submit, clearQueue: mocks.clearQueue, abort: mocks.abort,
  composer: { availability: 'blocked', blockedReason: mocks.blockedReason, queuedCount: 2, capabilities: mocks.capabilities },
  activeSessionId: 'session-1', activeTitle: 'Chat', isStreaming: true,
  messages: [], interactions: [], interactionResponses: {},
}) }))
vi.mock('../hooks/use-external-agent-sessions', () => ({ useExternalAgentSessions: () => ({ activeFriendlyId: 'session-1' }) }))
vi.mock('../hooks/use-chat-mobile', () => ({ useChatMobile: () => ({ isMobile: false }) }))
vi.mock('@/hooks/use-chat-settings', () => ({ useChatSettingsStore: (selector: (state: unknown) => unknown) => selector({ settings: { busyMessageMode: mocks.mode } }) }))
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({}), useQuery: () => ({ data: mocks.commandData }) }))
vi.mock('@/components/avatars', () => ({ AssistantAvatarProvider: ({ children }: { children: React.ReactNode }) => children }))
vi.mock('./agent-chat-message-pane', () => ({ AgentChatMessagePane: () => <div /> }))
vi.mock('./agent-interaction-panel', () => ({ AgentInteractionPanel: () => <div /> }))
vi.mock('./chat-empty-state', () => ({ ChatEmptyState: () => <div /> }))
vi.mock('@/components/ui/toast', () => ({ toast: vi.fn() }))

const agent = { agentId: 'codex-impl', runtime: 'codex', name: 'Codex' } as AgentWithStatus
function mount() {
  render(<ManagedAgentChatView agent={agent} sessionId="session-1" />)
  return mocks.frame!.composerProps
}

describe('managed composer wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.submit.mockResolvedValue(undefined)
    mocks.capabilities = null
    mocks.mode = 'queue'
    mocks.blockedReason = 'active_turn'
    mocks.commandData = undefined
  })
  afterEach(cleanup)

  it('uses the selected runtime catalog instead of the Claude Code command list', async () => {
    mocks.commandData = { capabilities: { compact: true, modelSwitch: false }, commands: [{ name: 'compact', description: 'Compact context' }, { name: 'provider-command', description: 'Provider action' }] }
    const composer = mount()
    expect(composer.slashRuntime?.catalog.map((command) => command.command)).toEqual(['/new', '/clear', '/help', '/compact', '/provider-command'])
    await expect(composer.slashRuntime?.execute('/compact keep decisions')).resolves.toBe(true)
    expect(mocks.submit).toHaveBeenCalledWith('/compact keep decisions', [], expect.objectContaining({ effort: 'medium' }))
  })

  it('allows queueing during an active turn without inventing optional capabilities', () => {
    const composer = mount()
    expect(composer.disabled).toBe(false)
    expect(composer.onQueue).toBeTypeOf('function')
    expect(composer.onSteer).toBeUndefined()
    expect(composer.onInterruptSend).toBeUndefined()
    expect(composer.runtimeCapabilities).toBeNull()
    expect(composer.clearDraftOnSubmit).toBe(false)
    expect(composer.queuedCount).toBe(2)
    composer.onClearQueue?.()
    expect(mocks.clearQueue).toHaveBeenCalledOnce()
  })

  it('blocks submissions while an interaction holds the session', () => {
    mocks.blockedReason = 'pending_interaction'
    mocks.capabilities = { activeTurnGuidance: true, interrupt: true }
    const composer = mount()
    expect(composer.disabled).toBe(true)
    expect(composer.onQueue).toBeUndefined()
    expect(composer.onSteer).toBeUndefined()
    expect(composer.onInterruptSend).toBeUndefined()
  })

  it.each(['steer', 'interrupt'] as const)('falls back to queue when %s is unsupported', (mode) => {
    mocks.mode = mode
    expect(mount().busyMessageMode).toBe('queue')
  })

  it.each(['queue', 'steer', 'interrupt'] as const)('submits %s through the Engine and resets only after acceptance', async (mode) => {
    mocks.capabilities = { activeTurnGuidance: true, interrupt: true, imageInput: true, modelSwitch: true }
    mocks.mode = mode
    const composer = mount()
    const helpers = { reset: vi.fn(), setValue: vi.fn(), setAttachments: vi.fn() }
    act(() => {
      if (mode === 'steer') void composer.onSteer?.('continue', [], helpers)
      else if (mode === 'interrupt') composer.onInterruptSend?.('continue', [], helpers)
      else composer.onQueue?.('continue', [], helpers)
    })
    expect(mocks.submit).toHaveBeenCalledWith('continue', [], expect.objectContaining({ mode }))
    await waitFor(() => expect(helpers.reset).toHaveBeenCalledOnce())
    expect(composer.busyMessageMode).toBe(mode)
  })

  it('preserves the draft when the Engine rejects submission', async () => {
    mocks.submit.mockRejectedValue(new Error('Daemon offline'))
    const composer = mount()
    const helpers = { reset: vi.fn(), setValue: vi.fn(), setAttachments: vi.fn() }
    await act(() => Promise.resolve(composer.onSubmit('keep my draft', [], false, helpers)))
    expect(helpers.reset).not.toHaveBeenCalled()
  })
})