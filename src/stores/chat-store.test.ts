import { describe, expect, it } from 'vitest'
import { splitInlineThinking, stripInternalTags, useChatStore } from './chat-store'
import type { ChatMessage } from '../screens/chat/types'

function textMessage(
  id: string,
  role: string,
  text: string,
  historyIndex: number,
): ChatMessage {
  return {
    id,
    role,
    timestamp: 1_700_000_000_000,
    __historyIndex: historyIndex,
    content: [{ type: 'text', text }],
  }
}

describe('stripInternalTags', () => {
  it('keeps the newline between a heading and the following unlabeled fence', () => {
    const source = [
      '### ConductorPhase（UI 层）',
      '```',
      'home → preview → active → complete',
      '```',
      '',
      '### MissionPhase（hook 层）',
      '```',
      'idle → decomposing → running → complete',
      '```',
      '',
      '关键状态转换：',
      '',
    ].join('\n')

    const result = stripInternalTags(source)

    expect(result).toContain('### ConductorPhase（UI 层）\n```\n')
    expect(result).toContain('```\n\n### MissionPhase（hook 层）\n```\n')
    expect(result).not.toContain('### ConductorPhase（UI 层）```')
    expect(result).not.toContain('```### MissionPhase')
  })

  it('still strips thinking tags outside fences', () => {
    const result = stripInternalTags(
      '<thinking>secret</thinking>\n\nhello `code`\n```\nkept <thinking>x</thinking>\n```\n',
    )
    expect(result).toBe('hello `code`\n```\nkept <thinking>x</thinking>\n```')
  })

  it('also strips short-form <think> tags outside fences', () => {
    const result = stripInternalTags(
      '<think>plan</think>\nvisible answer',
    )
    expect(result).toBe('visible answer')
  })
})

describe('streaming chunk thinking separation', () => {
  it('keeps leaked <think> out of the visible reply bubble text', () => {
    const sessionKey = 'test-think-leak'
    useChatStore.getState().clearSession(sessionKey)
    useChatStore.getState().processEvent({
      type: 'chunk',
      sessionKey,
      runId: 'run-think-leak',
      text: '<think>I should inspect the files</think>\nHere is the fix.',
      fullReplace: true,
    })
    const streaming = useChatStore.getState().streamingState.get(sessionKey)
    expect(streaming?.text).toBe('Here is the fix.')
    expect(streaming?.thinking).toContain('I should inspect the files')
  })
})

describe('splitInlineThinking', () => {
  it('extracts <think> reasoning and keeps the visible content', () => {
    const result = splitInlineThinking('<think>I should read the file</think>\nHere is the answer.')
    expect(result.reasoning).toBe('I should read the file')
    expect(result.content).toBe('Here is the answer.')
  })

  it('supports long-form <thinking> and <antThinking> tags', () => {
    const result = splitInlineThinking(
      '<thinking>plan</thinking><antThinking>check</antThinking>done',
    )
    expect(result.reasoning).toBe('plan\n\ncheck')
    expect(result.content).toBe('done')
  })

  it('leaves thinking tags inside fenced code blocks visible', () => {
    const result = splitInlineThinking(
      'before\n```\n<think>keep this</think>\n```\nafter',
    )
    expect(result.reasoning).toBe('')
    expect(result.content).toContain('<think>keep this</think>')
  })

  it('during streaming suppresses an unclosed leading <think> block', () => {
    const result = splitInlineThinking('<think>still reasoning', {
      streaming: true,
    })
    expect(result.reasoning).toBe('still reasoning')
    expect(result.content).toBe('')
    expect(result.inThinking).toBe(true)
  })
})

describe('chat-store history merge thinking preservation', () => {
  it('keeps realtime thinking when history poll returns text-only assistant', () => {
    const sessionKey = 'thinking-merge-session'
    const runId = 'run-thinking-merge'
    const liveId = `assistant:${runId}`
    const store = useChatStore.getState()
    store.clearSession(sessionKey)
    store.beginStreamingTurn({
      sessionKey,
      messageId: liveId,
      runId,
    })

    store.processEvent({
      type: 'thinking',
      text: 'Inspect the files first.',
      sessionKey,
      runId,
      transport: 'send-stream',
    })
    store.processEvent({
      type: 'chunk',
      text: 'All set.',
      fullReplace: true,
      sessionKey,
      runId,
      transport: 'send-stream',
    })
    store.processEvent({
      type: 'done',
      state: 'complete',
      sessionKey,
      runId,
      transport: 'send-stream',
    })

    const historyOnlyText: Array<ChatMessage> = [
      {
        id: 'hist-user',
        role: 'user',
        content: [{ type: 'text', text: 'go' }],
        timestamp: 1,
      },
      {
        id: 'hist-assistant',
        role: 'assistant',
        content: [{ type: 'text', text: 'All set.' }],
        timestamp: 2,
      },
    ]

    const merged = useChatStore
      .getState()
      .mergeHistoryMessages(sessionKey, historyOnlyText)

    const assistant = merged.find((message) => message.role === 'assistant')
    expect(assistant?.content).toEqual([
      { type: 'thinking', thinking: 'Inspect the files first.' },
      { type: 'text', text: 'All set.' },
    ])
    // Must keep write-through identity — swapping to hist-assistant remounts
    // the list row and jumps the transcript.
    const mergedId =
      typeof (assistant as { messageId?: unknown })?.messageId === 'string'
        ? (assistant as { messageId: string }).messageId
        : typeof (assistant as { id?: unknown })?.id === 'string'
          ? (assistant as { id: string }).id
          : ''
    expect(mergedId).toBe(liveId)
    expect(mergedId).not.toBe('hist-assistant')
  })
})

describe('chat-store history merge ordering', () => {
  it('preserves persisted history order when messages share a timestamp', () => {
    const messages: Array<ChatMessage> = [
      textMessage('m1', 'user', 'first question', 0),
      textMessage('m2', 'assistant', 'first answer', 1),
      textMessage('m3', 'user', 'follow-up', 2),
    ]

    const merged = useChatStore
      .getState()
      .mergeHistoryMessages('history-order-session', messages)

    expect(merged.map((message) => message.id)).toEqual(['m1', 'm2', 'm3'])
  })

  it('accepts local-store historyIndex as a persisted order hint', () => {
    const messages: Array<ChatMessage> = [
      {
        id: 'local-1',
        role: 'user',
        timestamp: 1_700_000_000_000,
        historyIndex: 0,
        content: [{ type: 'text', text: 'local question' }],
      },
      {
        id: 'local-2',
        role: 'assistant',
        timestamp: 1_700_000_000_000,
        historyIndex: 1,
        content: [{ type: 'text', text: 'local answer' }],
      },
      {
        id: 'local-3',
        role: 'user',
        timestamp: 1_700_000_000_000,
        historyIndex: 2,
        content: [{ type: 'text', text: 'local follow-up' }],
      },
    ]

    const merged = useChatStore
      .getState()
      .mergeHistoryMessages('local-history-order-session', messages)

    expect(merged.map((message) => message.id)).toEqual([
      'local-1',
      'local-2',
      'local-3',
    ])
  })
})

function resetStore(sessionKey: string) {
  useChatStore.getState().clearSession(sessionKey)
  useChatStore.getState().clearAllStreaming()
}

describe('clearStreamingSession', () => {
  it('drops orphaned streamingState and its sessionStorage mirror', () => {
    const sessionKey = 'orphan-stream-session'
    resetStore(sessionKey)
    const store = useChatStore.getState()

    store.processEvent({
      type: 'chunk',
      text: 'partial reply',
      sessionKey,
      transport: 'send-stream',
      runId: 'run-orphan',
    })
    expect(store.getStreamingState(sessionKey)?.text).toContain('partial')

    sessionStorage.setItem(
      `claude_streaming_${sessionKey}`,
      JSON.stringify({ text: 'stale', _savedAt: Date.now() }),
    )

    useChatStore.getState().clearStreamingSession(sessionKey)
    expect(useChatStore.getState().getStreamingState(sessionKey)).toBeNull()
    expect(sessionStorage.getItem(`claude_streaming_${sessionKey}`)).toBeNull()
  })
})

// Simulates the full upstream flow exactly as send-stream.ts emits after
// server-side thinking split + reasoning extraction:
//   tool.progress(reasoning.available) -> 'thinking' event
//   assistant.delta (visible text)     -> 'chunk' with fullReplace:true
describe('thinking + visible content through the stream store', () => {
  it('thinking event populates thinking state; chunk carries only visible text', () => {
    const sessionKey = 'e2e-1'
    resetStore(sessionKey)
    const store = useChatStore.getState()

    store.processEvent({
      type: 'thinking',
      text: 'Let me inspect the configuration first.',
      sessionKey,
      runId: 'run-e2e-1',
      transport: 'send-stream',
    })
    store.processEvent({
      type: 'chunk',
      text: 'I checked the config. Here is the answer.',
      fullReplace: true,
      sessionKey,
      runId: 'run-e2e-1',
      transport: 'send-stream',
    })

    const state = store.getStreamingState(sessionKey)
    expect(state?.thinking).toBe('Let me inspect the configuration first.')
    expect(state?.text).toBe('I checked the config. Here is the answer.')
  })

  it('done event builds a message that carries thinking content and clean text', () => {
    const sessionKey = 'e2e-2'
    resetStore(sessionKey)
    const store = useChatStore.getState()

    store.processEvent({
      type: 'thinking',
      text: 'reasoning trace',
      sessionKey,
      runId: 'run-e2e-2',
      transport: 'send-stream',
    })
    store.processEvent({
      type: 'chunk',
      text: 'final answer text',
      fullReplace: true,
      sessionKey,
      runId: 'run-e2e-2',
      transport: 'send-stream',
    })
    store.processEvent({
      type: 'done',
      state: 'complete',
      sessionKey,
      runId: 'run-e2e-2',
      transport: 'send-stream',
    })

    const messages = store.getRealtimeMessages(sessionKey)
    const assistant = messages.find((m) => m.role === 'assistant')
    expect(assistant).toBeDefined()
    const content = assistant?.content
    expect(Array.isArray(content)).toBe(true)
    const thinkingPart = (
      content as Array<{ type: string; thinking?: string }>
    ).find((p) => p.type === 'thinking')
    const textPart = (
      content as Array<{ type: string; text?: string }>
    ).find((p) => p.type === 'text')
    expect(thinkingPart?.thinking).toBe('reasoning trace')
    expect(textPart?.text).toBe('final answer text')
  })

  it('write-through keeps one durable messageId from first chunk through settle', () => {
    const sessionKey = 'e2e-write-through'
    resetStore(sessionKey)
    const store = useChatStore.getState()

    store.processEvent({
      type: 'chunk',
      text: '',
      fullReplace: true,
      sessionKey,
      runId: 'run-42',
      transport: 'send-stream',
    })
    store.processEvent({
      type: 'thinking',
      text: 'live plan',
      sessionKey,
      runId: 'run-42',
      transport: 'send-stream',
    })
    store.processEvent({
      type: 'chunk',
      text: 'Answer',
      fullReplace: true,
      sessionKey,
      runId: 'run-42',
      transport: 'send-stream',
    })
    store.processEvent({
      type: 'done',
      state: 'complete',
      sessionKey,
      runId: 'run-42',
      transport: 'send-stream',
    })

    const messages = store.getRealtimeMessages(sessionKey)
    const assistants = messages.filter((m) => m.role === 'assistant')
    expect(assistants).toHaveLength(1)
    expect(assistants[0]?.id).toBe('assistant:run-42')
    expect(assistants[0]?.messageId).toBe('assistant:run-42')
    expect(assistants[0]?.__streamingStatus).toBe('complete')
    const content = assistants[0]?.content as Array<{
      type: string
      thinking?: string
      text?: string
    }>
    expect(content.find((p) => p.type === 'thinking')?.thinking).toBe(
      'live plan',
    )
    expect(content.find((p) => p.type === 'text')?.text).toBe('Answer')
  })

  it('done.message without thinking still folds streaming thinking into Activity', () => {
    const sessionKey = 'e2e-done-message-think'
    resetStore(sessionKey)
    const store = useChatStore.getState()

    store.processEvent({
      type: 'thinking',
      text: 'live reasoning before tools',
      sessionKey,
      runId: 'run-done-think',
      transport: 'send-stream',
    })
    store.processEvent({
      type: 'tool',
      phase: 'complete',
      name: 'read_file',
      toolCallId: 'tc-1',
      sessionKey,
      runId: 'run-done-think',
      transport: 'send-stream',
    })
    store.processEvent({
      type: 'done',
      state: 'complete',
      sessionKey,
      runId: 'run-done-think',
      transport: 'send-stream',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Done.' }],
      },
    })

    const messages = store.getRealtimeMessages(sessionKey)
    const assistant = messages.find((m) => m.role === 'assistant')
    const content = assistant?.content as Array<{
      type: string
      thinking?: string
      text?: string
    }>
    expect(content.find((p) => p.type === 'thinking')?.thinking).toBe(
      'live reasoning before tools',
    )
    expect(content.find((p) => p.type === 'text')?.text).toBe('Done.')
    expect((assistant as any).__streamToolCalls?.length).toBe(1)
  })

  it('a second done keeps the Working card tools after streaming state is gone', () => {
    const sessionKey = 'e2e-second-done-keeps-tools'
    resetStore(sessionKey)
    const store = useChatStore.getState()

    store.processEvent({
      type: 'thinking',
      text: 'look up the file',
      sessionKey,
      runId: 'run-9',
      transport: 'send-stream',
    })
    store.processEvent({
      type: 'tool',
      phase: 'calling',
      name: 'read_file',
      toolCallId: 'tc-9',
      sessionKey,
      runId: 'run-9',
      transport: 'send-stream',
    })
    store.processEvent({
      type: 'done',
      state: 'final',
      sessionKey,
      runId: 'run-9',
      transport: 'send-stream',
    })
    store.processEvent({
      type: 'done',
      state: 'complete',
      sessionKey,
      runId: 'run-9',
      transport: 'send-stream',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'partial' }],
      },
    })

    const assistant = store
      .getRealtimeMessages(sessionKey)
      .find((message) => message.role === 'assistant')
    const content = assistant?.content as Array<{
      type: string
      thinking?: string
      name?: string
      text?: string
    }>
    expect(content.find((part) => part.type === 'thinking')?.thinking).toBe(
      'look up the file',
    )
    expect(content.find((part) => part.type === 'toolCall')?.name).toBe(
      'read_file',
    )
    expect(content.find((part) => part.type === 'text')?.text).toBe('partial')
    expect((assistant as { __streamToolCalls?: Array<unknown> }).__streamToolCalls)
      .toHaveLength(1)
  })

  it('message.started does not replace a thinking-only Working row', () => {
    const sessionKey = 'e2e-started-keeps-working'
    resetStore(sessionKey)
    const store = useChatStore.getState()

    store.processEvent({
      type: 'thinking',
      text: 'still planning',
      sessionKey,
      runId: 'run-started',
      transport: 'send-stream',
    })
    store.clearStreamingSession(sessionKey)
    store.processEvent({
      type: 'message',
      sessionKey,
      transport: 'send-stream',
      message: {
        role: 'assistant',
        content: [],
      },
    })

    const assistants = store
      .getRealtimeMessages(sessionKey)
      .filter((message) => message.role === 'assistant')
    expect(assistants).toHaveLength(1)
    const content = assistants[0]?.content as Array<{
      type: string
      thinking?: string
    }>
    expect(content.find((part) => part.type === 'thinking')?.thinking).toBe(
      'still planning',
    )
  })

  it('beginStreamingTurn keeps prior settled write-through (no history remount)', () => {
    const sessionKey = 'e2e-keep-settled-on-next-turn'
    resetStore(sessionKey)
    const store = useChatStore.getState()

    store.beginStreamingTurn({
      sessionKey,
      messageId: 'assistant:run-prev',
      runId: 'run-prev',
    })
    store.processEvent({
      type: 'chunk',
      text: 'first reply',
      fullReplace: true,
      sessionKey,
      runId: 'run-prev',
      transport: 'send-stream',
    })
    store.processEvent({
      type: 'done',
      state: 'complete',
      sessionKey,
      runId: 'run-prev',
      transport: 'send-stream',
    })

    store.beginStreamingTurn({
      sessionKey,
      messageId: 'assistant:pending:next-turn',
    })

    const assistants = store
      .getRealtimeMessages(sessionKey)
      .filter((message) => message.role === 'assistant')
    expect(
      assistants.some(
        (message) => (message as { id?: string }).id === 'assistant:run-prev',
      ),
    ).toBe(true)
    expect(
      assistants.some(
        (message) =>
          (message as { id?: string }).id === 'assistant:pending:next-turn',
      ),
    ).toBe(true)
    expect(
      assistants.find(
        (message) => (message as { id?: string }).id === 'assistant:run-prev',
      )?.__streamingStatus,
    ).toBe('complete')
  })

  it('empty done after beginStreamingTurn keeps the seeded host for finishStream', () => {
    const sessionKey = 'e2e-empty-done-keeps-seed'
    resetStore(sessionKey)
    const store = useChatStore.getState()
    const messageId = `assistant:pending:${sessionKey}:turn-empty`

    store.beginStreamingTurn({ sessionKey, messageId })
    expect(
      store
        .getRealtimeMessages(sessionKey)
        .some((message) => (message as { id?: string }).id === messageId),
    ).toBe(true)

    store.processEvent({
      type: 'done',
      state: 'complete',
      sessionKey,
      transport: 'send-stream',
    })

    // Premature empty done must leave Working anchored; finishStream settles next.
    expect(
      store
        .getRealtimeMessages(sessionKey)
        .some((message) => (message as { id?: string }).id === messageId),
    ).toBe(true)
    expect(store.getStreamingState(sessionKey)?.messageId).toBe(messageId)

    store.processEvent({
      type: 'done',
      state: 'complete',
      sessionKey,
      transport: 'send-stream',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '你好' }],
      },
    })

    const assistant = store
      .getRealtimeMessages(sessionKey)
      .find((message) => message.role === 'assistant')
    const content = assistant?.content as Array<{ type: string; text?: string }>
    expect(content.find((part) => part.type === 'text')?.text).toBe('你好')
    expect(store.getStreamingState(sessionKey)).toBeNull()
  })
})
