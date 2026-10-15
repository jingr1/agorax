import { describe, expect, it } from 'vitest'
import {
  extractLeadingSkillTriggers,
  formatSkillBundleForPrompt,
  rewritePromptContentText,
} from './prompt-inject'

describe('platform-skills prompt-inject', () => {
  it('extracts leading skill triggers', () => {
    const result = extractLeadingSkillTriggers(
      '/reviewer /deploy please check this',
    )
    expect(result.skillNames).toEqual(['reviewer', 'deploy'])
    expect(result.remainder).toBe('please check this')
  })

  it('ignores UI slash commands', () => {
    const result = extractLeadingSkillTriggers('/new session')
    expect(result.skillNames).toEqual([])
    expect(result.remainder).toBe('/new session')
  })

  it('formats skill bundles', () => {
    const text = formatSkillBundleForPrompt([
      {
        id: '1',
        name: 'reviewer',
        description: 'Review code',
        content: 'Be careful.',
        origin: { kind: 'manual' },
        createdAt: 0,
        updatedAt: 0,
      },
    ])
    expect(text).toContain('## Skill: reviewer')
    expect(text).toContain('Be careful.')
  })

  it('formats catalog bundles without full bodies', () => {
    const text = formatSkillBundleForPrompt(
      [
        {
          id: '1',
          name: 'reviewer',
          description: 'Review code',
          content: 'Be careful. ' + 'x'.repeat(10_000),
          origin: { kind: 'manual' },
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      { detail: 'catalog' },
    )
    expect(text).toContain('## Skill: reviewer')
    expect(text).toContain('/reviewer')
    expect(text).not.toContain('Be careful.')
    expect(text.length).toBeLessThan(500)
  })

  it('rewrites the first text block and keeps attachments', () => {
    const rewritten = rewritePromptContentText(
      [
        { type: 'text', text: '你好' },
        { type: 'image', name: 'a.png' },
      ],
      '<!-- skills -->\n\n你好',
    )
    expect(rewritten).toEqual([
      { type: 'text', text: '<!-- skills -->\n\n你好' },
      { type: 'image', name: 'a.png' },
    ])
  })
})
