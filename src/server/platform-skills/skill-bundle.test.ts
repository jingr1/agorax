import { describe, expect, it } from 'vitest'
import { normalizeSkillBundle, parseSkillFrontmatter } from './skill-bundle'

describe('parseSkillFrontmatter', () => {
  it('reads name and description from YAML frontmatter', () => {
    const content = `---
name: review-helper
description: "Review PRs carefully"
---

# Body
`
    expect(parseSkillFrontmatter(content)).toEqual({
      name: 'review-helper',
      description: 'Review PRs carefully',
    })
  })
})

describe('normalizeSkillBundle', () => {
  it('picks nested SKILL.md root and supporting files', () => {
    const bundle = normalizeSkillBundle([
      {
        path: 'wrapper/SKILL.md',
        content: `---
name: nested-skill
description: Nested
---

Do things.
`,
      },
      { path: 'wrapper/notes.md', content: 'notes' },
      { path: 'other/ignore.md', content: 'nope' },
    ])
    expect(bundle.name).toBe('nested-skill')
    expect(bundle.description).toBe('Nested')
    expect(bundle.files).toEqual([{ path: 'notes.md', content: 'notes' }])
  })

  it('rejects archives without SKILL.md', () => {
    expect(() =>
      normalizeSkillBundle([{ path: 'readme.md', content: 'hi' }]),
    ).toThrow(/SKILL\.md/)
  })

  it('preserves scripts, references and binary assets', () => {
    const bundle = normalizeSkillBundle([
      {
        path: 'package/SKILL.md',
        content:
          '---\nname: full\ndescription: >-\n  Multiple\n  lines\n---\nBody',
      },
      { path: 'package/scripts/run.sh', content: 'echo hi', executable: true },
      { path: 'package/references/guide.md', content: '# Guide' },
      { path: 'package/assets/image.png', content: 'AP8A', encoding: 'base64' },
    ])
    expect(bundle.description).toBe('Multiple lines')
    expect(bundle.files).toEqual([
      { path: 'scripts/run.sh', content: 'echo hi', executable: true },
      { path: 'references/guide.md', content: '# Guide' },
      { path: 'assets/image.png', content: 'AP8A', encoding: 'base64' },
    ])
  })

  it('rejects traversal rather than silently dropping files', () => {
    expect(() =>
      normalizeSkillBundle([
        { path: 'SKILL.md', content: '# Skill' },
        { path: '../escape', content: 'bad' },
      ]),
    ).toThrow(/Invalid skill file path/)
  })
})
