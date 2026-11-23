import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  hasHermesCanonicalMessages,
  hermesCanonicalMessagesToChatHistory,
  listHermesCanonicalMessages,
  persistHermesCanonicalTurnFrame,
  upsertHermesCanonicalMessage,
} from './hermes-canonical-store'

describe('hermes canonical store', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  })

  function tempDb(): string {
    const dir = mkdtempSync(join(tmpdir(), 'hermes-canonical-'))
    dirs.push(dir)
    return join(dir, 'collab.db')
  }

  it('persists strong ids and reloads without msg-N', () => {
    const db = tempDb()
    persistHermesCanonicalTurnFrame({
      agentSessionId: 'sess-1',
      profileName: 'default',
      clientSubmitId: 'submit-a',
      userText: '继续',
      hermesRunId: 'run-a',
      assistantText: '',
      status: 'streaming',
      dbPath: db,
    })
    persistHermesCanonicalTurnFrame({
      agentSessionId: 'sess-1',
      profileName: 'default',
      clientSubmitId: 'submit-a',
      hermesRunId: 'run-a',
      assistantText: '收到，继续。',
      status: 'completed',
      settled: true,
      dbPath: db,
    })

    expect(hasHermesCanonicalMessages({ agentSessionId: 'sess-1', dbPath: db })).toBe(
      true,
    )
    const page = listHermesCanonicalMessages({
      agentSessionId: 'sess-1',
      dbPath: db,
    })
    expect(page.messages.map((m) => m.messageId)).toEqual([
      'user:submit-a',
      'assistant:run-a',
    ])
    const chat = hermesCanonicalMessagesToChatHistory(page.messages)
    expect(chat.map((m) => m.id)).toEqual(['user:submit-a', 'assistant:run-a'])
    expect(chat.every((m) => !String(m.id).startsWith('msg-'))).toBe(true)
  })

  it('keeps two same-text turns under distinct submit ids', () => {
    const db = tempDb()
    for (const [submit, run] of [
      ['submit-1', 'run-1'],
      ['submit-2', 'run-2'],
    ] as const) {
      persistHermesCanonicalTurnFrame({
        agentSessionId: 'sess-dup',
        clientSubmitId: submit,
        userText: '继续',
        hermesRunId: run,
        assistantText: `reply-${run}`,
        status: 'completed',
        settled: true,
        dbPath: db,
      })
    }
    const page = listHermesCanonicalMessages({
      agentSessionId: 'sess-dup',
      dbPath: db,
    })
    expect(page.messages.filter((m) => m.role === 'user')).toHaveLength(2)
    expect(page.messages.map((m) => m.messageId)).toEqual([
      'user:submit-1',
      'assistant:run-1',
      'user:submit-2',
      'assistant:run-2',
    ])
  })

  it('version-monotonic replace on same messageId', () => {
    const db = tempDb()
    upsertHermesCanonicalMessage({
      agentSessionId: 'sess-v',
      messageId: 'assistant:run-v',
      role: 'assistant',
      payload: { text: 'partial' },
      status: 'streaming',
      dbPath: db,
    })
    upsertHermesCanonicalMessage({
      agentSessionId: 'sess-v',
      messageId: 'assistant:run-v',
      role: 'assistant',
      payload: { text: 'final' },
      status: 'completed',
      dbPath: db,
    })
    const page = listHermesCanonicalMessages({
      agentSessionId: 'sess-v',
      dbPath: db,
    })
    expect(page.messages).toHaveLength(1)
    expect(page.messages[0]?.payload.text).toBe('final')
    expect(page.messages[0]?.version).toBeGreaterThan(1)
  })
})
