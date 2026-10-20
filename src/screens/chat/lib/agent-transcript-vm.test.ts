import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../types'
import {
  isOpenTurnAssistantUnderProcessing,
  projectChatToTranscriptRows,
  transcriptHasOpenTurnFace,
} from './agent-transcript-vm'

function user(id: string, text: string): ChatMessage {
  return {
    id,
    messageId: id,
    role: 'user',
    content: [{ type: 'text', text }],
    timestamp: 1,
  }
}

function assistant(
  id: string,
  opts: { text?: string; thinking?: string; streaming?: boolean } = {},
): ChatMessage {
  const content: ChatMessage['content'] = []
  if (opts.thinking) content!.push({ type: 'thinking', thinking: opts.thinking })
  if (opts.text) content!.push({ type: 'text', text: opts.text })
  return {
    id,
    messageId: id,
    role: 'assistant',
    content,
    timestamp: 2,
    __streamingStatus: opts.streaming ? 'streaming' : 'complete',
  }
}

describe('projectChatToTranscriptRows', () => {
  it('emits processing face when busy with user only', () => {
    const rows = projectChatToTranscriptRows([user('user:c1', 'hi')], {
      turnBusy: true,
      openTurnKey: 'c1',
    })
    expect(rows.map((r) => r.kind)).toEqual(['message', 'processing'])
    expect(rows[1]).toMatchObject({
      kind: 'processing',
      key: 'processing:c1',
    })
    expect(transcriptHasOpenTurnFace(rows)).toBe(true)
  })

  it('keeps the same processing key when durable assistant arrives', () => {
    const rows = projectChatToTranscriptRows(
      [
        user('user:c1', 'hi'),
        assistant('assistant:run-1', {
          text: 'ok',
          thinking: '…',
          streaming: true,
        }),
      ],
      {
        turnBusy: true,
        streamingMessageId: 'assistant:run-1',
        openTurnKey: 'c1',
      },
    )
    expect(rows.map((r) => r.kind)).toEqual([
      'message',
      'processing',
      'message',
    ])
    expect(rows[1]?.key).toBe('processing:c1')
    expect(rows[2]?.key).toBe('assistant:run-1')
    expect(isOpenTurnAssistantUnderProcessing(rows, 2)).toBe(true)
  })

  it('settled turn drops processing; durable message keeps its key', () => {
    const rows = projectChatToTranscriptRows([
      user('user:1', 'hi'),
      assistant('assistant:run-1', { text: 'hey', thinking: 'plan' }),
    ])
    expect(rows.map((r) => r.kind)).toEqual(['message', 'message'])
    expect(rows[1]?.key).toBe('assistant:run-1')
    expect(transcriptHasOpenTurnFace(rows)).toBe(false)
  })
})
