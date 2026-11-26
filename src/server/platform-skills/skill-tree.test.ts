import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  hashSkillTree,
  normalizeSkillFilePath,
  readSkillTree,
  writeSkillTree,
} from './skill-tree'

const roots: Array<string> = []
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true })
})

describe('portable skill package', () => {
  it('rejects invalid binary encodings and file/directory collisions', () => {
    expect(() => hashSkillTree({ content: '', files: [{ path: 'image.png', content: 'not base64!', encoding: 'base64' }] })).toThrow(/base64/)
    expect(() => hashSkillTree({ content: '', files: [{ path: 'scripts', content: '' }, { path: 'scripts/run.sh', content: 'echo hello' }] })).toThrow(/directory/)
  })

  it.each([
    '../outside',
    '/absolute',
    'C:\\outside',
    '\\\\server\\share',
    'a/../b',
    'CON.txt',
    'references/file.',
    'references/file ',
    '.agorax-platform-skill',
  ])('refuses unsafe or nonportable paths: %s', (relative) => {
    expect(() => normalizeSkillFilePath(relative)).toThrow(
      /Invalid skill file path/,
    )
  })

  it('round-trips full package bytes and executable files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-tree-'))
    roots.push(root)
    const tree = {
      content: '# Skill\r\n',
      files: [
        {
          path: 'assets/image.png',
          content: 'AP+A',
          encoding: 'base64' as const,
        },
        {
          path: 'scripts/run.sh',
          content: 'echo hello',
          executable: process.platform !== 'win32',
        },
      ],
    }
    writeSkillTree(path.join(root, 'skill'), 'skill-id', tree)
    expect(hashSkillTree(readSkillTree(path.join(root, 'skill')))).toBe(
      hashSkillTree(tree),
    )
  })

  it('honors .agorax-skill-ignore for fixed codegen trees', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-tree-'))
    roots.push(root)
    const skillDir = path.join(root, 'skill')
    fs.mkdirSync(path.join(skillDir, 'references', 'generated', 'sql'), {
      recursive: true,
    })
    fs.mkdirSync(path.join(skillDir, 'references', 'workflows'), {
      recursive: true,
    })
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Skill\n')
    fs.writeFileSync(
      path.join(skillDir, '.agorax-skill-ignore'),
      'references/generated/**\n',
    )
    fs.writeFileSync(
      path.join(skillDir, 'references', 'generated', 'sql', 'q.sql'),
      'SELECT 1;\n',
    )
    fs.writeFileSync(
      path.join(skillDir, 'references', 'workflows', 'startup.md'),
      '# startup\n',
    )
    const tree = readSkillTree(skillDir)
    expect(tree.files?.map((file) => file.path)).toEqual([
      'references/workflows/startup.md',
    ])
    expect(fs.existsSync(path.join(skillDir, 'references', 'generated', 'sql', 'q.sql'))).toBe(
      true,
    )
  })

  it('ignores node_modules and other junk dirs when reading or hashing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-tree-'))
    roots.push(root)
    const skillDir = path.join(root, 'skill')
    fs.mkdirSync(path.join(skillDir, 'node_modules', '.bin'), {
      recursive: true,
    })
    fs.mkdirSync(path.join(skillDir, 'node_modules', 'playwright'), {
      recursive: true,
    })
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Skill\n')
    fs.writeFileSync(path.join(skillDir, 'run.js'), 'console.log(1)\n')
    fs.writeFileSync(
      path.join(skillDir, 'node_modules', 'playwright', 'index.js'),
      'module.exports = {}\n',
    )
    fs.symlinkSync(
      '../playwright/cli.js',
      path.join(skillDir, 'node_modules', '.bin', 'playwright'),
    )
    const tree = readSkillTree(skillDir)
    expect(tree.content).toBe('# Skill\n')
    expect(tree.files?.map((file) => file.path)).toEqual(['run.js'])
    expect(
      hashSkillTree({
        content: '# Skill\n',
        files: [
          { path: 'run.js', content: 'console.log(1)\n' },
          {
            path: 'node_modules/playwright/index.js',
            content: 'ignored',
          },
        ],
      }),
    ).toBe(hashSkillTree(tree))
    expect(() => normalizeSkillFilePath('node_modules/x')).toThrow(
      /Invalid skill file path/,
    )
  })

  it('fails fast on category folders without a root SKILL.md', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-tree-'))
    roots.push(root)
    const category = path.join(root, 'github')
    fs.mkdirSync(path.join(category, 'github-pr-workflow'), { recursive: true })
    fs.writeFileSync(
      path.join(category, 'github-pr-workflow', 'SKILL.md'),
      '# nested\n',
    )
    expect(() => readSkillTree(category)).toThrow(/Valid UTF-8 SKILL.md/)
  })

  it('does not confuse path/content boundaries or line endings in hashes', () => {
    expect(
      hashSkillTree({ content: '', files: [{ path: 'ab', content: 'c' }] }),
    ).not.toBe(
      hashSkillTree({ content: '', files: [{ path: 'a', content: 'bc' }] }),
    )
    expect(hashSkillTree({ content: 'a\r\n' })).not.toBe(
      hashSkillTree({ content: 'a\n' }),
    )
  })
})
