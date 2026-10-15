import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  allPersonalManagedSkillRoots,
  personalManagedSkillRoots,
  projectManagedSkillRoots,
} from './managed-skill-roots'

const tmpDirs: Array<string> = []

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('managed-skill-roots', () => {
  it('returns existing personal roots for codex including .system', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-home-'))
    tmpDirs.push(home)
    const skills = path.join(home, '.codex', 'skills')
    const system = path.join(skills, '.system')
    const agents = path.join(home, '.agents', 'skills')
    fs.mkdirSync(system, { recursive: true })
    fs.mkdirSync(agents, { recursive: true })

    const roots = personalManagedSkillRoots('codex', home)
    expect(roots).toEqual(
      expect.arrayContaining([skills, system, agents]),
    )
  })

  it('returns cursor personal roots when present', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-home-'))
    tmpDirs.push(home)
    const cursor = path.join(home, '.cursor', 'skills')
    fs.mkdirSync(cursor, { recursive: true })
    expect(personalManagedSkillRoots('cursor', home)).toEqual([cursor])
  })

  it('dedupes across runtimes in allPersonalManagedSkillRoots', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-home-'))
    tmpDirs.push(home)
    const shared = path.join(home, '.agents', 'skills')
    fs.mkdirSync(shared, { recursive: true })
    const all = allPersonalManagedSkillRoots(home)
    expect(all.filter((r) => path.resolve(r) === path.resolve(shared))).toHaveLength(
      1,
    )
  })

  it('lists project-scoped managed skill dirs', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-repo-'))
    tmpDirs.push(repo)
    const claude = path.join(repo, '.claude', 'skills')
    fs.mkdirSync(claude, { recursive: true })
    expect(projectManagedSkillRoots(repo)).toEqual([claude])
  })
})
