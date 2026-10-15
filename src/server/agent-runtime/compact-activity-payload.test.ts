import { describe, expect, it } from 'vitest'
import {
  compactDaemonActivityForClient,
  compactDaemonMessageForClient,
  stripAgoraxPlatformSkillBlocks,
} from './compact-activity-payload'

describe('compact-activity-payload', () => {
  it('strips platform skill injection blocks', () => {
    const text = [
      '<workspace_context active="true" name="x" path="/x" />',
      '<!-- agorax-platform-skills -->',
      '## Skill: huge\n' + 'x'.repeat(1000),
      '<!-- /agorax-platform-skills -->',
      'hello',
    ].join('\n\n')
    expect(stripAgoraxPlatformSkillBlocks(text)).toContain('hello')
    expect(stripAgoraxPlatformSkillBlocks(text)).not.toContain('agorax-platform-skills')
    expect(stripAgoraxPlatformSkillBlocks(text).length).toBeLessThan(200)
  })

  it('prefers displayPrompt over injected content on the wire', () => {
    const compacted = compactDaemonMessageForClient({
      ID: '1',
      Payload: {
        displayPrompt: '你好',
        content: [
          {
            type: 'text',
            text:
              '<!-- agorax-platform-skills -->\n' +
              'x'.repeat(50_000) +
              '\n<!-- /agorax-platform-skills -->\n\n你好',
          },
        ],
        text:
          '<!-- agorax-platform-skills -->\n' +
          'x'.repeat(50_000) +
          '\n<!-- /agorax-platform-skills -->\n\n你好',
      },
    })
    const payload = (compacted as { Payload: Record<string, unknown> }).Payload
    expect(payload.displayPrompt).toBe('你好')
    expect(payload.text).toBe('你好')
    expect(JSON.stringify(payload.content)).toContain('你好')
    expect(JSON.stringify(payload.content).length).toBeLessThan(200)
  })

  it('compacts activity message arrays', () => {
    const activity = compactDaemonActivityForClient({
      workspaceId: 'ws',
      messages: [
        {
          Payload: {
            displayPrompt: 'hi',
            content: [{ type: 'text', text: '<!-- agorax-platform-skills -->\nBIG\n<!-- /agorax-platform-skills -->\nhi' }],
          },
        },
      ],
    })
    const messages = activity.messages as Array<{ Payload: { text?: string; content: unknown } }>
    expect(JSON.stringify(messages[0]?.Payload.content)).toContain('hi')
    expect(JSON.stringify(messages[0]?.Payload.content)).not.toContain('BIG')
  })
})
