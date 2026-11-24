import { describe, expect, it } from 'vitest'
import type { AgentActivityMessage } from '@agorax/agent-activity-core'
import {
  collapseAdjacentAssistantEchoes,
  foldAssistantsPerUserTurn,
  projectActivityMessagesToChat,
  relocateTurnAssistantsAfterUser,
} from './activity-list-projection'
import type { ChatMessage } from '../types'

describe('collapseAdjacentAssistantEchoes', () => {
  it('keeps richer pending host when a suffix echo follows', () => {
    const long =
      'Cross-compile is done. Multi-model still crashes on deinit. Integrate or fix crash first?'
    const collapsed = collapseAdjacentAssistantEchoes([
      {
        id: 'assistant:pending:s:c1',
        messageId: 'assistant:pending:s:c1',
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'check report' },
          { type: 'text', text: `I need to check.\n\n${long}` },
        ],
        timestamp: 1,
      } as ChatMessage,
      {
        id: 'msg-9',
        messageId: 'msg-9',
        role: 'assistant',
        content: [{ type: 'text', text: long }],
        timestamp: 2,
      } as ChatMessage,
    ])
    expect(collapsed).toHaveLength(1)
    expect(collapsed[0]?.id).toBe('assistant:pending:s:c1')
    expect(collapsed[0]?.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'thinking' }),
        expect.objectContaining({ type: 'text' }),
      ]),
    )
  })
})

describe('foldAssistantsPerUserTurn', () => {
  it('merges thinking-only orphan under the reply into one host', () => {
    const folded = foldAssistantsPerUserTurn([
      {
        id: 'u1',
        role: 'user',
        content: [{ type: 'text', text: '还需要干什么？' }],
        timestamp: 1,
      } as ChatMessage,
      {
        id: 'assistant:reply',
        messageId: 'assistant:reply',
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: '是的，之前已经分析过：\n\n- IO tensor → context',
          },
        ],
        timestamp: 2,
        __streamingStatus: 'complete',
      } as ChatMessage,
      {
        id: 'assistant:orphan-think',
        messageId: 'assistant:orphan-think',
        role: 'assistant',
        content: [
          {
            type: 'thinking',
            thinking:
              'User is asking what needs to be done. They communicate in Chinese.',
          },
        ],
        timestamp: 3,
        __streamingStatus: 'complete',
      } as ChatMessage,
    ])
    expect(folded.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(folded[1]?.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'thinking',
          thinking: expect.stringContaining('what needs to be done'),
        }),
        expect.objectContaining({
          type: 'text',
          text: '是的，之前已经分析过：\n\n- IO tensor → context',
        }),
      ]),
    )
  })

  it('keeps fences when a turn has two assistant text rows', () => {
    const intro =
      'udev 规则没生效。可能是 subsystem 不匹配或设备名不对，我来诊断一下。'
    const body = [
      '找到原因了：',
      '',
      '## 需要你手动在板端执行',
      '',
      '```bash',
      "sudo tee /etc/udev/rules.d/99-allspark-npu.rules <<'EOF'",
      'KERNEL=="ad_npu_procfs_c1", MODE="0666"',
      'EOF',
      '```',
    ].join('\n')
    const folded = foldAssistantsPerUserTurn([
      {
        id: 'u1',
        role: 'user',
        content: [{ type: 'text', text: 'run it' }],
        timestamp: 1,
      } as ChatMessage,
      {
        id: 'msg-16292',
        messageId: 'msg-16292',
        role: 'assistant',
        content: [{ type: 'text', text: intro }],
        timestamp: 2,
      } as ChatMessage,
      {
        id: 'msg-16298',
        messageId: 'msg-16298',
        role: 'assistant',
        content: [{ type: 'text', text: body }],
        timestamp: 3,
      } as ChatMessage,
    ])
    expect(folded.map((message) => message.role)).toEqual([
      'user',
      'assistant',
    ])
    const text = folded[1]?.content?.find((part) => part.type === 'text')?.text
    expect(text).toBe(`${intro}\n\n${body}`)
  })

  it('folds a trailing thinking-only host into the prior assistant', () => {
    const reply =
      '收到 probe 1793622898089。我这边在线，可以正常响应。\n\n这是连接测试，还是你有一个具体任务？'
    const folded = foldAssistantsPerUserTurn([
      {
        id: 'u1',
        role: 'user',
        content: [{ type: 'text', text: 'probe' }],
        timestamp: 1,
      } as ChatMessage,
      {
        id: 'assistant:client-uuid',
        messageId: 'assistant:client-uuid',
        turnId: 'turn-client',
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: reply },
          { type: 'text', text: reply },
        ],
        timestamp: 2,
      } as ChatMessage,
      {
        id: 'assistant:run_abc',
        messageId: 'assistant:run_abc',
        turnId: 'turn-run_abc',
        role: 'assistant',
        content: [{ type: 'thinking', thinking: reply }],
        timestamp: 3,
      } as ChatMessage,
    ])
    expect(folded.map((message) => message.role)).toEqual([
      'user',
      'assistant',
    ])
  })

  it('does not mash distinct turn reply bodies when users were reordered away', () => {
    // Chronology bugs can yield UUUAAA; fold must still keep one host per turn.
    const folded = foldAssistantsPerUserTurn([
      {
        id: 'u1',
        role: 'user',
        content: [{ type: 'text', text: '你好' }],
        timestamp: 1,
      } as ChatMessage,
      {
        id: 'u2',
        role: 'user',
        content: [{ type: 'text', text: '你是谁？' }],
        timestamp: 1,
      } as ChatMessage,
      {
        id: 'u3',
        role: 'user',
        content: [{ type: 'text', text: '你在干什么？' }],
        timestamp: 1,
      } as ChatMessage,
      {
        id: 'assistant:r1',
        messageId: 'assistant:r1',
        turnId: 'turn-c1',
        runId: 'r1',
        role: 'assistant',
        content: [{ type: 'text', text: '你好！有什么我可以帮你的吗？' }],
        timestamp: 1,
      } as ChatMessage,
      {
        id: 'assistant:r2',
        messageId: 'assistant:r2',
        turnId: 'turn-c2',
        runId: 'r2',
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: '我是 Architect Agent，一个系统架构与技术规格 Agent。',
          },
        ],
        timestamp: 1,
      } as ChatMessage,
      {
        id: 'assistant:r3',
        messageId: 'assistant:r3',
        turnId: 'turn-c3',
        runId: 'r3',
        role: 'assistant',
        content: [{ type: 'text', text: '我目前没在跑任何具体任务。' }],
        timestamp: 1,
      } as ChatMessage,
    ])
    expect(folded.map((message) => message.role)).toEqual([
      'user',
      'user',
      'user',
      'assistant',
      'assistant',
      'assistant',
    ])
    const texts = folded
      .filter((message) => message.role === 'assistant')
      .map(
        (message) =>
          message.content?.find((part) => part.type === 'text')?.text ?? '',
      )
    expect(texts).toEqual([
      '你好！有什么我可以帮你的吗？',
      '我是 Architect Agent，一个系统架构与技术规格 Agent。',
      '我目前没在跑任何具体任务。',
    ])
  })

  it('does not append a segment already inside the longer host', () => {
    const body = '找到原因了：\n\n```bash\necho hi\n```'
    const live = `先看一下。\n\n${body}`
    const folded = foldAssistantsPerUserTurn([
      {
        id: 'u1',
        role: 'user',
        content: [{ type: 'text', text: 'run it' }],
        timestamp: 1,
      } as ChatMessage,
      {
        id: 'assistant:run-1',
        messageId: 'assistant:run-1',
        role: 'assistant',
        content: [{ type: 'text', text: live }],
        timestamp: 2,
      } as ChatMessage,
      {
        id: 'msg-16298',
        messageId: 'msg-16298',
        role: 'assistant',
        content: [{ type: 'text', text: body }],
        timestamp: 3,
      } as ChatMessage,
    ])
    const text = folded[1]?.content?.find((part) => part.type === 'text')?.text
    expect(text).toBe(live)
  })
})

describe('projectActivityMessagesToChat', () => {
  it('folds pending + runId text of the same turn into one host', () => {
    const messages = projectActivityMessagesToChat([
      {
        workspaceId: 'ws',
        agentSessionId: 's',
        messageId: 'user:c1',
        turnId: 'turn-c1',
        role: 'user',
        kind: 'text',
        payload: { text: 'hi' },
        version: 1,
        sequence: 1,
        occurredAtUnixMs: 1,
      },
      {
        workspaceId: 'ws',
        agentSessionId: 's',
        messageId: 'assistant:pending:s:c1',
        turnId: 'turn-c1',
        role: 'assistant',
        kind: 'text',
        status: 'streaming',
        payload: { text: '' },
        version: 2,
        sequence: 2,
        occurredAtUnixMs: 2,
      },
      {
        workspaceId: 'ws',
        agentSessionId: 's',
        messageId: 'assistant:run-9',
        turnId: 'turn-c1',
        role: 'assistant',
        kind: 'text',
        status: 'streaming',
        payload: { text: 'hello from run' },
        version: 3,
        sequence: 3,
        occurredAtUnixMs: 3,
      },
    ])
    expect(messages.map((m) => m.id)).toEqual([
      'user:c1',
      'assistant:pending:s:c1',
    ])
    expect(messages[1]?.content).toEqual([
      { type: 'text', text: 'hello from run' },
    ])
  })

  it('folds daemon text-then-thinking into one host with Activity above reply', () => {
    const reply = '你好！有什么我可以帮你的吗？'
    const messages = projectActivityMessagesToChat([
      {
        workspaceId: 'ws',
        agentSessionId: 's',
        messageId: 'user:c1',
        turnId: 'turn-c1',
        role: 'user',
        kind: 'text',
        payload: { text: 'hi' },
        version: 1,
        sequence: 1,
        occurredAtUnixMs: 1,
      },
      {
        workspaceId: 'ws',
        agentSessionId: 's',
        messageId: 'assistant:run-1',
        turnId: 'turn-c1',
        role: 'assistant',
        kind: 'text',
        status: 'completed',
        payload: { text: reply },
        version: 2,
        sequence: 2,
        occurredAtUnixMs: 2,
      },
      {
        workspaceId: 'ws',
        agentSessionId: 's',
        messageId: 'assistant:run-1:thinking',
        turnId: 'turn-c1',
        role: 'assistant',
        kind: 'reasoning',
        status: 'completed',
        payload: { text: reply },
        version: 3,
        sequence: 3,
        occurredAtUnixMs: 3,
      },
    ])
    expect(messages.map((m) => m.id)).toEqual(['user:c1', 'assistant:run-1'])
    expect(messages[1]?.content).toEqual([
      { type: 'thinking', thinking: reply },
      { type: 'text', text: reply },
    ])
  })

  it('folds trailing thinking-only into the reply host without dropping reasoning', () => {
    const reply =
      '收到 probe 1793622898089。我这边在线，可以正常响应。\n\n这是连接测试，还是你有一个具体任务？'
    const messages = projectActivityMessagesToChat([
      {
        workspaceId: 'ws',
        agentSessionId: 's',
        messageId: 'user:c1',
        turnId: 'turn-c1',
        role: 'user',
        kind: 'text',
        payload: { text: 'probe' },
        version: 1,
        sequence: 1,
        occurredAtUnixMs: 1,
      },
      {
        workspaceId: 'ws',
        agentSessionId: 's',
        messageId: 'assistant:client-uuid:thinking',
        turnId: 'turn-c1',
        role: 'assistant_thinking',
        kind: 'reasoning',
        status: 'completed',
        payload: { text: reply },
        version: 2,
        sequence: 2,
        occurredAtUnixMs: 2,
      },
      {
        workspaceId: 'ws',
        agentSessionId: 's',
        messageId: 'assistant:client-uuid',
        turnId: 'turn-c1',
        role: 'assistant',
        kind: 'text',
        status: 'completed',
        payload: { text: reply },
        version: 3,
        sequence: 3,
        occurredAtUnixMs: 3,
      },
      {
        workspaceId: 'ws',
        agentSessionId: 's',
        messageId: 'assistant:run_abc:thinking',
        turnId: 'turn-run_abc',
        role: 'assistant_thinking',
        kind: 'reasoning',
        status: 'completed',
        payload: { text: reply },
        version: 4,
        sequence: 4,
        occurredAtUnixMs: 4,
      },
    ])
    expect(messages.map((m) => m.id)).toEqual([
      'user:c1',
      'assistant:client-uuid',
    ])
    expect(messages[1]?.content).toEqual([
      { type: 'thinking', thinking: reply },
      { type: 'text', text: reply },
    ])
  })
})

describe('relocateTurnAssistantsAfterUser', () => {
  it('moves same-turn thinking/text that sorted above the new user back under it', () => {
    const rows: AgentActivityMessage[] = [
      {
        workspaceId: 'ws',
        agentSessionId: 's',
        messageId: 'user:c1',
        turnId: 'turn-c1',
        role: 'user',
        kind: 'text',
        payload: { text: '旧问题' },
        version: 1,
        sequence: 1,
        occurredAtUnixMs: 1,
      },
      {
        workspaceId: 'ws',
        agentSessionId: 's',
        messageId: 'assistant:run-1',
        turnId: 'turn-c1',
        role: 'assistant',
        kind: 'text',
        payload: { text: '旧答复' },
        version: 2,
        sequence: 2,
        occurredAtUnixMs: 2,
      },
      // Same-ms overlay seed: assistant ids localeCompare before user:* —
      // without relocate, new reply paints above the new question and again below.
      {
        workspaceId: 'ws',
        agentSessionId: 's',
        messageId: 'assistant:run-2:thinking',
        turnId: 'turn-c2',
        role: 'assistant_thinking',
        kind: 'reasoning',
        payload: { text: '新一轮思考也像答复' },
        version: 0,
        occurredAtUnixMs: 10,
      },
      {
        workspaceId: 'ws',
        agentSessionId: 's',
        messageId: 'user:c2',
        turnId: 'turn-c2',
        role: 'user',
        kind: 'text',
        payload: { text: '新问题' },
        version: 0,
        occurredAtUnixMs: 10,
      },
      {
        workspaceId: 'ws',
        agentSessionId: 's',
        messageId: 'assistant:run-2',
        turnId: 'turn-c2',
        role: 'assistant',
        kind: 'text',
        payload: { text: '新一轮答复' },
        version: 0,
        occurredAtUnixMs: 11,
      },
    ]
    expect(relocateTurnAssistantsAfterUser(rows).map((r) => r.messageId)).toEqual([
      'user:c1',
      'assistant:run-1',
      'user:c2',
      'assistant:run-2:thinking',
      'assistant:run-2',
    ])
    const chat = projectActivityMessagesToChat(rows)
    expect(chat.map((m) => m.messageId ?? m.id)).toEqual([
      'user:c1',
      'assistant:run-1',
      'user:c2',
      'assistant:run-2',
    ])
    expect(chat[1]?.content).toEqual([{ type: 'text', text: '旧答复' }])
    expect(chat[3]?.content).toEqual([
      { type: 'thinking', thinking: '新一轮思考也像答复' },
      { type: 'text', text: '新一轮答复' },
    ])
  })

  it('does not absorb next-turn thinking into a prior empty assistant:run shell', () => {
    // Repro from /chat/4b650f5f-…: leftover live run host under the previous
    // user + new thinking sorted above the new user → "好" painted twice.
    const rows: AgentActivityMessage[] = [
      {
        workspaceId: 'ws',
        agentSessionId: 's',
        messageId: 'user:old',
        turnId: 'turn-old',
        role: 'user',
        kind: 'text',
        payload: { text: '为啥呢？' },
        version: 1,
        sequence: 1,
        occurredAtUnixMs: 1,
      },
      {
        workspaceId: 'ws',
        agentSessionId: 's',
        messageId: 'assistant:run_leftover',
        turnId: 'turn-old',
        role: 'assistant',
        kind: 'text',
        status: 'streaming',
        payload: { text: '' },
        version: 2,
        sequence: 2,
        occurredAtUnixMs: 2,
      },
      {
        workspaceId: 'ws',
        agentSessionId: 's',
        messageId: 'msg-2224',
        turnId: 'turn-old',
        role: 'assistant',
        kind: 'text',
        status: 'completed',
        payload: { text: '旧答复正文' },
        version: 3,
        sequence: 3,
        occurredAtUnixMs: 3,
      },
      {
        workspaceId: 'ws',
        agentSessionId: 's',
        messageId: 'assistant:run_new:thinking',
        turnId: 'turn-new',
        role: 'assistant_thinking',
        kind: 'reasoning',
        payload: { text: '好' },
        version: 0,
        occurredAtUnixMs: 10,
      },
      {
        workspaceId: 'ws',
        agentSessionId: 's',
        messageId: 'user:new',
        turnId: 'turn-new',
        role: 'user',
        kind: 'text',
        payload: { text: '只回复一个字：好' },
        version: 0,
        occurredAtUnixMs: 10,
      },
      {
        workspaceId: 'ws',
        agentSessionId: 's',
        messageId: 'assistant:run_new',
        turnId: 'turn-new',
        role: 'assistant',
        kind: 'text',
        payload: { text: '好' },
        version: 0,
        occurredAtUnixMs: 11,
      },
    ]
    const chat = projectActivityMessagesToChat(rows)
    const ids = chat.map((m) => m.messageId ?? m.id)
    // Prefer the completed body host over the empty streaming leftover shell.
    expect(ids).toEqual([
      'user:old',
      'msg-2224',
      'user:new',
      'assistant:run_new',
    ])
    const oldHost = chat[1]!
    const newHost = chat[3]!
    expect(JSON.stringify(oldHost)).not.toContain('"好"')
    expect(oldHost.content).toEqual([{ type: 'text', text: '旧答复正文' }])
    expect(newHost.content).toEqual([
      { type: 'thinking', thinking: '好' },
      { type: 'text', text: '好' },
    ])
  })

  it('does not replace prior reply when next-turn longer text sorts above user', () => {
    const rows: AgentActivityMessage[] = [
      {
        workspaceId: 'ws',
        agentSessionId: 's',
        messageId: 'user:t1',
        turnId: 'turn-t1',
        role: 'user',
        kind: 'text',
        payload: { text: '你好吗？' },
        version: 1,
        sequence: 1,
        occurredAtUnixMs: 1,
      },
      {
        workspaceId: 'ws',
        agentSessionId: 's',
        messageId: 'assistant:uuid-shell',
        turnId: 'turn-t1',
        role: 'assistant',
        kind: 'text',
        status: 'streaming',
        payload: { text: '' },
        version: 2,
        sequence: 2,
        occurredAtUnixMs: 2,
      },
      {
        workspaceId: 'ws',
        agentSessionId: 's',
        messageId: 'assistant:run_t1',
        turnId: 'turn-t1',
        role: 'assistant',
        kind: 'text',
        status: 'completed',
        payload: { text: '好。' },
        version: 3,
        sequence: 3,
        occurredAtUnixMs: 3,
      },
      {
        workspaceId: 'ws',
        agentSessionId: 's',
        messageId: 'assistant:run_t2:thinking',
        turnId: 'turn-t2',
        role: 'assistant_thinking',
        kind: 'reasoning',
        payload: { text: '等待你的下一步指令。' },
        version: 0,
        occurredAtUnixMs: 10,
      },
      {
        workspaceId: 'ws',
        agentSessionId: 's',
        messageId: 'assistant:run_t2',
        turnId: 'turn-t2',
        role: 'assistant',
        kind: 'text',
        payload: { text: '等待你的下一步指令。' },
        version: 0,
        occurredAtUnixMs: 11,
      },
      {
        workspaceId: 'ws',
        agentSessionId: 's',
        messageId: 'user:t2',
        turnId: 'turn-t2',
        role: 'user',
        kind: 'text',
        payload: { text: '在干嘛？' },
        version: 0,
        occurredAtUnixMs: 10,
      },
    ]
    const chat = projectActivityMessagesToChat(rows)
    expect(chat.map((m) => m.messageId ?? m.id)).toEqual([
      'user:t1',
      'assistant:run_t1',
      'user:t2',
      'assistant:run_t2',
    ])
    expect(chat[1]?.content).toEqual([{ type: 'text', text: '好。' }])
    expect(JSON.stringify(chat[1])).not.toContain('等待你的下一步指令')
    expect(chat[3]?.content).toEqual([
      { type: 'thinking', thinking: '等待你的下一步指令。' },
      { type: 'text', text: '等待你的下一步指令。' },
    ])
  })
})
