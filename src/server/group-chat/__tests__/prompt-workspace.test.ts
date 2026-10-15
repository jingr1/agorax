/** @vitest-environment node */
import { describe, expect, it } from 'vitest'
import {
  buildGroupChatTurnPrompt,
  buildTurnContext,
} from '../prompt-builder'
import type { GroupMember, RoomMessage } from '../types'

function member(id: string): GroupMember {
  return {
    id: `${id}-row`,
    kind: 'agent',
    participantId: id,
    displayName: id,
    name: id,
    mentionName: id,
    runtime: 'hermes',
    isBot: true,
    profile: id,
  }
}

describe('prompt-builder workspace injection', () => {
  it('adds Room workspace rule when path is set', () => {
    const prompt = buildGroupChatTurnPrompt({
      groupName: 'Room',
      members: [member('a'), member('b')],
      viewer: member('a'),
      deltaLines: ['user: hi'],
      workspacePath: '/tmp/project',
    })
    expect(prompt).toContain('Room workspace: /tmp/project')
  })

  it('omits workspace rule when path is null', () => {
    const prompt = buildGroupChatTurnPrompt({
      groupName: 'Room',
      members: [member('a')],
      viewer: member('a'),
      deltaLines: ['user: hi'],
      workspacePath: null,
    })
    expect(prompt).not.toContain('Room workspace:')
  })

  it('buildTurnContext forwards workspacePath', () => {
    const messages: Array<RoomMessage> = [
      {
        id: 'm1',
        roomId: 'r',
        senderKind: 'human',
        senderParticipantId: 'user',
        senderName: 'user',
        content: 'hello',
        mentions: [],
        mentionDepth: 0,
        autoHandoff: false,
        taskRefs: [],
        answersPendingTurnId: null,
        runId: null,
        taskId: null,
        createdAt: 1,
      },
    ]
    const prompt = buildTurnContext(
      'Room',
      [member('a')],
      member('a'),
      messages,
      null,
      '/ws',
    )
    expect(prompt).toContain('Room workspace: /ws')
  })

  it('states agent_id and forbids claiming others quota as own status', () => {
    const prompt = buildGroupChatTurnPrompt({
      groupName: 'Room',
      members: [member('kimi-impl'), member('orchestrator')],
      viewer: member('kimi-impl'),
      deltaLines: ['user: hi'],
    })
    expect(prompt).toContain('agent_id=kimi-impl')
    expect(prompt).toMatch(/quota|billing|rate-limit/i)
    expect(prompt).toContain('Kimi-K2.7-Code')
    expect(prompt).toContain('Token-X')
  })

  it('buildTurnContext warns that summary model names are not the viewer', () => {
    const prompt = buildTurnContext(
      'Room',
      [member('kimi-impl')],
      member('kimi-impl'),
      [],
      '- Kimi-K2.7-Code: Token-X quota exhausted',
      null,
    )
    expect(prompt).toContain('Earlier conversation summary')
    expect(prompt).toMatch(/not you/i)
    expect(prompt).toContain('Kimi-K2.7-Code: Token-X quota exhausted')
    expect(prompt).toContain('agent_id=kimi-impl')
  })
})
