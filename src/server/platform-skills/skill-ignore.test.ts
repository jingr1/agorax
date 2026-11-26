import { describe, expect, it } from 'vitest'
import {
  isIgnoredSkillRelativePath,
  SKILL_IGNORE_FILE,
} from './skill-ignore'

describe('skill-ignore', () => {
  it('always ignores the ignore file itself', () => {
    expect(isIgnoredSkillRelativePath(SKILL_IGNORE_FILE, [])).toBe(true)
  })

  it('matches directory trees via path and path/**', () => {
    const patterns = ['references/generated/**']
    expect(
      isIgnoredSkillRelativePath('references/generated', patterns),
    ).toBe(true)
    expect(
      isIgnoredSkillRelativePath(
        'references/generated/sql/startup.sql',
        patterns,
      ),
    ).toBe(true)
    expect(isIgnoredSkillRelativePath('references/workflows/x.md', patterns)).toBe(
      false,
    )
    expect(isIgnoredSkillRelativePath('SKILL.md', patterns)).toBe(false)
  })

  it('supports simple * / ** globs', () => {
    expect(
      isIgnoredSkillRelativePath('references/generated/a.sql', [
        'references/*/a.sql',
      ]),
    ).toBe(true)
    expect(
      isIgnoredSkillRelativePath('a/b/c.json', ['**/c.json']),
    ).toBe(true)
  })
})
