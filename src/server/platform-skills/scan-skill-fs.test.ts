import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { iterSkillMdFiles, scanSkillsRoot } from './scan-skill-fs'

const tmpDirs: Array<string> = []

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-scan-'))
  tmpDirs.push(dir)
  return dir
}

describe('scanSkillsRoot', () => {
  it('finds flat, nested, and depth-3 SKILL.md trees (WebUI-style)', () => {
    const root = tmpRoot()
    fs.mkdirSync(path.join(root, 'flat-skill'), { recursive: true })
    fs.writeFileSync(
      path.join(root, 'flat-skill', 'SKILL.md'),
      '---\nname: flat-skill\ndescription: Flat\n---\n\nHi\n',
    )
    fs.mkdirSync(path.join(root, 'productivity', 'xlsx'), { recursive: true })
    fs.writeFileSync(
      path.join(root, 'productivity', 'xlsx', 'SKILL.md'),
      '---\nname: xlsx\ndescription: Sheets\n---\n\nExcel\n',
    )
    fs.mkdirSync(path.join(root, 'mlops', 'research', 'dspy'), {
      recursive: true,
    })
    fs.writeFileSync(
      path.join(root, 'mlops', 'research', 'dspy', 'SKILL.md'),
      '---\nname: dspy\ndescription: DSPy\n---\n\nLoop\n',
    )

    const scanned = scanSkillsRoot(root)
    expect(scanned.map((s) => s.name).sort()).toEqual([
      'dspy',
      'flat-skill',
      'xlsx',
    ])
    expect(scanned.find((s) => s.name === 'dspy')?.category).toBe('Mlops')
    expect(scanned.find((s) => s.name === 'xlsx')?.category).toBe(
      'Productivity',
    )
    expect(iterSkillMdFiles(root)).toHaveLength(3)
  })

  it('does not treat support-dir SKILL.md as a separate skill', () => {
    const root = tmpRoot()
    fs.mkdirSync(path.join(root, 'pack'), { recursive: true })
    fs.writeFileSync(path.join(root, 'pack', 'SKILL.md'), '# pack\n')
    fs.mkdirSync(path.join(root, 'pack', 'references', 'nested'), {
      recursive: true,
    })
    fs.writeFileSync(
      path.join(root, 'pack', 'references', 'nested', 'SKILL.md'),
      '# nested archive\n',
    )
    expect(scanSkillsRoot(root).map((s) => s.name)).toEqual(['pack'])
  })

  it('skips platform-managed trees when asked', () => {
    const root = tmpRoot()
    fs.mkdirSync(path.join(root, 'managed'), { recursive: true })
    fs.writeFileSync(path.join(root, 'managed', 'SKILL.md'), '# managed\n')
    fs.writeFileSync(path.join(root, 'managed', '.agorax-platform-skill'), '1\n')

    expect(scanSkillsRoot(root, { skipPlatformManaged: true })).toHaveLength(0)
    expect(scanSkillsRoot(root)).toHaveLength(1)
  })

  it('descends into .system (Codex bundled skills)', () => {
    const root = tmpRoot()
    fs.mkdirSync(path.join(root, '.system', 'review-agent'), {
      recursive: true,
    })
    fs.writeFileSync(
      path.join(root, '.system', 'review-agent', 'SKILL.md'),
      '---\nname: review-agent\ndescription: Review\n---\n\nOk\n',
    )
    const scanned = scanSkillsRoot(root)
    expect(scanned.map((s) => s.name)).toEqual(['review-agent'])
    expect(scanned[0]?.category).toBe('System')
  })
})
