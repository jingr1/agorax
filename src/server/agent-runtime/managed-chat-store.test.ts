/** @vitest-environment node */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  appendManagedChatMessage,
  ensureManagedChatSession,
  listManagedChatSessions,
  recordNativeSessionId,
  resolveNativeSessionForRun,
} from './managed-chat-store'

describe('managed-chat-store', () => {
  const dirs: Array<string> = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  function tempDb(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-chat-'))
    dirs.push(dir)
    return path.join(dir, 'collab.db')
  }

  it('allocates native session then resumes after record', () => {
    const dbPath = tempDb()
    ensureManagedChatSession({
      id: 'sess-1',
      agentId: 'cc-impl',
      dbPath,
    })
    const first = resolveNativeSessionForRun({ sessionId: 'sess-1', dbPath })
    expect(first.resume).toBe(false)
    expect(first.nativeSessionId.length).toBeGreaterThan(8)

    recordNativeSessionId({
      sessionId: 'sess-1',
      nativeSessionId: first.nativeSessionId,
      dbPath,
    })
    const second = resolveNativeSessionForRun({ sessionId: 'sess-1', dbPath })
    expect(second).toEqual({
      nativeSessionId: first.nativeSessionId,
      resume: true,
    })
  })

  it('lists sessions with message titles', () => {
    const dbPath = tempDb()
    ensureManagedChatSession({
      id: 'sess-2',
      agentId: 'cc-impl',
      dbPath,
    })
    appendManagedChatMessage({
      sessionId: 'sess-2',
      role: 'user',
      content: [{ type: 'text', text: 'hello world from user' }],
      titleFromText: 'hello world from user',
      dbPath,
    })
    const listed = listManagedChatSessions('cc-impl', { dbPath })
    expect(listed).toHaveLength(1)
    expect(listed[0]?.title).toBe('hello world from user')
    expect(listed[0]?.summary).toContain('1')
  })

  it('keeps the native session resume state machine consistent', () => {
    const dbPath = tempDb()
    ensureManagedChatSession({
      id: 'sess-resume',
      agentId: 'cc-impl',
      dbPath,
    })

    expect(() =>
      resolveNativeSessionForRun({ sessionId: 'missing', dbPath }),
    ).toThrow(/managed chat session not found/)

    // First turn allocates a fresh native id and is not allowed to resume.
    const first = resolveNativeSessionForRun({
      sessionId: 'sess-resume',
      dbPath,
    })
    expect(first.resume).toBe(false)
    expect(first.nativeSessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    )

    // Until the run reports completion, repeated calls must reuse the same id.
    expect(
      resolveNativeSessionForRun({ sessionId: 'sess-resume', dbPath }),
    ).toEqual(first)

    // Run completes: record the native id flips the session to resume-ready.
    recordNativeSessionId({
      sessionId: 'sess-resume',
      nativeSessionId: first.nativeSessionId,
      dbPath,
    })
    expect(
      resolveNativeSessionForRun({ sessionId: 'sess-resume', dbPath }),
    ).toEqual({
      nativeSessionId: first.nativeSessionId,
      resume: true,
    })

    // If a later run ends up with a different native id, resume target follows it.
    const redirectedNative = 'cc-native-redirected'
    recordNativeSessionId({
      sessionId: 'sess-resume',
      nativeSessionId: redirectedNative,
      dbPath,
    })
    expect(
      resolveNativeSessionForRun({ sessionId: 'sess-resume', dbPath }),
    ).toEqual({
      nativeSessionId: redirectedNative,
      resume: true,
    })

    // Empty/whitespace ids are ignored instead of corrupting the stored id.
    recordNativeSessionId({
      sessionId: 'sess-resume',
      nativeSessionId: '   ',
      dbPath,
    })
    expect(
      resolveNativeSessionForRun({ sessionId: 'sess-resume', dbPath }),
    ).toEqual({
      nativeSessionId: redirectedNative,
      resume: true,
    })
  })
})
